/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026  huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 从本地压缩包导入内容：实例、存档、资源包、光影、数据包、模组合集。
///
/// <p>探测和导入分开：`probe` 只读条目列表和几个小 json，几百毫秒内给出结论，
/// 前端拿它渲染确认弹窗；用户点「导入」才走 `importArchive` 真正解压。
///
/// <p>整合包（`.mrpack` / CurseForge / MultiMC）不在这里处理 —— 它们有自己的
/// 安装任务链，由 `AddonService.installDroppedModpack` 接管，见 `WebBridge.importArchive`。
///
/// <p>所有失败都返回结构化结果（`errors` / `warnings` / `items`），不抛给前端，
/// 因为用户最需要知道的是「哪个文件为什么没进来」，而不是一句 500。
final class ArchiveImportService {

    /// 实例包里没必要带进来的东西：日志、崩溃报告、导出的备份、缓存。
    /// 这些在导入时直接跳过，不报错 —— 用户手工打包时通常不会清理。
    private static final String[] SKIP_PREFIXES = {
            "logs/", "crash-reports/", "backups/", "downloads/",
            ".hmcl/cache/", ".fabric/processedMods/", "natives-"
    };

    private static final long MAX_JSON_BYTES = 8L * 1024 * 1024;

    private final TaskProgress progress;

    ArchiveImportService(Consumer<String> push) {
        this.progress = new TaskProgress(push);
    }

    // ==================== 探测 ====================

    /// 判断这个压缩包是什么、能不能导入。
    ///
    /// <p>返回字段：`kind` / `ok` / `errors` / `warnings` / `detail` / `bytes` / `entries`，
    /// 以及各类型自己的定位信息（`root`、`instanceId`、`worlds`、`jars`）。
    static JsonObject probe(Path archive) {
        JsonObject out = new JsonObject();
        JsonArray warnings = new JsonArray();
        JsonArray errors = new JsonArray();
        out.add("warnings", warnings);
        out.add("errors", errors);
        out.addProperty("ok", false);
        out.addProperty("kind", "unknown");
        out.addProperty("mode", "none");

        String fileName = archive.getFileName() == null ? "" : archive.getFileName().toString();
        out.addProperty("file", fileName);
        out.addProperty("path", archive.toAbsolutePath().toString());
        out.addProperty("name", stripExtension(fileName));

        if (!Files.isRegularFile(archive)) {
            errors.add("文件不存在，或者选中的不是文件");
            return out;
        }

        long bytes;
        try {
            bytes = Files.size(archive);
        } catch (IOException e) {
            errors.add("读不到文件大小：" + e.getMessage());
            return out;
        }
        out.addProperty("bytes", bytes);

        if (bytes == 0) {
            errors.add("文件是空的（0 字节），可能没下载完");
            return out;
        }
        if (bytes < 22) {
            errors.add("文件太小，不是完整的 ZIP");
            return out;
        }
        if (!hasZipSignature(archive)) {
            errors.add("这不是 ZIP 压缩包 —— 文件头是 "
                    + readMagic(archive) + "，可能是改了扩展名的其它文件");
            return out;
        }

        // Windows 上打的包经常用 GBK 存文件名且不写 UTF-8 标记。
        // 用 UTF-8 打开会在列举条目时抛 IllegalArgumentException，换 GBK 再来一次。
        ZipFile zip = null;
        List<Entry> entries = null;
        try {
            try {
                zip = new ZipFile(archive.toFile(), StandardCharsets.UTF_8);
                entries = listEntries(zip);
            } catch (IllegalArgumentException encodingIssue) {
                closeQuietly(zip);
                zip = new ZipFile(archive.toFile(), Charset.forName("GBK"));
                entries = listEntries(zip);
                warnings.add("压缩包里的文件名不是 UTF-8 编码，已按 GBK 读取");
            }
        } catch (ZipException e) {
            closeQuietly(zip);
            errors.add("压缩包损坏，读不了条目：" + oneLine(e.getMessage()));
            return out;
        } catch (IOException e) {
            closeQuietly(zip);
            errors.add("打不开压缩包：" + oneLine(e.getMessage()));
            return out;
        }

        try {
            if (entries.isEmpty()) {
                errors.add("压缩包里没有任何文件");
                return out;
            }

            out.addProperty("entries", entries.size());
            long total = 0;
            for (Entry e : entries) {
                if (e.size() > 0) {
                    total += e.size();
                }
            }
            out.addProperty("uncompressedBytes", total);

            // 加密包：能列条目但读不出内容。试读第一个文件的开头即可判断。
            if (isEncrypted(zip, entries)) {
                errors.add("压缩包带密码，导入不了。请先解压再用「导入游戏目录」");
                return out;
            }

            classify(zip, entries, out, warnings, errors);

            JsonArray errs = out.getAsJsonArray("errors");
            out.addProperty("ok", errs.isEmpty() && !"unknown".equals(out.get("kind").getAsString()));
            return out;
        } finally {
            closeQuietly(zip);
        }
    }

