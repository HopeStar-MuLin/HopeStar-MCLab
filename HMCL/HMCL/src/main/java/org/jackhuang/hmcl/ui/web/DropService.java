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
import org.jackhuang.hmcl.addon.repository.CurseForgeRemoteAddonRepository;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.HttpRequest;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/// 拖拽安装的「认类型」和「认来源」。
///
/// <p>用户把一个文件拖进窗口，我们能拿到的只有一个绝对路径。要做的判断有两步：
///
/// 1. **这是什么**（模组 / 资源包 / 光影 / 存档 / 整合包）—— 看扩展名和压缩包内部结构；
/// 2. **整合包是哪个项目的**（可选）—— 包里有名字，拿去 Modrinth / CurseForge 搜，
///    找到了就能把官方的图标和简介一起带上，比显示一个本地文件名体面得多。
///
/// <p>这里只做识别，不动文件。真正落盘在 {@link AddonService}。
final class DropService {

    private DropService() {
    }

    private static final String MODRINTH = "https://api.modrinth.com/v2";
    private static final String CF = "https://api.curseforge.com";

    /// 识别结果。`kind` 决定后续调哪个安装通道。
    ///
    /// <p>取值：`mod` / `resourcepack` / `shader` / `world` / `modpack` / `schematic` / `unknown`。
    static JsonObject classify(Path path) {
        JsonObject out = new JsonObject();
        String fileName = path.getFileName() == null ? "" : path.getFileName().toString();
        out.addProperty("file", fileName);
        out.addProperty("path", path.toAbsolutePath().toString());
        out.addProperty("name", stripExtension(fileName));

        try {
            if (Files.isDirectory(path)) {
                return classifyDirectory(path, out);
            }
            if (!Files.isRegularFile(path)) {
                return fail(out, "这个路径不是文件");
            }

            String lower = fileName.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".jar") || lower.endsWith(".jar.disabled")) {
                return classifyJar(path, out);
            }
            if (lower.endsWith(".zip") || lower.endsWith(".mrpack")) {
                return classifyZip(path, out);
            }
            if (lower.endsWith(".schematic") || lower.endsWith(".litematic") || lower.endsWith(".nbt")) {
                out.addProperty("kind", "schematic");
                out.addProperty("detail", "蓝图文件，不能直接装进实例");
                return out;
            }
            return fail(out, "不认识的格式");
        } catch (Throwable t) {
            return fail(out, "识别失败：" + t.getMessage());
        }
    }

    private static JsonObject classifyDirectory(Path dir, JsonObject out) {
        // 存档目录：Minecraft 会在根上放 level.dat
        if (Files.isRegularFile(dir.resolve("level.dat"))) {
            out.addProperty("kind", "world");
            out.addProperty("detail", "存档文件夹");
            return out;
        }
        // 手动打包的整合包解压后的样子
        if (Files.isDirectory(dir.resolve("mods")) || Files.isDirectory(dir.resolve("config"))) {
            out.addProperty("kind", "modpack");
            out.addProperty("detail", "整合包文件夹");
            return out;
        }
        return fail(out, "这个文件夹既不是存档，也不像整合包");
    }

    private static JsonObject classifyJar(Path jar, JsonObject out) {
        JsonObject meta = ModScanService.describe(jar);
        boolean ok = meta.has("ok") && meta.get("ok").getAsBoolean();
        if (!ok) {
            return fail(out, "jar 里没有模组元数据，可能是插件或普通库");
        }
        String id = opt(meta, "id");
        String name = opt(meta, "name");
        String version = opt(meta, "version");
        out.addProperty("kind", "mod");
        out.addProperty("modId", id);
        out.addProperty("name", name.isBlank() ? stripExtension(jar.getFileName().toString()) : name);
        String display = name.isBlank() ? out.get("name").getAsString() : name;
        out.addProperty("detail", version.isBlank() ? display : display + " " + version);
        return out;
    }

    /// 压缩包：直接复用导入服务的探测结果。
    ///
    /// <p>以前这里有一套自己的判定，和「导入 ZIP」两处维护、两处漏判
    /// （比如外面套一层目录的存档包在拖拽里认不出）。现在只有一个判断入口，
    /// 拖拽和菜单导入对同一个文件给出同样的结论。
    private static JsonObject classifyZip(Path zipFile, JsonObject out) {
        JsonObject probe = ArchiveImportService.probe(zipFile);
        String kind = probe.has("kind") ? probe.get("kind").getAsString() : "unknown";
        if ("unknown".equals(kind)) {
            String reason = "压缩包里认不出是什么";
            if (probe.has("errors") && !probe.getAsJsonArray("errors").isEmpty()) {
                reason = probe.getAsJsonArray("errors").get(0).getAsString();
            }
            return fail(out, reason);
        }
        out.addProperty("kind", kind);
        if (probe.has("detail")) {
            out.addProperty("detail", probe.get("detail").getAsString());
        }
        if (probe.has("name")) {
            out.addProperty("name", probe.get("name").getAsString());
        }
        if (probe.has("gameVersion")) {
            out.addProperty("gameVersion", probe.get("gameVersion").getAsString());
        }
        return out;
    }

    /// 所有条目都在同一个顶层目录下时返回那个目录名，否则 null。
    ///
    /// <p>`__MACOSX/`、`.DS_Store` 这类系统垃圾会干扰判断，直接跳过。
    private static String singleTopLevelDir(ZipFile zip) {
        String root = null;
        var entries = zip.entries();
        while (entries.hasMoreElements()) {
            String name = entries.nextElement().getName().replace('\\', '/');
            if (name.isEmpty() || name.endsWith("/")) {
                continue;
            }
            if (name.startsWith("__MACOSX/") || name.startsWith(".")) {
                continue;
            }
            int slash = name.indexOf('/');
            if (slash <= 0) {
                return null;
            }
            String top = name.substring(0, slash);
            if (root == null) {
                root = top;
            } else if (!root.equals(top)) {
                return null;
            }
        }
        return root;
    }

    // ==================== 整合包来源匹配 ====================

    /// 拿整合包的名字去两个平台搜，返回最像的那个项目。
    ///
    /// <p>只用于「锦上添花」：匹配到了就用官方的图标、名字、简介；没匹配到照常安装，
    /// 只是标题用包里的名字、图标用默认图。所以这里所有异常都吞掉。
    static JsonObject matchModpack(Path archive, String fallbackName) {
        JsonObject out = new JsonObject();
        String name = fallbackName == null ? "" : fallbackName.trim();
        try {
            String fromArchive = readModpackName(archive);
            if (!fromArchive.isBlank()) {
                name = fromArchive;
            }
        } catch (Throwable ignored) {
        }
        out.addProperty("query", name);
        if (name.isBlank()) {
            out.addProperty("ok", false);
            return out;
        }

        JsonObject best = null;
        double bestScore = 0;
        String bestSource = "";

        try {
            JsonObject hit = searchModrinth(name);
            if (hit != null) {
                double score = similarity(name, opt(hit, "title"));
                if (score > bestScore) {
                    best = hit;
                    bestScore = score;
                    bestSource = "modrinth";
                }
            }
        } catch (Throwable ignored) {
        }

        try {
            JsonObject hit = searchCurseForge(name);
            if (hit != null) {
                double score = similarity(name, opt(hit, "name"));
                if (score > bestScore) {
                    best = hit;
                    bestScore = score;
                    bestSource = "curseforge";
                }
            }
        } catch (Throwable ignored) {
        }

        // 55 分以下宁可不用：整合包重名很常见（"Better MC" 有十几个变种），
        // 挂错图标比不挂更误导
        if (best == null || bestScore < 55) {
            out.addProperty("ok", false);
            out.addProperty("name", name);
            return out;
        }

        out.addProperty("ok", true);
        out.addProperty("source", bestSource);
        out.addProperty("name", opt(best, "title"));
        out.addProperty("description", opt(best, "description"));
        out.addProperty("iconUrl", opt(best, "icon"));
        out.addProperty("slug", opt(best, "slug"));
        out.addProperty("score", (int) bestScore);
        out.addProperty("downloads", best.has("downloads") ? best.get("downloads").getAsLong() : 0);
        return out;
    }

    private static JsonObject searchModrinth(String query) throws Exception {
        String url = MODRINTH + "/search?query=" + enc(query)
                + "&facets=" + enc("[[\"project_type:modpack\"]]")
                + "&limit=8&index=relevance";
        JsonObject root = HttpRequest.GET(url).getJson(JsonObject.class);
        JsonArray hits = root.has("hits") && root.get("hits").isJsonArray()
                ? root.getAsJsonArray("hits") : new JsonArray();
        for (JsonElement e : hits) {
            if (!e.isJsonObject()) {
                continue;
            }
            JsonObject h = e.getAsJsonObject();
            JsonObject o = new JsonObject();
            o.addProperty("title", opt(h, "title"));
            o.addProperty("description", opt(h, "description"));
            o.addProperty("icon", opt(h, "icon_url"));
            o.addProperty("slug", opt(h, "slug"));
            o.addProperty("downloads", h.has("downloads") ? h.get("downloads").getAsLong() : 0L);
            return o;
        }
        return null;
    }

    /// CurseForge 的模组搜索：classId=4471 是整合包。
    private static JsonObject searchCurseForge(String query) throws Exception {
        String key = CurseForgeRemoteAddonRepository.API_KEY;
        if (key == null || key.isBlank()) {
            return null;
        }
        String url = CF + "/v1/mods/search?gameId=432&classId=4471&pageSize=8&searchFilter=" + enc(query);
        JsonObject root = HttpRequest.GET(url)
                .header("x-api-key", key)
                .header("Accept", "application/json")
                .getJson(JsonObject.class);
        JsonArray data = root.has("data") && root.get("data").isJsonArray()
                ? root.getAsJsonArray("data") : new JsonArray();
        for (JsonElement e : data) {
            if (!e.isJsonObject()) {
                continue;
            }
            JsonObject m = e.getAsJsonObject();
            JsonObject o = new JsonObject();
            o.addProperty("title", opt(m, "name"));
            o.addProperty("description", opt(m, "summary"));
            o.addProperty("icon", cfLogo(m));
            o.addProperty("slug", String.valueOf(m.has("id") ? m.get("id").getAsInt() : 0));
            o.addProperty("downloads", m.has("downloadCount") ? m.get("downloadCount").getAsLong() : 0L);
            return o;
        }
        return null;
    }

    private static String cfLogo(JsonObject mod) {
        if (!mod.has("logo") || !mod.get("logo").isJsonObject()) {
            return "";
        }
        return opt(mod.getAsJsonObject("logo"), "thumbnailUrl");
    }

    /// 名称相似度，0–100。
    ///
    /// <p>整合包的标题常带版本号后缀（"Better MC [FORGE] - BMC4"），
    /// 所以先统一小写、去掉括号内容和标点，再比。
    static double similarity(String a, String b) {
        String x = normalize(a);
        String y = normalize(b);
        if (x.isEmpty() || y.isEmpty()) {
            return 0;
        }
        if (x.equals(y)) {
            return 100;
        }
        if (x.contains(y) || y.contains(x)) {
            double ratio = (double) Math.min(x.length(), y.length()) / Math.max(x.length(), y.length());
            return 60 + 30 * ratio;
        }
        // 词集合重叠：Jaccard 系数
        var setX = new java.util.HashSet<>(java.util.Arrays.asList(x.split(" ")));
        var setY = new java.util.HashSet<>(java.util.Arrays.asList(y.split(" ")));
        var inter = new java.util.HashSet<>(setX);
        inter.retainAll(setY);
        var union = new java.util.HashSet<>(setX);
        union.addAll(setY);
        if (union.isEmpty()) {
            return 0;
        }
        return 70.0 * inter.size() / union.size();
    }

    private static String normalize(String s) {
        if (s == null) {
            return "";
        }
        return s.toLowerCase(Locale.ROOT)
                .replaceAll("[\\[（(].*?[\\]）)]", " ")
                .replaceAll("[^a-z0-9\\u4e00-\\u9fa5]+", " ")
                .trim()
                .replaceAll("\\s+", " ");
    }

    // ==================== 压缩包内部元数据 ====================

    /// 整合包自己的名字。三个格式挨个试，都没有就返回空串（调用方退回文件名）。
    static String readModpackName(Path archive) {
        if (archive == null || !Files.isRegularFile(archive)) {
            return "";
        }
        try (ZipFile zip = new ZipFile(archive.toFile())) {
            String name = readModrinthName(zip);
            if (!name.isBlank()) {
                return name;
            }
            name = readCurseForgeName(zip);
            if (!name.isBlank()) {
                return name;
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    private static String readModrinthName(ZipFile zip) {
        try {
            JsonObject root = readJsonEntry(zip, "modrinth.index.json");
            return root == null ? "" : opt(root, "name");
        } catch (Throwable t) {
            return "";
        }
    }

    private static String readCurseForgeName(ZipFile zip) {
        try {
            JsonObject root = readJsonEntry(zip, "manifest.json");
            if (root == null || !root.has("minecraft")) {
                return "";   // 不是 CurseForge 的清单，可能是别的 manifest
            }
            return opt(root, "name");
        } catch (Throwable t) {
            return "";
        }
    }

    private static JsonObject readJsonEntry(ZipFile zip, String name) {
        ZipEntry entry = zip.getEntry(name);
        if (entry == null || entry.getSize() > 4L * 1024 * 1024) {
            return null;
        }
        try (InputStream in = zip.getInputStream(entry)) {
            byte[] data = in.readAllBytes();
            JsonElement root = JsonUtils.GSON.fromJson(new String(data, StandardCharsets.UTF_8), JsonElement.class);
            return root != null && root.isJsonObject() ? root.getAsJsonObject() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    // ==================== 小工具 ====================

    private static boolean hasEntry(ZipFile zip, String name) {
        return zip.getEntry(name) != null;
    }

    private static boolean anyEntryStartsWith(ZipFile zip, String prefix) {
        var entries = zip.entries();
        while (entries.hasMoreElements()) {
            if (entries.nextElement().getName().startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private static JsonObject fail(JsonObject out, String reason) {
        out.addProperty("kind", "unknown");
        out.addProperty("detail", reason);
        return out;
    }

    private static String opt(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return "";
        }
        JsonElement e = obj.get(key);
        return e.isJsonPrimitive() ? e.getAsString() : "";
    }

    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s == null ? "" : s, StandardCharsets.UTF_8);
    }
}
