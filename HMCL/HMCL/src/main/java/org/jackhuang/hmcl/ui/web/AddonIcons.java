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

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/// 实例内容列表里的图标：从 jar / zip / 存档目录里把作者自带的那张挖出来。
///
/// <p>下载页上的图标是平台给的（Modrinth / CurseForge），本地文件没有那份数据，
/// 但模组作者几乎都会往 jar 里塞一张 `icon.png`，资源包有 `pack.png`，存档有
/// Minecraft 自己生成的 `icon.png` —— 这些和下载页看到的往往是同一张图。
///
/// <p>取不到就返回 null，前端换成字母占位。宁可没图，也不要显示一个和内容无关的
/// 通用图标 —— 那比没有更误导。
final class AddonIcons {

    private AddonIcons() {
    }

    /// 图标最大 4 MB。见过有人把 2048 的渲染图塞进 `icon.png`，
    /// 列表里一次几十张全走 HTTP，太大意义不大。
    private static final long MAX_BYTES = 4L * 1024 * 1024;

    /// 元数据里没写图标时的兜底文件名。按顺序找，第一个存在的就用。
    private static final String[] FALLBACKS = {"icon.png", "logo.png", "pack.png", "assets/icon.png"};

    /// 缓存：`路径|mtime|大小` -> 字节。
    ///
    /// 列表重绘、切标签都会重新请求一遍图标；每次都开 zip 读一遍太浪费。
    /// 键里带 mtime，用户换了文件自然会读到新图。
    private static final int CACHE_MAX = 256;
    private static final Map<String, byte[]> CACHE = Collections.synchronizedMap(
            new LinkedHashMap<>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
                    return size() > CACHE_MAX;
                }
            });

    /// 读一个内容的图标。认不出类型就返回 null。
    static byte[] read(Path file, String kind) {
        try {
            if (!Files.exists(file)) {
                return null;
            }
            String key = keyOf(file);
            if (key != null) {
                byte[] hit = CACHE.get(key);
                if (hit != null) {
                    return hit;
                }
            }

            byte[] data = switch (kind == null ? "" : kind) {
                // 截图本身就是图，直接当缩略图用（前端 object-fit 裁一下）
                case "screenshot" -> readFile(file);
                // 每个存档目录里都有 icon.png，是游戏自己截的
                case "world" -> readFile(file.resolve("icon.png"));
                // 资源包 / 光影的图标固定叫 pack.png。光影包多数不带，
                // 那就走字母占位 —— 硬塞一个通用图标等于骗人
                case "resourcepack", "shader" -> readerIcon(file);
                // 蓝图是 NBT，没有图标这回事
                case "schematic" -> null;
                default -> modIcon(file);
            };

            if (data != null && data.length > 0 && key != null) {
                CACHE.put(key, data);
            }
            return data;
        } catch (Throwable t) {
            return null;
        }
    }

    private static String keyOf(Path file) {
        try {
            return file.toAbsolutePath() + "|" + Files.getLastModifiedTime(file).toMillis()
                    + "|" + (Files.isDirectory(file) ? "d" : Files.size(file));
        } catch (Exception e) {
            return null;
        }
    }

    // ==================== 各类来源 ====================

    /// 资源包 / 光影：zip 根目录的 pack.png，或者解压开的文件夹里的同名文件。
    private static byte[] readerIcon(Path file) {
        if (Files.isDirectory(file)) {
            return readFile(file.resolve("pack.png"));
        }
        try (ZipFile zip = new ZipFile(file.toFile())) {
            return readZipEntry(zip, "pack.png");
        } catch (Throwable t) {
            return null;
        }
    }

    /// 模组：先读元数据里写的路径，读不到再按常见文件名兜底。
    ///
    /// <p>元数据格式有四种，挨个试：
    /// `fabric.mod.json` / `quilt.mod.json` / `META-INF/mods.toml`（NeoForge 同名）/
    /// `mcmod.info`（1.12 及以前）。都认不出来就当它不是模组 jar。
    private static byte[] modIcon(Path jar) {
        if (Files.isDirectory(jar)) {
            // 极少数人把模组解压成文件夹放 mods/，当作没有图标
            return null;
        }
        try (ZipFile zip = new ZipFile(jar.toFile())) {
            String path = null;

            ZipEntry fabric = findEntry(zip, "fabric.mod.json");
            if (fabric != null) {
                path = iconFromJson(zip, fabric, "icon");
            }
            if (path == null) {
                ZipEntry quilt = findEntry(zip, "quilt.mod.json");
                if (quilt != null) {
                    path = quiltIcon(zip, quilt);
                }
            }
            if (path == null) {
                ZipEntry toml = findEntry(zip, "META-INF/neoforge.mods.toml");
                if (toml == null) {
                    toml = findEntry(zip, "META-INF/mods.toml");
                }
                if (toml != null) {
                    path = tomlIcon(zip, toml);
                }
            }
            if (path == null) {
                ZipEntry info = findEntry(zip, "mcmod.info");
                if (info != null) {
                    path = mcmodInfoIcon(zip, info);
                }
            }

            if (path != null) {
                byte[] data = readZipEntry(zip, path);
                if (data != null) {
                    return data;
                }
            }
            for (String name : FALLBACKS) {
                byte[] data = readZipEntry(zip, name);
                if (data != null) {
                    return data;
                }
            }
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    // ==================== 元数据解析 ====================

    /// Fabric：`"icon": "assets/icon.png"`，也允许对象形式 `{"sizes": {...}}`
    private static String iconFromJson(ZipFile zip, ZipEntry entry, String field) {
        JsonObject root = readJsonObject(zip, entry);
        return root == null ? null : iconField(root, field);
    }

    /// Quilt 把图标放在 `quilt_loader.metadata.icon`，也有直接写在根上的
    private static String quiltIcon(ZipFile zip, ZipEntry entry) {
        JsonObject root = readJsonObject(zip, entry);
        if (root == null) {
            return null;
        }
        String direct = iconField(root, "icon");
        if (direct != null) {
            return direct;
        }
        if (root.has("quilt_loader") && root.get("quilt_loader").isJsonObject()) {
            JsonObject loader = root.getAsJsonObject("quilt_loader");
            if (loader.has("metadata") && loader.get("metadata").isJsonObject()) {
                return iconField(loader.getAsJsonObject("metadata"), "icon");
            }
        }
        return null;
    }

    private static String iconField(JsonObject obj, String field) {
        if (obj == null || !obj.has(field)) {
            return null;
        }
        JsonElement e = obj.get(field);
        if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) {
            String s = e.getAsString();
            return s.isBlank() ? null : s;
        }
        // 对象形式（Fabric 的 sizes 写法）没有单一路径，退回兜底文件名
        return null;
    }

    /// Forge / NeoForge：`logoFile="logo.png"`，单双引号都见过
    private static String tomlIcon(ZipFile zip, ZipEntry entry) {
        String text = readText(zip, entry, 256 * 1024);
        if (text == null) {
            return null;
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("logoFile\\s*=\\s*[\"']([^\"']+)[\"']")
                .matcher(text);
        return m.find() ? m.group(1) : null;
    }

    /// 1.12 的 mcmod.info：数组或单个对象，字段叫 logoFile
    private static String mcmodInfoIcon(ZipFile zip, ZipEntry entry) {
        String text = readText(zip, entry, 512 * 1024);
        if (text == null) {
            return null;
        }
        try {
            JsonElement root = JsonParser.parseString(text);
            JsonObject obj = null;
            if (root.isJsonArray()) {
                JsonArray array = root.getAsJsonArray();
                if (!array.isEmpty() && array.get(0).isJsonObject()) {
                    obj = array.get(0).getAsJsonObject();
                }
            } else if (root.isJsonObject()) {
                obj = root.getAsJsonObject();
            }
            if (obj == null) {
                return null;
            }
            return iconField(obj, "logoFile");
        } catch (Throwable t) {
            return null;
        }
    }

    private static JsonObject readJsonObject(ZipFile zip, ZipEntry entry) {
        String text = readText(zip, entry, 512 * 1024);
        if (text == null) {
            return null;
        }
        try {
            JsonElement root = JsonParser.parseString(text);
            return root.isJsonObject() ? root.getAsJsonObject() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    // ==================== 读字节 ====================

    private static byte[] readFile(Path file) {
        try {
            if (!Files.isRegularFile(file)) {
                return null;
            }
            long size = Files.size(file);
            if (size <= 0 || size > MAX_BYTES) {
                return null;
            }
            return Files.readAllBytes(file);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String readText(ZipFile zip, ZipEntry entry, long max) {
        byte[] data = readZipEntry(zip, entry, max);
        return data == null ? null : new String(data, StandardCharsets.UTF_8);
    }

    /// 按名字取条目。jar 里的路径大小写不统一（`Icon.png` 也见过），
    /// 精确找不到就忽略大小写再扫一遍。
    private static ZipEntry findEntry(ZipFile zip, String name) {
        ZipEntry entry = zip.getEntry(name);
        if (entry != null) {
            return entry;
        }
        var entries = zip.entries();
        while (entries.hasMoreElements()) {
            ZipEntry candidate = entries.nextElement();
            if (candidate.getName().equalsIgnoreCase(name)) {
                return candidate;
            }
        }
        return null;
    }

    private static byte[] readZipEntry(ZipFile zip, String name) {
        ZipEntry entry = findEntry(zip, name);
        return entry == null ? null : readZipEntry(zip, entry, MAX_BYTES);
    }

    private static byte[] readZipEntry(ZipFile zip, ZipEntry entry, long max) {
        try (InputStream in = zip.getInputStream(entry)) {
            long size = entry.getSize();
            if (size > max) {
                return null;
            }
            // 条目头里的 size 可能是 -1（流式压缩），那就按 max 兜底读
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(
                    size > 0 ? (int) size : 8192);
            byte[] buffer = new byte[8192];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) > 0) {
                total += read;
                if (total > max) {
                    return null;
                }
                out.write(buffer, 0, read);
            }
            return out.size() == 0 ? null : out.toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }
}