    /// 按「最明确的信号优先」判定类型。
    ///
    /// <p>顺序：整合包清单 → 实例版本 json → 存档 → 数据包/资源包 → 光影 → 一堆 jar。
    /// 反过来会把「带 config 的资源包」误判成整合包，或者把整合包里的
    /// `overrides/pack.mcmeta` 当成资源包。
    private static void classify(ZipFile zip, List<Entry> entries, JsonObject out,
                                 JsonArray warnings, JsonArray errors) {
        // 1. 平台整合包：清单文件是硬标志，解析失败说明包本身就坏了
        if (has(entries, "modrinth.index.json")) {
            JsonObject index = readJson(zip, "modrinth.index.json");
            if (index == null) {
                errors.add("modrinth.index.json 解析失败，压缩包可能不完整");
                return;
            }
            String name = optString(index, "name");
            if (!name.isBlank()) {
                out.addProperty("name", name);
            }
            String version = optString(index, "versionId");
            out.addProperty("kind", "modpack");
            out.addProperty("mode", "install-modpack");
            out.addProperty("detail", "Modrinth 整合包"
                    + (version.isBlank() ? "" : " · " + version));
            JsonObject deps = index.has("dependencies") && index.get("dependencies").isJsonObject()
                    ? index.getAsJsonObject("dependencies") : null;
            if (deps != null) {
                String mc = optString(deps, "minecraft");
                if (!mc.isBlank()) {
                    out.addProperty("gameVersion", mc);
                }
            }
            int files = index.has("files") && index.get("files").isJsonArray()
                    ? index.getAsJsonArray("files").size() : 0;
            out.addProperty("modFiles", files);
            return;
        }

        if (has(entries, "manifest.json")) {
            JsonObject manifest = readJson(zip, "manifest.json");
            if (manifest != null && manifest.has("minecraft")) {
                JsonObject mc = manifest.getAsJsonObject("minecraft");
                String version = optString(mc, "version");
                out.addProperty("kind", "modpack");
                out.addProperty("mode", "install-modpack");
                out.addProperty("detail", "CurseForge 整合包"
                        + (version.isBlank() ? "" : " · " + version));
                String name = optString(manifest, "name");
                if (!name.isBlank()) {
                    out.addProperty("name", name);
                }
                if (!version.isBlank()) {
                    out.addProperty("gameVersion", version);
                }
                return;
            }
            // manifest.json 存在但不像 CurseForge 的：继续往下猜，
            // 但留一条警告，免得用户以为我们没看见
            warnings.add("压缩包里的 manifest.json 不是 CurseForge 格式，已按内容重新判断");
        }

        if (has(entries, "mmc-pack.json")) {
            out.addProperty("kind", "modpack");
            out.addProperty("mode", "install-modpack");
            out.addProperty("detail", "MultiMC / Prism 风格的整合包");
            return;
        }

        // 2. 实例包：三种布局都认
        InstanceCandidate instance = findInstance(zip, entries);
        if (instance != null) {
            out.addProperty("kind", "instance");
            out.addProperty("mode", "create-instance");
            out.addProperty("root", instance.root());
            out.addProperty("instanceId", instance.id());
            out.addProperty("name", instance.name());
            out.addProperty("gameVersion", instance.gameVersion());
            if (!instance.loader().isBlank()) {
                out.addProperty("loader", instance.loader());
            }
            if (!instance.loaderVersion().isBlank()) {
                out.addProperty("loaderVersion", instance.loaderVersion());
            }
            out.addProperty("hasJar", instance.hasJar());

            StringBuilder detail = new StringBuilder();
            if (!instance.loader().isBlank()) {
                detail.append(capitalize(instance.loader())).append(' ');
            }
            detail.append(instance.gameVersion().isBlank() ? "未知版本" : instance.gameVersion());
            detail.append(" · ").append(instance.files()).append(" 个文件");
            out.addProperty("detail", detail.toString());
            out.addProperty("instanceFiles", instance.files());

            if (!instance.hasJar()) {
                warnings.add("包里没有客户端 jar（" + instance.id() + ".jar）。"
                        + "导入后可以用「管理 → 检查游戏完整性」补上");
            }
            return;
        }

        // 3. 存档：一个包里可能有多个（整份 saves 目录打包）
        List<WorldCandidate> worlds = findWorlds(entries);
        if (!worlds.isEmpty()) {
            out.addProperty("kind", "world");
            out.addProperty("mode", "into-instance");
            JsonArray arr = new JsonArray();
            for (WorldCandidate w : worlds) {
                JsonObject o = new JsonObject();
                o.addProperty("root", w.root());
                o.addProperty("name", w.name());
                arr.add(o);
            }
            out.add("worlds", arr);
            out.addProperty("name", worlds.get(0).name());
            out.addProperty("detail", worlds.size() == 1
                    ? "存档 · " + worlds.get(0).name()
                    : "存档 · 共 " + worlds.size() + " 个");
            if (worlds.size() > 1) {
                warnings.add("压缩包里有 " + worlds.size() + " 个存档，会全部导入");
            }
            return;
        }

        // 4. 数据包 / 资源包：都靠 pack.mcmeta，区别在内容目录
        Entry meta = findBySuffix(entries, "pack.mcmeta");
        if (meta != null) {
            String root = parentOf(meta.name());
            boolean hasData = anyStartsWith(entries, root + "data/");
            boolean hasAssets = anyStartsWith(entries, root + "assets/");
            out.addProperty("root", root);
            if (hasData && !hasAssets) {
                out.addProperty("kind", "datapack");
                out.addProperty("mode", "into-instance");
                out.addProperty("detail", "数据包（data/）");
                warnings.add("数据包要放进某个存档的 datapacks 目录才生效，这里先放到实例的 datapacks/");
            } else {
                out.addProperty("kind", "resourcepack");
                out.addProperty("mode", "into-instance");
                String desc = readPackDescription(zip, meta.name());
                out.addProperty("detail", desc.isBlank() ? "资源包" : "资源包 · " + desc);
            }
            return;
        }

        // 5. 光影
        String shaderRoot = findDir(entries, "shaders/");
        if (shaderRoot != null) {
            out.addProperty("kind", "shader");
            out.addProperty("mode", "into-instance");
            out.addProperty("root", shaderRoot);
            out.addProperty("detail", "光影包");
            return;
        }

        // 6. 一堆 jar：模组合集。真正能不能装，导入时逐个验
        List<String> jars = new ArrayList<>();
        for (Entry e : entries) {
            if (!e.directory() && e.name().toLowerCase(Locale.ROOT).endsWith(".jar")) {
                jars.add(e.name());
            }
        }
        if (!jars.isEmpty()) {
            out.addProperty("kind", "mod_bundle");
            out.addProperty("mode", "into-instance");
            out.addProperty("jars", jars.size());
            out.addProperty("detail", "模组合集 · " + jars.size() + " 个 jar");
            return;
        }

        // 7. 只剩「mods/ 或 config/」的启发式：手动打的整合包
        if (anyStartsWith(entries, "mods/") || anyStartsWith(entries, "config/")) {
            out.addProperty("kind", "modpack");
            out.addProperty("mode", "install-modpack");
            out.addProperty("detail", "手动打包的整合包（没有清单文件）");
            warnings.add("没有找到整合包清单，会按 .minecraft 目录结构安装");
            return;
        }

        out.addProperty("kind", "unknown");
        errors.add("认不出这个压缩包里是什么。顶层内容是："
                + describeTopLevel(entries));
    }

    // ==================== 实例探测 ====================

