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
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 扫实例的 mods 目录，检查「缺前置」和「同一个 mod 装了多份」。
///
/// <p>这两类是模组崩服里最常见、也最容易在启动前就发现的原因。PCL 的 `ModComp`
/// 干的就是这件事：读每个 jar 自带的元数据，把依赖关系拼成一张图，缺的标出来。
///
/// <p>支持的元数据格式按出现频率排：
/// <list>
///   <item>`fabric.mod.json`（Fabric / Quilt）</item>
///   <item>`META-INF/neoforge.mods.toml`、`META-INF/mods.toml`（Forge 1.13+ / NeoForge）</item>
///   <item>`mcmod.info`（Forge 1.12.2 及更早）</item>
/// </list>
/// 读不出来的 jar（资源包、损坏文件）直接跳过，不影响其它模组的判断。
final class ModScanService {

    private ModScanService() {
    }

    /// 这些不是「模组」，不需要在 mods 目录里找：出现就默认满足。
    private static final Set<String> BUILTIN = Set.of(
            "minecraft", "java", "fabricloader", "fabric-loader", "fabric_loader",
            "forge", "neoforge", "quilt_loader", "quiltloader",
            "fabric-api", "fabric_api", "quilted_fabric_api", "quilted-fabric-api",
            "cloth-config2", "cloth_config", "architectury", "architectury-api",
            "mcp", "modlauncher", "mixinextras");

    /// 一个 mod 的元数据。字段全部允许为空——老模组的元数据经常缺东西。
    private record ModMeta(String id, String name, String version, Map<String, String> depends, String file) {
    }

    static String scan(String instanceId) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameInstance instance = GameDirectoryManager.getSelectedRepository()
                    .getInstance(new GameInstanceID(instanceId));
            Path modsDir = instance.getModsDirectory();
            if (!Files.isDirectory(modsDir)) {
                root.addProperty("ok", true);
                root.add("mods", new JsonArray());
                root.add("missing", new JsonArray());
                root.add("duplicates", new JsonArray());
                root.addProperty("hint", "这个实例还没有 mods 目录");
                return JsonUtils.GSON.toJson(root);
            }

            List<ModMeta> mods = new ArrayList<>();
            List<String> unreadable = new ArrayList<>();

            try (DirectoryStream<Path> stream = Files.newDirectoryStream(modsDir, "*.jar")) {
                for (Path jar : stream) {
                    ModMeta meta = readMeta(jar);
                    if (meta == null) {
                        unreadable.add(jar.getFileName().toString());
                    } else {
                        mods.add(meta);
                    }
                }
            }

            // 已装 mod 的 id 集合。大小写不敏感：不同模组写法不统一（JEI / jei）
            Map<String, String> installed = new HashMap<>();
            for (ModMeta m : mods) {
                installed.put(m.id().toLowerCase(Locale.ROOT), m.file());
            }

            JsonArray modsJson = new JsonArray();
            for (ModMeta m : mods) {
                JsonObject o = new JsonObject();
                o.addProperty("id", m.id());
                o.addProperty("name", m.name());
                o.addProperty("version", m.version());
                o.addProperty("file", m.file());
                modsJson.add(o);
            }

            // 缺前置：依赖的 id 不在已装集合里，又不是游戏/加载器自带的
            JsonArray missing = new JsonArray();
            for (ModMeta m : mods) {
                for (Map.Entry<String, String> dep : m.depends().entrySet()) {
                    String depId = dep.getKey();
                    if (depId == null || depId.isBlank()) {
                        continue;
                    }
                    String key = depId.toLowerCase(Locale.ROOT);
                    if (BUILTIN.contains(key) || installed.containsKey(key)) {
                        continue;
                    }
                    JsonObject o = new JsonObject();
                    o.addProperty("mod", m.name() != null && !m.name().isBlank() ? m.name() : m.id());
                    o.addProperty("file", m.file());
                    o.addProperty("needs", depId);
                    o.addProperty("range", dep.getValue() == null ? "" : dep.getValue());
                    missing.add(o);
                }
            }

