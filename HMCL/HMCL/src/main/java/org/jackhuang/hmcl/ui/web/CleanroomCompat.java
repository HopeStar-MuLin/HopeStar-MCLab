/*
 * HopeStar-MCLab
 *
 * Cleanroom 的配套补丁模组。
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.HttpRequest;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// Cleanroom 的配套模组：**Fugue** 和 **Scalar Legacy**。
///
/// <p>Cleanroom 官方安装说明（cleanroommc.com/wiki）要求装完把这两个放进 mods：
/// <list>
///   <item>**Fugue** —— 给老 Forge 模组打 Cleanroom 的 API 差异补丁，覆盖 50+ 常见模组</item>
///   <item>**Scalar Legacy** —— Scala 2.11 运行库。Cleanroom 去掉了 Forge 自带的那套过时
///         Scala，OpenComputers / ProjectRed 这类模组会 NoClassDefFoundError</item>
/// </list>
///
/// <p>两个都支持「指定版本」：前端会先拉一遍可用版本让用户选，没选就装最新。
/// 接口异常时退回内置的固定地址，安装本身不受影响。
final class CleanroomCompat {

    private static final String FUGUE_SLUG = "fugue";
    /// CurseForge 的 project id。这个构建没有 CF API Key，走免 key 的 cfwidget
    private static final int SCALAR_CF_ID = 1235372;

    private static final String SCALAR_FALLBACK_URL =
            "https://mediafilez.forgecdn.net/files/6842/491/Scalar%20Legacy-1.0.1.jar";
    private static final String SCALAR_FALLBACK_NAME = "Scalar Legacy-1.0.1.jar";
    private static final String FUGUE_FALLBACK_URL =
            "https://cdn.modrinth.com/data/fugue/versions/c0Yz2B0N/Fugue-0.25.5.jar";
    private static final String FUGUE_FALLBACK_NAME = "Fugue-0.25.5.jar";

    private static final String UA = "HopeStar-MCLab";

    private CleanroomCompat() {
    }

    /// 一个可选版本。`version` 是给人看的版本号，`file` 是落盘文件名。
    private record Entry(String version, String file, String url) {
    }

    // ==================== 版本列表 ====================

    /// 列出某个附属模组在 1.12.2 下可用的版本（新的在前）。
    ///
    /// @param addonId `fugue` 或 `scalar`
    static String listVersions(String addonId) {
        JsonObject root = new JsonObject();
        List<Entry> entries;
        try {
            if ("fugue".equals(addonId)) {
                entries = fetchFugue();
            } else if ("scalar".equals(addonId)) {
                entries = fetchScalar();
            } else {
                root.addProperty("ok", false);
                root.addProperty("error", "未知的附属模组：" + addonId);
                return JsonUtils.GSON.toJson(root);
            }
        } catch (Throwable e) {
            LOG.warning("Cleanroom compat: failed to list versions of " + addonId, e);
            root.addProperty("ok", false);
            root.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(root);
        }

        JsonArray array = new JsonArray();
        for (Entry entry : entries) {
            JsonObject item = new JsonObject();
            item.addProperty("version", entry.version());
            item.addProperty("file", entry.file());
            item.addProperty("url", entry.url());
            array.add(item);
        }
        root.addProperty("ok", true);
        root.addProperty("type", addonId);
        root.add("versions", array);
        return JsonUtils.GSON.toJson(root);
    }

    private static List<Entry> fetchFugue() throws IOException {
        // 一次会挂三个包：本体 / -dev / -sources，只要本体
        String api = "https://api.modrinth.com/v2/project/" + FUGUE_SLUG
                + "/version?game_versions=%5B%221.12.2%22%5D&loaders=%5B%22forge%22%5D";
        JsonArray versions = HttpRequest.GET(api).getJson(JsonArray.class);
        List<Entry> list = new ArrayList<>();
        if (versions == null) {
            return list;
        }
        for (JsonElement element : versions) {
            JsonObject version = element.getAsJsonObject();
            String number = optString(version, "version_number");
            JsonArray files = version.getAsJsonArray("files");
            if (files == null) {
                continue;
            }
            for (JsonElement fileElement : files) {
                JsonObject file = fileElement.getAsJsonObject();
                String fileName = optString(file, "filename");
                if (fileName == null || !fileName.toLowerCase(Locale.ROOT).endsWith(".jar")) {
                    continue;
                }
                String lower = fileName.toLowerCase(Locale.ROOT);
                if (lower.contains("sources") || lower.contains("-dev")) {
                    continue;
                }
                String url = optString(file, "url");
                if (url == null) {
                    continue;
                }
                list.add(new Entry(number == null || number.isBlank() ? fileName : number, fileName, url));
                break;
            }
        }
        return list;
    }

    private static List<Entry> fetchScalar() throws IOException {
        JsonObject root = HttpRequest.GET("https://api.cfwidget.com/" + SCALAR_CF_ID)
                .getJson(JsonObject.class);
        List<Entry> list = new ArrayList<>();
        JsonArray files = root == null ? null : root.getAsJsonArray("files");
        if (files == null) {
            return list;
        }
        for (JsonElement element : files) {
            JsonObject file = element.getAsJsonObject();
            if (!supports1122(file)) {
                continue;
            }
            JsonElement idElement = file.get("id");
            String fileName = optString(file, "name");
            if (idElement == null || fileName == null || fileName.isBlank()) {
                continue;
            }
            // 这个项目的 `version` 字段填的是 MC 版本（1.12.2），mod 版本只在文件名里：
            // "Scalar Legacy-1.0.1.jar" → 1.0.1
            list.add(new Entry(versionFromFileName(fileName), fileName,
                    curseForgeCdn(idElement.getAsInt(), fileName)));
        }
        return list;
    }

    /// 从文件名里抠版本号：`Scalar Legacy-1.0.1.jar` → `1.0.1`。
    /// 抠不出来就退回完整文件名（前端照原样显示，不影响安装）。
    private static String versionFromFileName(String fileName) {
        String base = fileName.toLowerCase(Locale.ROOT).endsWith(".jar")
                ? fileName.substring(0, fileName.length() - 4) : fileName;
        int dash = base.lastIndexOf('-');
        if (dash >= 0 && dash < base.length() - 1) {
            String tail = base.substring(dash + 1).trim();
            if (tail.matches("[0-9][0-9A-Za-z.+_]*")) {
                return tail;
            }
        }
        return base;
    }

    // ==================== 安装 ====================

    /// 把两个补丁模组放进实例的 mods 目录。
    ///
    /// <p>在安装任务链的最后一步调用：那时实例已经提交完，`getModsDirectory()`
    /// 拿到的就是最终位置（隔离实例是 `versions/<id>/mods`，非隔离是 `.minecraft/mods`）。
    ///
    /// @param fugueVersion  指定的 Fugue 版本；空 = 装最新
    /// @param scalarVersion 指定的 Scalar Legacy 版本；空 = 装最新
    /// @param stage         进度回调，直接把文案推给下载任务那一行
    static void install(GameInstanceID instanceId, String fugueVersion, String scalarVersion,
                        Consumer<String> stage) {
        Path dir;
        try {
            var repository = GameDirectoryManager.getSelectedRepository();
            dir = repository.getInstance(instanceId).getModsDirectory();
            Files.createDirectories(dir);
        } catch (Throwable e) {
            LOG.warning("Cleanroom compat: cannot locate mods directory of " + instanceId, e);
            stage.accept("兼容模组跳过：" + e.getMessage());
            return;
        }

        installOne("fugue", fugueVersion, dir, stage);
        installOne("scalar", scalarVersion, dir, stage);
    }

    /// 装其中一个。用户没选版本就装最新，接口挂了就用内置地址。
    private static void installOne(String addonId, String wantedVersion, Path dir, Consumer<String> stage) {
        boolean isFugue = "fugue".equals(addonId);
        String label = isFugue ? "Fugue" : "Scalar Legacy";
        if (alreadyThere(dir, addonId)) {
            stage.accept(label + " 已在 mods 里，跳过");
            return;
        }
        stage.accept("安装 " + label + "…");

        List<Entry> entries = new ArrayList<>();
        try {
            entries = isFugue ? fetchFugue() : fetchScalar();
        } catch (Throwable e) {
            LOG.warning("Cleanroom compat: cannot query versions of " + addonId, e);
        }

        Entry picked = null;
        if (wantedVersion != null && !wantedVersion.isBlank()) {
            for (Entry entry : entries) {
                if (wantedVersion.equals(entry.version()) || wantedVersion.equals(entry.file())) {
                    picked = entry;
                    break;
                }
            }
            if (picked == null) {
                LOG.warning("Cleanroom compat: version " + wantedVersion + " of " + addonId
                        + " is not in the list, fall back to latest");
            }
        }
        if (picked == null && !entries.isEmpty()) {
            picked = entries.get(0);
        }

        String url = picked != null ? picked.url() : (isFugue ? FUGUE_FALLBACK_URL : SCALAR_FALLBACK_URL);
        String name = picked != null ? picked.file() : (isFugue ? FUGUE_FALLBACK_NAME : SCALAR_FALLBACK_NAME);

        String fallbackUrl = isFugue ? FUGUE_FALLBACK_URL : SCALAR_FALLBACK_URL;
        String fallbackName = isFugue ? FUGUE_FALLBACK_NAME : SCALAR_FALLBACK_NAME;
        try {
            // Scalar 本体 25MB（里面塞了整套 Scala 2.11 库），慢是正常的
            download(url, dir, safeName(name),
                    fallbackUrl.equals(url) ? null : fallbackUrl, fallbackName);
        } catch (Exception e) {
            LOG.warning("Cleanroom compat: failed to download " + addonId, e);
            stage.accept(label + " 下载失败，可稍后在实例里手动补装");
        }
    }

    // ==================== 工具 ====================

    /// 实例里已经有这个模组了就不再下——重装/升级 Cleanroom 时不该重复塞一份
    private static boolean alreadyThere(Path dir, String keyword) {
        try (var stream = Files.list(dir)) {
            return stream.anyMatch(path -> {
                String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
                return name.endsWith(".jar") && name.contains(keyword);
            });
        } catch (IOException e) {
            return false;
        }
    }

    /// CurseForge 的文件直链：文件 id 前四位是目录、后三位是文件名，
    /// 例如 6842491 → /files/6842/491/xxx.jar
    private static String curseForgeCdn(int fileId, String fileName) {
        String encoded = URLEncoder.encode(fileName, StandardCharsets.UTF_8).replace("+", "%20");
        return "https://mediafilez.forgecdn.net/files/" + (fileId / 1000) + "/" + (fileId % 1000)
                + "/" + encoded;
    }

    private static boolean supports1122(JsonObject file) {
        JsonArray versions = file.getAsJsonArray("versions");
        if (versions == null) {
            return false;
        }
        for (JsonElement version : versions) {
            if (version.isJsonPrimitive() && "1.12.2".equals(version.getAsString())) {
                return true;
            }
        }
        return false;
    }

    /// 原名里可能有 `+`（Modrinth 的 `+Fugue-0.25.5.jar`）或者别的奇怪字符，
    /// Windows 上留着不报错但看着别扭，统一收一下
    private static String safeName(String name) {
        String cleaned = name.trim().replaceAll("[\\\\/:*?\"<>|]", "_");
        // Modrinth 的文件名常带前导 '+'（"+Fugue-0.25.2.jar"），落盘时去掉更清爽
        cleaned = cleaned.replaceAll("^[+_-]+", "");
        return cleaned.isEmpty() ? "cleanroom-compat.jar" : cleaned;
    }

    private static void download(String url, Path dir, String fileName,
                                 String fallbackUrl, String fallbackName) throws IOException {
        Path target = dir.resolve(fileName);
        try {
            fetch(url, target);
            return;
        } catch (IOException primary) {
            LOG.warning("Cleanroom compat: " + url + " failed: " + primary);
            if (fallbackUrl == null || fallbackUrl.equals(url)) {
                throw primary;
            }
        }
        fetch(fallbackUrl, dir.resolve(safeName(fallbackName)));
    }

    private static void fetch(String url, Path target) throws IOException {
        Path tmp = target.resolveSibling(target.getFileName() + ".part");
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", UA);

        int code = connection.getResponseCode();
        if (code != HttpURLConnection.HTTP_OK) {
            throw new IOException("HTTP " + code + " for " + url);
        }

        try (InputStream in = connection.getInputStream()) {
            Files.copy(in, tmp, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            connection.disconnect();
        }

        // 拿回来的可能是一张 HTML 错误页（CDN 维护时就是这样），
        // 直接塞进 mods 会让游戏报「损坏的模组」，这里挡掉
        long size = Files.size(tmp);
        if (size < 1024) {
            Files.deleteIfExists(tmp);
            throw new IOException("file too small: " + size + " bytes from " + url);
        }
        try (InputStream in = Files.newInputStream(tmp)) {
            byte[] magic = in.readNBytes(2);
            if (magic.length < 2 || magic[0] != 'P' || magic[1] != 'K') {
                Files.deleteIfExists(tmp);
                throw new IOException("not a jar (no zip header) from " + url);
            }
        }
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        LOG.info("Cleanroom compat: installed " + target.getFileName() + " (" + size + " bytes)");
    }

    private static String optString(JsonObject object, String key) {
        JsonElement element = object == null ? null : object.get(key);
        return element == null || element.isJsonNull() ? null : element.getAsString();
    }
}