    private record Entry(String name, long size, boolean directory) {
    }

    private record InstanceCandidate(String root, String id, String name, String gameVersion,
                                     String loader, String loaderVersion, String inheritsFrom,
                                     boolean hasJar, int files) {
    }

    private record WorldCandidate(String root, String name) {
    }

    /// 找版本 json。四种布局都来自真实用户包：
    /// 1. `MyPack/versions/1.21.1/1.21.1.json` —— 打包了整个 .minecraft
    /// 2. `MyInst/MyInst.json` + `MyInst.jar` —— 打包了实例目录的上一层
    /// 3. `MyInst/1.21.1.json` —— 实例目录被改过名，里面还是原名
    /// 4. `1.21.1.json` + `1.21.1.jar` —— 我们自己「导出实例为 ZIP」的格式
    private static InstanceCandidate findInstance(ZipFile zip, List<Entry> entries) {
        // 1) versions/<id>/<id>.json
        for (Entry e : entries) {
            String name = e.name();
            if (e.directory() || !name.endsWith(".json")) {
                continue;
            }
            String[] parts = name.split("/");
            if (parts.length >= 3
                    && "versions".equals(parts[parts.length - 3])
                    && parts[parts.length - 1].equals(parts[parts.length - 2] + ".json")) {
                String id = parts[parts.length - 2];
                String prefix = name.substring(0,
                        name.length() - (id + "/" + id + ".json").length()) + id + "/";
                InstanceCandidate c = buildCandidate(zip, entries, prefix, name);
                if (c != null) {
                    return c;
                }
            }
        }

        // 2) <wrap>/<id>/<id>.json
        for (Entry e : entries) {
            String name = e.name();
            if (e.directory() || !name.endsWith(".json")) {
                continue;
            }
            String[] parts = name.split("/");
            if (parts.length >= 2
                    && parts[parts.length - 1].equals(parts[parts.length - 2] + ".json")) {
                String id = parts[parts.length - 2];
                String prefix = name.substring(0,
                        name.length() - (id + "/" + id + ".json").length()) + id + "/";
                InstanceCandidate c = buildCandidate(zip, entries, prefix, name);
                if (c != null) {
                    return c;
                }
            }
        }

        // 3) <dir>/<任意>.json：目录被改名，里面还是原文件名。
        //    只认单层目录，且必须是版本 json —— 实例根上常一起放着
        //    usercache.json / options.json，不能因为「目录里有别的 json」就放弃。
        for (Entry e : entries) {
            String name = e.name();
            if (e.directory() || !name.endsWith(".json")) {
                continue;
            }
            String[] parts = name.split("/");
            if (parts.length != 2) {
                continue;
            }
            InstanceCandidate c = buildCandidate(zip, entries, parts[0] + "/", name);
            if (c != null) {
                return c;
            }
        }

        // 4) 顶层 <id>.json
        for (Entry e : entries) {
            String name = e.name();
            if (e.directory() || !name.endsWith(".json") || name.contains("/")) {
                continue;
            }
            InstanceCandidate c = buildCandidate(zip, entries, "", name);
            if (c != null) {
                return c;
            }
        }
        return null;
    }

    /// @param prefix 实例目录在压缩包里的前缀（含结尾 `/`，顶层布局是空串）。
    ///               导入时按它剥离，所以这里算错会多套一层目录。
    private static InstanceCandidate buildCandidate(ZipFile zip, List<Entry> entries,
                                                    String prefix, String jsonName) {
        JsonObject json = readJson(zip, jsonName, MAX_JSON_BYTES);
        if (json == null || !looksLikeVersion(json)) {
            return null;
        }

        // 磁盘上的文件名才是真实的实例 id（重命名时按它找 .json / .jar）
        String id = stripExtension(jsonName.substring(jsonName.lastIndexOf('/') + 1));

        int files = 0;
        for (Entry e : entries) {
            if (!e.directory() && e.name().startsWith(prefix)) {
                files++;
            }
        }

        boolean hasJar = false;
        for (Entry e : entries) {
            if (e.name().equals(prefix + id + ".jar")) {
                hasJar = true;
                break;
            }
        }

        String inherits = optString(json, "inheritsFrom");
        String gameVersion = inherits.isBlank() ? id : inherits;
        String[] loader = detectLoader(json);

        String display = optString(json, "name");
        if (display.isBlank() || display.equalsIgnoreCase(id)) {
            display = id;
        }

        return new InstanceCandidate(prefix, id, display, gameVersion,
                loader[0], loader[1], inherits, hasJar, files);
    }

    /// 版本 json 的硬特征。整合包的 manifest.json 没有这两个字段，
    /// 所以不会把「带 versions 目录的整合包」误判成实例。
    private static boolean looksLikeVersion(JsonObject json) {
        if (json.has("mainClass") && json.get("mainClass").isJsonPrimitive()) {
            return true;
        }
        return json.has("inheritsFrom") && json.has("libraries");
    }

    private static String[] detectLoader(JsonObject json) {
        String loader = "";
        String version = "";
        if (!json.has("libraries") || !json.get("libraries").isJsonArray()) {
            return new String[]{"", ""};
        }
        for (JsonElement element : json.getAsJsonArray("libraries")) {
            if (!element.isJsonObject()) {
                continue;
            }
            String name = optString(element.getAsJsonObject(), "name");
            String lower = name.toLowerCase(Locale.ROOT);
            if (lower.contains("net.fabricmc:fabric-loader:")) {
                loader = "fabric";
                version = name.substring(lower.indexOf("fabric-loader:") + "fabric-loader:".length());
            } else if (lower.contains("org.quiltmc:quilt-loader:")) {
                loader = "quilt";
                version = name.substring(lower.indexOf("quilt-loader:") + "quilt-loader:".length());
            } else if (lower.contains("net.neoforged:neoforge:")
                    || lower.contains("net.neoforged.fancymodloader")) {
                if (loader.isBlank()) {
                    loader = "neoforge";
                }
            } else if (lower.contains("net.minecraftforge:forge:")
                    || lower.contains("net.minecraftforge:fmlloader")) {
                if (loader.isBlank()) {
                    loader = "forge";
                }
            }
        }
        if (!version.isBlank()) {
            // 版本字符串里可能带 classifier（`0.20.1+local`），去掉
            int plus = version.indexOf('+');
            if (plus > 0) {
                version = version.substring(0, plus);
            }
        }
        return new String[]{loader, version};
    }