            // 重复：同一个 modId 出现多份（常见于「更新了但旧 jar 没删」）
            Map<String, List<String>> byId = new LinkedHashMap<>();
            for (ModMeta m : mods) {
                byId.computeIfAbsent(m.id().toLowerCase(Locale.ROOT), k -> new ArrayList<>()).add(m.file());
            }
            JsonArray duplicates = new JsonArray();
            for (Map.Entry<String, List<String>> e : byId.entrySet()) {
                if (e.getValue().size() < 2) {
                    continue;
                }
                JsonObject o = new JsonObject();
                o.addProperty("id", e.getKey());
                JsonArray files = new JsonArray();
                e.getValue().forEach(files::add);
                o.add("files", files);
                duplicates.add(o);
            }

            root.addProperty("ok", true);
            root.addProperty("count", mods.size());
            root.add("mods", modsJson);
            root.add("missing", missing);
            root.add("duplicates", duplicates);
            if (!unreadable.isEmpty()) {
                JsonArray arr = new JsonArray();
                unreadable.forEach(arr::add);
                root.add("unreadable", arr);
            }
            return JsonUtils.GSON.toJson(root);
        } catch (Throwable e) {
            LOG.warning("Failed to scan mods of " + instanceId, e);
            root.addProperty("ok", false);
            root.addProperty("error", String.valueOf(e));
            return JsonUtils.GSON.toJson(root);
        }
    }

    /// 从 jar 里读一份元数据。三种格式挨个试，都读不到就返回 null。
    private static ModMeta readMeta(Path jar) {
        try (java.util.zip.ZipFile zip = new java.util.zip.ZipFile(jar.toFile())) {
            String file = jar.getFileName().toString();

            ModMeta fabric = readFabric(zip, file);
            if (fabric != null) {
                return fabric;
            }
            ModMeta forge = readForgeToml(zip, file);
            if (forge != null) {
                return forge;
            }
            return readMcmodInfo(zip, file);
        } catch (Throwable e) {
            return null;
        }
    }

    private static String readEntry(java.util.zip.ZipFile zip, String name) {
        var entry = zip.getEntry(name);
        if (entry == null) {
            return null;
        }
        try (InputStream in = zip.getInputStream(entry)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Throwable e) {
            return null;
        }
    }

    private static ModMeta readFabric(java.util.zip.ZipFile zip, String file) {
        String raw = readEntry(zip, "fabric.mod.json");
        if (raw == null) {
            return null;
        }
        try {
            JsonObject o = JsonParser.parseString(raw).getAsJsonObject();
            String id = optString(o, "id");
            if (id == null) {
                return null;
            }
            String name = optString(o, "name");
            String version = optString(o, "version");
            Map<String, String> depends = new LinkedHashMap<>();
            JsonElement dep = o.get("depends");
            if (dep != null && dep.isJsonObject()) {
                for (Map.Entry<String, JsonElement> e : dep.getAsJsonObject().entrySet()) {
                    depends.put(e.getKey(), e.getValue().isJsonPrimitive() ? e.getValue().getAsString() : "");
                }
            }
            return new ModMeta(id, name, version, depends, file);
        } catch (Throwable e) {
            return null;
        }
    }

    /// Forge 1.13+ / NeoForge 的 `mods.toml`。不引 TOML 库，只挑我们需要的几行：
    /// `modId="xxx"` 和 `[[dependencies.xxx]]` 段里的 `modId` / `mandatory`。
    private static ModMeta readForgeToml(java.util.zip.ZipFile zip, String file) {
        String raw = readEntry(zip, "META-INF/neoforge.mods.toml");
        if (raw == null) {
            raw = readEntry(zip, "META-INF/mods.toml");
        }
        if (raw == null) {
            return null;
        }

        String id = null;
        String name = null;
        String version = null;
        Map<String, String> depends = new LinkedHashMap<>();
        boolean inDeps = false;
        String pendingId = null;
        boolean pendingMandatory = true;

        for (String line : raw.split("\\R")) {
            String t = line.trim();
            if (t.startsWith("#")) {
                continue;
            }
            if (t.startsWith("[[dependencies.")) {
                // 上一段的收尾
                if (inDeps && pendingId != null && pendingMandatory) {
                    depends.put(pendingId, "");
                }
                inDeps = true;
                pendingId = null;
                pendingMandatory = true;
                continue;
            }
            if (t.startsWith("[") && !t.startsWith("[[")) {
                if (inDeps && pendingId != null && pendingMandatory) {
                    depends.put(pendingId, "");
                }
                inDeps = false;
                continue;
            }

            String key = beforeEquals(t);
            String value = afterEquals(t);
            if (key == null || value == null) {
                continue;
            }
            if (inDeps) {
                if ("modId".equals(key)) {
                    pendingId = unquote(value);
                } else if ("mandatory".equals(key)) {
                    pendingMandatory = !"false".equalsIgnoreCase(unquote(value));
                }
            } else {
                switch (key) {
                    case "modId" -> {
                        if (id == null) {
                            id = unquote(value);
                        }
                    }
                    case "displayName" -> {
                        if (name == null) {
                            name = unquote(value);
                        }
                    }
                    case "version" -> {
                        if (version == null) {
                            version = unquote(value);
                        }
                    }
                    default -> {
                    }
                }
            }
        }
        if (inDeps && pendingId != null && pendingMandatory) {
            depends.put(pendingId, "");
        }

        return id == null ? null : new ModMeta(id, name, version, depends, file);
    }

    /// 1.12.2 及更早的 `mcmod.info`。是个 JSON 数组，也可能是单个对象。
    private static ModMeta readMcmodInfo(java.util.zip.ZipFile zip, String file) {
        String raw = readEntry(zip, "mcmod.info");
        if (raw == null) {
            return null;
        }
        try {
            // 老文件偶尔带 UTF-8 BOM
            raw = raw.replace("\uFEFF", "").trim();
            JsonElement parsed = JsonParser.parseString(raw);
            JsonObject o;
            if (parsed.isJsonArray()) {
                JsonArray arr = parsed.getAsJsonArray();
                if (arr.isEmpty()) {
                    return null;
                }
                o = arr.get(0).getAsJsonObject();
            } else if (parsed.isJsonObject()) {
                // 少数包把它写成了 { "modList": [...] }
                JsonElement list = parsed.getAsJsonObject().get("modList");
                if (list != null && list.isJsonArray() && !list.getAsJsonArray().isEmpty()) {
                    o = list.getAsJsonArray().get(0).getAsJsonObject();
                } else {
                    o = parsed.getAsJsonObject();
                }
            } else {
                return null;
            }

            String id = optString(o, "modid");
            if (id == null) {
                return null;
            }
            String name = optString(o, "name");
            String version = optString(o, "version");

            Map<String, String> depends = new LinkedHashMap<>();
            JsonElement req = o.get("requiredMods");
            if (req != null && req.isJsonArray()) {
                for (JsonElement e : req.getAsJsonArray()) {
                    if (e.isJsonPrimitive()) {
                        // 1.12 的格式是 "modid:versionRange:side"
                        String raw2 = e.getAsString();
                        String depId = raw2.split(":")[0].trim();
                        if (!depId.isEmpty() && !"*".equals(depId)) {
                            depends.put(depId, "");
                        }
                    }
                }
            }
            JsonElement deps = o.get("dependencies");
            if (deps != null && deps.isJsonArray()) {
                for (JsonElement e : deps.getAsJsonArray()) {
                    if (e.isJsonPrimitive()) {
                        String depId = e.getAsString().trim();
                        if (!depId.isEmpty()) {
                            depends.put(depId, "");
                        }
                    }
                }
            }
            return new ModMeta(id, name, version, depends, file);
        } catch (Throwable e) {
            return null;
        }
    }

    private static String optString(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
    }

    private static String beforeEquals(String line) {
        int i = line.indexOf('=');
        return i <= 0 ? null : line.substring(0, i).trim();
    }

    private static String afterEquals(String line) {
        int i = line.indexOf('=');
        if (i < 0) {
            return null;
        }
        String v = line.substring(i + 1).trim();
        int hash = v.indexOf(" #");
        return hash >= 0 ? v.substring(0, hash).trim() : v;
    }

    private static String unquote(String v) {
        if (v.length() >= 2
                && ((v.startsWith("\"") && v.endsWith("\""))
                || (v.startsWith("'") && v.endsWith("'")))) {
            return v.substring(1, v.length() - 1);
        }
        return v;
    }
}