    // ==================== 存档探测 ====================

    private static List<WorldCandidate> findWorlds(List<Entry> entries) {
        Set<String> roots = new LinkedHashSet<>();
        for (Entry e : entries) {
            if (e.directory()) {
                continue;
            }
            if (!e.name().equals("level.dat") && !e.name().endsWith("/level.dat")) {
                continue;
            }
            String parent = parentOf(e.name());
            // 只认浅层：saves/xxx/level.dat 或 xxx/level.dat 或根上的 level.dat。
            // 再深就不是「一个存档」，而是整合包里某个备份目录。
            int depth = parent.isEmpty() ? 0 : parent.split("/").length;
            if (depth <= 2) {
                roots.add(parent);
            }
        }

        List<WorldCandidate> out = new ArrayList<>();
        for (String root : roots) {
            String name;
            if (root.isEmpty()) {
                name = "导入的存档";
            } else {
                String[] parts = root.split("/");
                name = parts[parts.length - 1];
                if ("saves".equals(name) && parts.length >= 2) {
                    name = parts[parts.length - 2];
                }
                if ("saves".equals(parts[parts.length - 1]) && parts.length == 1) {
                    // saves/ 目录本身没有 level.dat，不会走到这里
                    name = "导入的存档";
                }
            }
            // parentOf 已经带结尾斜杠（`新的世界/`），这里再拼一个就成 `新的世界//`，
            // 后面 startsWith 永远不成立，整包一个文件都解不出来 —— 实测踩过。
            out.add(new WorldCandidate(root, name));
        }
        return out;
    }

    // ==================== 导入 ====================

    /// 真正执行导入。调用方负责放到后台线程。
    ///
    /// @param instanceId 目标实例。资源包/光影/数据包/模组必须有；
    ///                   实例和存档不需要（实例会新建，存档放进当前游戏目录的 saves）。
    JsonObject importArchive(Path archive, JsonObject probe, String instanceId) {
        String taskId = "import:" + archive.getFileName();
        JsonObject result = new JsonObject();
        JsonArray warnings = new JsonArray();
        JsonArray errors = new JsonArray();
        JsonArray items = new JsonArray();
        result.add("warnings", warnings);
        result.add("errors", errors);
        result.add("items", items);
        result.addProperty("ok", false);
        result.addProperty("kind", probe.has("kind") ? probe.get("kind").getAsString() : "unknown");
        result.addProperty("file", archive.getFileName() == null ? "" : archive.getFileName().toString());

        long started = System.currentTimeMillis();
        try {
            String kind = result.get("kind").getAsString();
            switch (kind) {
                case "instance" -> importInstance(archive, probe, result, warnings, errors, taskId);
                case "world" -> importWorlds(archive, probe, instanceId, result, warnings, errors, items, taskId);
                case "resourcepack" -> importPack(archive, probe, instanceId, "resourcepacks",
                        "resourcepack", result, warnings, errors, taskId);
                case "shader" -> importPack(archive, probe, instanceId, "shaderpacks",
                        "shader", result, warnings, errors, taskId);
                case "datapack" -> importDatapack(archive, probe, instanceId, result, warnings, errors, taskId);
                case "mod_bundle" -> importModBundle(archive, probe, instanceId, result, warnings, errors, items, taskId);
                // 预检已经说清楚为什么不行（改扩展名的 exe、损坏的 zip、认不出的目录结构），
                // 这里原样带出去，不要换一句更笼统的话
                default -> {
                    if (probe.has("errors") && !probe.getAsJsonArray("errors").isEmpty()) {
                        for (JsonElement e : probe.getAsJsonArray("errors")) {
                            errors.add(e.getAsString());
                        }
                    } else {
                        errors.add("这个压缩包不支持导入：" + kind);
                    }
                }
            }
        } catch (Throwable e) {
            LOG.warning("Failed to import archive " + archive, e);
            errors.add(friendly(e));
        }

        result.addProperty("elapsedMs", System.currentTimeMillis() - started);
        boolean ok = errors.isEmpty();
        result.addProperty("ok", ok);

        // 收尾必须发 done：前端任务条只在 done=true 时把自己摘掉，
        // 少了这句会一直挂着一条 100% 的任务，看着像还在跑。
        progress.stage(taskId,
                ok ? "完成" : "失败：" + errors.get(0).getAsString(),
                true, ok ? null : errors.get(0).getAsString(), ok ? 1 : -1);
        return result;
    }

    /// 实例：解压到 `versions/<新 id>`，再修正 json 里的 id 和 jar 文件名。
    private void importInstance(Path archive, JsonObject probe, JsonObject result,
                                JsonArray warnings, JsonArray errors, String taskId) throws IOException {
        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        if (repository == null) {
            errors.add("没有可用的游戏目录，先在设置里指定一个");
            return;
        }

        String root = optString(probe, "root");
        String oldId = optString(probe, "instanceId");
        String wanted = optString(probe, "name");
        if (wanted.isBlank()) {
            wanted = oldId.isBlank() ? stripExtension(archive.getFileName().toString()) : oldId;
        }

        Path versions = repository.getBaseDirectory().resolve("versions");
        Files.createDirectories(versions);

        String newId = uniqueInstanceId(repository, wanted);
        Path dest = versions.resolve(newId).normalize();
        if (!dest.startsWith(versions)) {
            errors.add("实例名不合法：" + wanted);
            return;
        }

        progress.stage(taskId, "正在解压实例「" + newId + "」…", false, null, 0.05);
        Files.createDirectories(dest);

        int count;
        try {
            count = extract(archive, dest, root, taskId, 0.05, 0.85);
        } catch (IOException e) {
            // 解到一半失败：删掉半成品，否则实例列表里会多一个启动不了的空壳
            deleteQuietly(dest);
            throw e;
        }

        if (count == 0) {
            deleteQuietly(dest);
            errors.add("压缩包里没有解出任何文件（路径前缀是「" + root + "」）");
            return;
        }

        // 目录名即实例 id。json 里的 id 字段虽然多数时候被忽略，
        // 但留着旧值会让「导出后再导入」出现两个同名版本号，还是改掉。
        if (!oldId.equals(newId)) {
            renameInstanceFiles(dest, oldId, newId, warnings);
        }
        rewriteInstanceId(dest.resolve(newId + ".json"), newId);

        try {
            repository.refresh();
        } catch (Throwable e) {
            LOG.warning("Failed to refresh repository after import", e);
        }

        result.addProperty("target", "versions/" + newId);
        result.addProperty("name", newId);
        result.addProperty("imported", count);
        if (!Files.isRegularFile(dest.resolve(newId + ".jar"))) {
            warnings.add("没有客户端 jar，启动前建议先跑一次「检查游戏完整性」");
        }
        progress.stage(taskId, "实例「" + newId + "」已导入（" + count + " 个文件）", false, null, 1);
    }

    private static void renameInstanceFiles(Path dest, String oldId, String newId, JsonArray warnings) {
        try {
            Path json = dest.resolve(oldId + ".json");
            if (Files.isRegularFile(json)) {
                Files.move(json, dest.resolve(newId + ".json"), StandardCopyOption.REPLACE_EXISTING);
            } else {
                warnings.add("没找到版本文件 " + oldId + ".json，实例可能无法启动");
            }
        } catch (IOException e) {
            warnings.add("重命名 " + oldId + ".json 失败：" + oneLine(e.getMessage()));
        }
        try {
            Path jar = dest.resolve(oldId + ".jar");
            if (Files.isRegularFile(jar)) {
                Files.move(jar, dest.resolve(newId + ".jar"), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            warnings.add("重命名 " + oldId + ".jar 失败：" + oneLine(e.getMessage()));
        }
    }

    private static void rewriteInstanceId(Path jsonFile, String id) {
        if (!Files.isRegularFile(jsonFile)) {
            return;
        }
        try {
            String text = Files.readString(jsonFile, StandardCharsets.UTF_8);
            JsonElement parsed = JsonParser.parseString(text);
            if (!parsed.isJsonObject()) {
                return;
            }
            JsonObject json = parsed.getAsJsonObject();
            json.addProperty("id", id);
            Files.writeString(jsonFile, JsonUtils.GSON.toJson(json), StandardCharsets.UTF_8);
        } catch (Exception e) {
            LOG.warning("Failed to rewrite instance id in " + jsonFile, e);
        }
    }

    /// 存档：一个包里可能有多个，逐个解压到 saves/<唯一名>。
    private void importWorlds(Path archive, JsonObject probe, String instanceId, JsonObject result,
                              JsonArray warnings, JsonArray errors, JsonArray items, String taskId) throws IOException {
        Path saves = savesDirectory(instanceId);
        if (saves == null) {
            errors.add("没有可用的游戏目录");
            return;
        }
        Files.createDirectories(saves);

        JsonArray worlds = probe.has("worlds") && probe.get("worlds").isJsonArray()
                ? probe.getAsJsonArray("worlds") : new JsonArray();
        if (worlds.isEmpty()) {
            errors.add("压缩包里没有找到 level.dat，不是有效的存档");
            return;
        }

        JsonArray imported = new JsonArray();
        int totalFiles = 0;
        int index = 0;
        for (JsonElement element : worlds) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject world = element.getAsJsonObject();
            String root = optString(world, "root");
            String base = optString(world, "name");
            String name = uniqueSaveName(saves, base.isBlank() ? "导入的存档" : base);
            Path dest = saves.resolve(name);

            double from = 0.05 + 0.9 * index / worlds.size();
            double to = 0.05 + 0.9 * (index + 1) / worlds.size();
            progress.stage(taskId, "正在解压存档「" + name + "」…", false, null, from);

            try {
                Files.createDirectories(dest);
                int count = extract(archive, dest, root, taskId, from, to);
                if (!Files.isRegularFile(dest.resolve("level.dat"))) {
                    deleteQuietly(dest);
                    JsonObject item = new JsonObject();
                    item.addProperty("file", base);
                    item.addProperty("ok", false);
                    item.addProperty("reason", "解压后没有 level.dat");
                    items.add(item);
                    continue;
                }
                totalFiles += count;
                imported.add(name);

                JsonObject item = new JsonObject();
                item.addProperty("file", base);
                item.addProperty("ok", true);
                item.addProperty("reason", name);
                items.add(item);
            } catch (IOException e) {
                deleteQuietly(dest);
                JsonObject item = new JsonObject();
                item.addProperty("file", base);
                item.addProperty("ok", false);
                item.addProperty("reason", oneLine(e.getMessage()));
                items.add(item);
                warnings.add("存档「" + base + "」导入失败：" + oneLine(e.getMessage()));
            }
            index++;
        }

        result.add("worlds", imported);
        result.addProperty("imported", totalFiles);
        if (imported.isEmpty() && errors.isEmpty()) {
            errors.add("所有存档都解压失败，见下面的明细");
        }
        if (!imported.isEmpty()) {
            result.addProperty("target", "saves/" + imported.get(0).getAsString());
            progress.stage(taskId, "已导入 " + imported.size() + " 个存档", false, null, 1);
        }
    }

    /// 资源包 / 光影：根目录就是包本体时直接复制 zip（游戏支持 zip 形式），
    /// 外面套了一层目录时解压成文件夹。
    private void importPack(Path archive, JsonObject probe, String instanceId, String sub,
                            String kind, JsonObject result, JsonArray warnings, JsonArray errors,
                            String taskId) throws IOException {
        Path dir = instanceDirectory(instanceId, sub);
        if (dir == null) {
            errors.add("先选一个实例，再导入" + ("shader".equals(kind) ? "光影" : "资源包"));
            return;
        }
        Files.createDirectories(dir);

        String root = optString(probe, "root");
        String base = optString(probe, "name");
        if (base.isBlank()) {
            base = stripExtension(archive.getFileName().toString());
        }

        progress.stage(taskId, "正在导入…", false, null, 0.2);
        String target;
        int files;
        if (root.isEmpty()) {
            Path dest = dir.resolve(uniqueFileName(dir, base + ".zip"));
            Files.copy(archive, dest, StandardCopyOption.REPLACE_EXISTING);
            target = sub + "/" + dest.getFileName();
            files = 1;
        } else {
            String name = uniqueDirectoryName(dir, base);
            Path dest = dir.resolve(name);
            try {
                files = extract(archive, dest, root, taskId, 0.2, 0.9);
            } catch (IOException e) {
                deleteQuietly(dest);
                throw e;
            }
            target = sub + "/" + name;
        }

        result.addProperty("target", target);
        result.addProperty("name", base);
        result.addProperty("imported", files);
        if ("datapack".equals(kind)) {
            warnings.add("数据包需要放进存档的 datapacks 目录才会生效");
        }
        progress.stage(taskId, "已导入到 " + target, false, null, 1);
    }

    /// 数据包：没有「全局生效」的位置，先放到实例的 datapacks/，
    /// 同时在结果里说清楚还要往存档里挪。
    private void importDatapack(Path archive, JsonObject probe, String instanceId, JsonObject result,
                                JsonArray warnings, JsonArray errors, String taskId) throws IOException {
        Path dir = instanceDirectory(instanceId, "datapacks");
        if (dir == null) {
            errors.add("数据包要装进某个实例，先选一个实例");
            return;
        }
        Files.createDirectories(dir);

        String root = optString(probe, "root");
        String base = optString(probe, "name");
        if (base.isBlank()) {
            base = stripExtension(archive.getFileName().toString());
        }
        progress.stage(taskId, "正在导入数据包…", false, null, 0.3);

        int files;
        String target;
        if (root.isEmpty()) {
            Path dest = dir.resolve(uniqueFileName(dir, base + ".zip"));
            Files.copy(archive, dest, StandardCopyOption.REPLACE_EXISTING);
            target = "datapacks/" + dest.getFileName();
            files = 1;
        } else {
            String name = uniqueDirectoryName(dir, base);
            Path dest = dir.resolve(name);
            try {
                files = extract(archive, dest, root, taskId, 0.3, 0.9);
            } catch (IOException e) {
                deleteQuietly(dest);
                throw e;
            }
            target = "datapacks/" + name;
            result.addProperty("name", name);
        }

        result.addProperty("target", target);
        result.addProperty("imported", files);
        warnings.add("已放到实例的 datapacks/。要让它在某个世界生效，"
                + "把该文件移到那个存档的 datapacks/ 目录里");
        progress.stage(taskId, "已导入到 " + target, false, null, 1);
    }

    /// 模组合集：逐个 jar 校验，认识模组元数据的才放进 mods。
    ///
    /// <p>先落到临时目录再验，因为 `ModScanService` 要读文件而不是流；
    /// 验不过的当场删掉，不留半成品。
    private void importModBundle(Path archive, JsonObject probe, String instanceId, JsonObject result,
                                 JsonArray warnings, JsonArray errors, JsonArray items, String taskId) throws IOException {
        Path mods = instanceDirectory(instanceId, "mods");
        if (mods == null) {
            errors.add("模组要装进某个实例，先选一个实例");
            return;
        }
        Files.createDirectories(mods);

        List<String> jarNames = new ArrayList<>();
        try (ZipFile zip = openZipForRead(archive)) {
            var enumeration = zip.entries();
            while (enumeration.hasMoreElements()) {
                ZipEntry entry = enumeration.nextElement();
                if (!entry.isDirectory() && entry.getName().toLowerCase(Locale.ROOT).endsWith(".jar")) {
                    jarNames.add(entry.getName());
                }
            }
        }

        if (jarNames.isEmpty()) {
            errors.add("压缩包里没有 .jar 文件");
            return;
        }

        Path temp = Files.createTempDirectory("hmcl-mod-bundle");
        int okCount = 0;
        int skipped = 0;
        try {
            int index = 0;
            for (String jarName : jarNames) {
                index++;
                String shortName = jarName.substring(jarName.lastIndexOf('/') + 1);
                double ratio = 0.05 + 0.85 * index / jarNames.size();
                progress.stage(taskId, "正在检查 " + shortName + "…", false, null, ratio);

                Path tempJar = temp.resolve(shortName);
                try {
                    extractSingle(archive, jarName, tempJar);
                    JsonObject meta = ModScanService.describe(tempJar);
                    boolean valid = meta.has("ok") && meta.get("ok").getAsBoolean();
                    if (!valid) {
                        skipped++;
                        JsonObject item = new JsonObject();
                        item.addProperty("file", shortName);
                        item.addProperty("ok", false);
                        item.addProperty("reason", "不是模组（没有 fabric.mod.json / mods.toml）");
                        items.add(item);
                        continue;
                    }
                    Path dest = mods.resolve(uniqueFileName(mods, shortName));
                    Files.move(tempJar, dest, StandardCopyOption.REPLACE_EXISTING);
                    okCount++;

                    JsonObject item = new JsonObject();
                    item.addProperty("file", shortName);
                    item.addProperty("ok", true);
                    String display = meta.has("name") ? meta.get("name").getAsString() : shortName;
                    item.addProperty("reason", display);
                    items.add(item);
                } catch (Exception e) {
                    skipped++;
                    JsonObject item = new JsonObject();
                    item.addProperty("file", shortName);
                    item.addProperty("ok", false);
                    item.addProperty("reason", friendly(e));
                    items.add(item);
                } finally {
                    deleteQuietly(tempJar);
                }
            }
        } finally {
            deleteQuietly(temp);
        }

        result.addProperty("imported", okCount);
        result.addProperty("skipped", skipped);
        result.addProperty("target", "mods/");
        if (okCount == 0) {
            errors.add("这 " + jarNames.size() + " 个 jar 都不是可用的模组文件");
        } else if (skipped > 0) {
            warnings.add("有 " + skipped + " 个 jar 不是模组，已跳过");
        }
        progress.stage(taskId, "已放入 " + okCount + " 个模组", false, null, 1);
    }

    // ==================== 解压 ====================

    /// 解压 `prefix` 下的条目到 `dest`。
    ///
    /// <p>文件名编码先用 UTF-8，抛 `IllegalArgumentException` 就清空重来换 GBK ——
    /// Windows 自带的「发送到 → 压缩文件夹」就是 GBK 且不写标记。
    private int extract(Path archive, Path dest, String prefix,
                        String taskId, double from, double to) throws IOException {
        try {
            return extractWith(archive, dest, prefix, StandardCharsets.UTF_8, taskId, from, to);
        } catch (IllegalArgumentException e) {
            LOG.info("[import] zip is not UTF-8, retrying with GBK: " + e.getMessage());
            deleteQuietly(dest);
            Files.createDirectories(dest);
            return extractWith(archive, dest, prefix, Charset.forName("GBK"), taskId, from, to);
        }
    }

    private int extractWith(Path archive, Path dest, String prefix, Charset charset,
                            String taskId, double from, double to) throws IOException {
        Path root = dest.toAbsolutePath().normalize();
        int count = 0;
        int lastPercent = -1;
        try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(archive), charset)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName().replace('\\', '/');
                if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) {
                    zis.closeEntry();
                    continue;
                }
                if (prefix != null && !prefix.isEmpty()) {
                    if (!name.startsWith(prefix)) {
                        zis.closeEntry();
                        continue;
                    }
                    name = name.substring(prefix.length());
                }
                if (name.isEmpty()) {
                    zis.closeEntry();
                    continue;
                }
                if (isSkipped(name)) {
                    zis.closeEntry();
                    continue;
                }

                Path target = root.resolve(name).normalize();
                if (!target.startsWith(root)) {
                    throw new IOException("压缩包里有非法路径：" + entry.getName());
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(zis, target, StandardCopyOption.REPLACE_EXISTING);
                    count++;
                    int percent = (int) Math.min(99, 4 + count / 20);
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        double ratio = from + (to - from) * percent / 100.0;
                        progress.stage(taskId, "正在解压… " + count + " 个文件", false, null, ratio);
                    }
                }
                zis.closeEntry();
            }
        }
        return count;
    }

    /// 只取一个条目（模组合集里逐个验证用）。
    private static void extractSingle(Path archive, String entryName, Path target) throws IOException {
        try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(archive), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                if (entry.getName().equals(entryName)) {
                    Files.createDirectories(target.getParent());
                    Files.copy(zis, target, StandardCopyOption.REPLACE_EXISTING);
                    return;
                }
                zis.closeEntry();
            }
        }
        throw new IOException("压缩包里找不到 " + entryName);
    }

    // ==================== 目录与命名 ====================

    private static Path instanceDirectory(String instanceId, String sub) throws IOException {
        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        if (repository == null) {
            return null;
        }
        var instance = instanceId == null || instanceId.isBlank()
                ? repository.getSelectedInstance() : repository.findInstance(new GameInstanceID(instanceId));
        if (instance == null) {
            return null;
        }
        return instance.getRunDirectory().resolve(sub);
    }

    private static Path savesDirectory(String instanceId) throws IOException {
        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        if (repository == null) {
            return null;
        }
        var instance = instanceId == null || instanceId.isBlank()
                ? repository.getSelectedInstance() : repository.findInstance(new GameInstanceID(instanceId));
        if (instance != null) {
            return instance.getRunDirectory().resolve("saves");
        }
        return repository.getBaseDirectory().resolve("saves");
    }

    private static String uniqueInstanceId(HMCLGameRepository repository, String raw) {
        String base = safeName(raw, "导入的实例");
        if (repository.findInstance(new GameInstanceID(base)) == null) {
            return base;
        }
        for (int i = 2; i < 1000; i++) {
            String candidate = base + " (" + i + ")";
            if (repository.findInstance(new GameInstanceID(candidate)) == null) {
                return candidate;
            }
        }
        return base + "-" + System.currentTimeMillis();
    }

    private static String uniqueSaveName(Path saves, String raw) {
        String base = safeName(raw, "导入的存档");
        if (!Files.exists(saves.resolve(base))) {
            return base;
        }
        for (int i = 2; i < 1000; i++) {
            String candidate = base + " (" + i + ")";
            if (!Files.exists(saves.resolve(candidate))) {
                return candidate;
            }
        }
        return base + "-" + System.currentTimeMillis();
    }

    private static String uniqueFileName(Path dir, String raw) {
        String name = safeName(raw, "导入的文件");
        if (!Files.exists(dir.resolve(name))) {
            return name;
        }
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2; i < 1000; i++) {
            String candidate = base + " (" + i + ")" + ext;
            if (!Files.exists(dir.resolve(candidate))) {
                return candidate;
            }
        }
        return base + "-" + System.currentTimeMillis() + ext;
    }

    private static String uniqueDirectoryName(Path dir, String raw) {
        String base = safeName(raw, "导入的内容");
        if (!Files.exists(dir.resolve(base))) {
            return base;
        }
        for (int i = 2; i < 1000; i++) {
            String candidate = base + " (" + i + ")";
            if (!Files.exists(dir.resolve(candidate))) {
                return candidate;
            }
        }
        return base + "-" + System.currentTimeMillis();
    }

    /// 文件/目录名清洗：Windows 不允许 `\ / : * ? " < > |`，
    /// 首尾的空格和点也会被资源管理器吃掉，一并处理。
    private static String safeName(String raw, String fallback) {
        String name = raw == null ? "" : raw;
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").strip();
        while (name.endsWith(".")) {
            name = name.substring(0, name.length() - 1).strip();
        }
        if (name.isEmpty() || ".".equals(name) || "..".equals(name)) {
            name = fallback;
        }
        if (name.length() > 96) {
            int dot = name.lastIndexOf('.');
            String ext = dot > 0 && name.length() - dot <= 8 ? name.substring(dot) : "";
            name = name.substring(0, 96 - ext.length()) + ext;
        }
        return name;
    }

    // ==================== 工具 ====================

    private static List<Entry> listEntries(ZipFile zip) {
        List<Entry> out = new ArrayList<>();
        var enumeration = zip.entries();
        while (enumeration.hasMoreElements()) {
            ZipEntry entry = enumeration.nextElement();
            String name = entry.getName().replace('\\', '/');
            if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) {
                continue;
            }
            out.add(new Entry(name, entry.getSize(), entry.isDirectory()));
        }
        return out;
    }

    private static boolean isEncrypted(ZipFile zip, List<Entry> entries) {
        for (Entry e : entries) {
            if (e.directory() || e.size() == 0) {
                continue;
            }
            ZipEntry entry = zip.getEntry(e.name());
            if (entry == null) {
                continue;
            }
            try (InputStream in = zip.getInputStream(entry)) {
                in.read();
            } catch (ZipException ex) {
                // JDK 对加密条目的提示是 "encrypted ZIP entry not supported"
                if (ex.getMessage() != null
                        && ex.getMessage().toLowerCase(Locale.ROOT).contains("encrypt")) {
                    return true;
                }
                return false;
            } catch (IOException ex) {
                return false;
            }
        }
        return false;
    }

    private static boolean has(List<Entry> entries, String name) {
        for (Entry e : entries) {
            if (e.name().equals(name)) {
                return true;
            }
        }
        return false;
    }

    private static Entry findBySuffix(List<Entry> entries, String suffix) {
        for (Entry e : entries) {
            if (!e.directory() && e.name().endsWith("/" + suffix)) {
                return e;
            }
        }
        for (Entry e : entries) {
            if (!e.directory() && e.name().equals(suffix)) {
                return e;
            }
        }
        return null;
    }

    private static boolean anyStartsWith(List<Entry> entries, String prefix) {
        for (Entry e : entries) {
            if (e.name().startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private static String findDir(List<Entry> entries, String dir) {
        for (Entry e : entries) {
            if (e.name().startsWith(dir)) {
                return "";
            }
            if (e.name().contains("/" + dir)) {
                return e.name().substring(0, e.name().indexOf("/" + dir) + 1);
            }
        }
        return null;
    }

    private static String parentOf(String name) {
        int slash = name.lastIndexOf('/');
        return slash < 0 ? "" : name.substring(0, slash + 1);
    }

    private static JsonObject readJson(ZipFile zip, String name) {
        return readJson(zip, name, MAX_JSON_BYTES);
    }

    private static JsonObject readJson(ZipFile zip, String name, long maxBytes) {
        ZipEntry entry = zip.getEntry(name);
        if (entry == null || entry.isDirectory()) {
            return null;
        }
        try (InputStream in = zip.getInputStream(entry)) {
            byte[] data = in.readNBytes((int) Math.min(maxBytes, Integer.MAX_VALUE));
            String text = new String(data, StandardCharsets.UTF_8);
            // 去掉 BOM：部分编辑器保存的 json 带 BOM，Gson 解析会失败
            if (!text.isEmpty() && text.charAt(0) == '\uFEFF') {
                text = text.substring(1);
            }
            JsonElement parsed = JsonParser.parseString(text);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String readPackDescription(ZipFile zip, String metaName) {
        JsonObject meta = readJson(zip, metaName);
        if (meta == null || !meta.has("pack")) {
            return "";
        }
        return optString(meta.getAsJsonObject("pack"), "description");
    }

    private static String describeTopLevel(List<Entry> entries) {
        Set<String> tops = new LinkedHashSet<>();
        for (Entry e : entries) {
            String name = e.name();
            int slash = name.indexOf('/');
            tops.add(slash > 0 ? name.substring(0, slash) + "/" : name);
            if (tops.size() >= 6) {
                break;
            }
        }
        return String.join("、", tops);
    }

    private static boolean isSkipped(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String prefix : SKIP_PREFIXES) {
            if (lower.startsWith(prefix)) {
                return true;
            }
        }
        return lower.equals("session.lock") || lower.endsWith(".log");
    }

    private static boolean hasZipSignature(Path file) {
        byte[] head = new byte[4];
        try (InputStream in = Files.newInputStream(file)) {
            if (in.read(head) < 4) {
                return false;
            }
        } catch (IOException e) {
            return false;
        }
        // PK\003\004（普通）、PK\005\006（空包）、PK\007\008（分卷）
        return head[0] == 'P' && head[1] == 'K'
                && ((head[2] == 3 && head[3] == 4)
                || (head[2] == 5 && head[3] == 6)
                || (head[2] == 7 && head[3] == 8));
    }

    private static String readMagic(Path file) {
        try (InputStream in = Files.newInputStream(file)) {
            byte[] head = in.readNBytes(8);
            StringBuilder sb = new StringBuilder();
            for (byte b : head) {
                sb.append(String.format("%02X ", b));
            }
            return sb.toString().strip();
        } catch (IOException e) {
            return "（读不出）";
        }
    }

    private static ZipFile openZipForRead(Path archive) throws IOException {
        try {
            return new ZipFile(archive.toFile(), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return new ZipFile(archive.toFile(), Charset.forName("GBK"));
        }
    }

    private static String optString(JsonObject object, String key) {
        if (object == null || !object.has(key) || !object.get(key).isJsonPrimitive()) {
            return "";
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String stripExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    private static String capitalize(String text) {
        if (text.isEmpty()) {
            return text;
        }
        return Character.toUpperCase(text.charAt(0)) + text.substring(1);
    }

    private static String oneLine(String text) {
        if (text == null) {
            return "";
        }
        int newline = text.indexOf('\n');
        return newline > 0 ? text.substring(0, newline).strip() : text.strip();
    }

    /// 把异常翻成用户能懂的一句话。常见的几种专门处理，其余回落到 message。
    private static String friendly(Throwable e) {
        if (e instanceof java.nio.file.AccessDeniedException denied) {
            return "没有权限写入：" + denied.getFile();
        }
        if (e instanceof java.nio.file.NoSuchFileException missing) {
            return "文件不存在：" + missing.getFile();
        }
        if (e instanceof java.util.zip.ZipException) {
            String message = e.getMessage();
            if (message != null && message.toLowerCase(Locale.ROOT).contains("encrypt")) {
                return "压缩包带密码，导入不了";
            }
            return "压缩包损坏：" + oneLine(message);
        }
        String message = e.getMessage();
        if (message == null || message.isBlank()) {
            message = e.getClass().getSimpleName();
        }
        return oneLine(message);
    }

    private static void closeQuietly(ZipFile zip) {
        if (zip != null) {
            try {
                zip.close();
            } catch (IOException ignored) {
                // 关不掉不影响已经读到的内容
            }
        }
    }

    private static void deleteQuietly(Path path) {
        if (path == null) {
            return;
        }
        try {
            if (Files.isDirectory(path)) {
                try (var stream = Files.walk(path)) {
                    for (Path p : stream.sorted(java.util.Comparator.reverseOrder()).toList()) {
                        Files.deleteIfExists(p);
                    }
                }
            } else {
                Files.deleteIfExists(path);
            }
        } catch (IOException ignored) {
            // 删不掉就留着，比抛异常打断整个导入好
        }
    }
}
