/*
 * HopeStar-MCLab
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.function.LongConsumer;

/// 从 GitHub Releases 检查并拉取启动器自身的更新。
///
/// 两个源，主源是 jsDelivr：
/// - 主源读仓库根目录的 `update.json`，`@latest` 会自动指向最新的 release tag，
///   发版只管打 tag，URL 不用改；这条在国内网络能直连。
/// - 兜底走 `api.github.com`，给能直连 GitHub 的网络用。
public final class UpdateService {

    /// 更新源。换仓库只改这一处；本地调试可以用系统属性或环境变量覆盖。
    private static final String REPO = System.getProperty("mclab.update.repo",
            System.getenv().getOrDefault("MCLAB_UPDATE_REPO", "HopeStar-MCLab/HopeStar-MCLab"));

    /// 清单与更新包的前缀。默认 jsDelivr 的 `@latest`（自动指向最新 release tag）；
    /// 本地联调可以用 `-Dmclab.update.base=http://127.0.0.1:端口` 指到 mock 服务。
    private static final String JSDELIVR_LATEST = System.getProperty("mclab.update.base",
            "https://cdn.jsdelivr.net/gh/" + REPO + "@latest");

    private static final String LATEST_API = "https://api.github.com/repos/" + REPO + "/releases/latest";

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private UpdateService() {
    }

    public static String currentVersion() {
        return Metadata.VERSION;
    }

    /// 查最新版本：先读 jsDelivr 上的 update.json，不通再问 GitHub API。
    public static JsonObject checkLatest() throws IOException {
        Throwable manifestError;
        try {
            return checkFromManifest();
        } catch (Throwable e) {
            manifestError = e;
        }
        try {
            return checkFromApi();
        } catch (Throwable apiError) {
            apiError.addSuppressed(manifestError);
            throw new IOException("连不上更新服务器：" + shortMessage(manifestError), manifestError);
        }
    }

    /// 仓库根目录的 update.json：
    /// `{ "version": "3.18", "notes": "...", "jar": "update/HopeStar-MCLab.jar", "jarSize": 13738908 }`
    private static JsonObject checkFromManifest() throws IOException {
        JsonObject manifest = getJson(JSDELIVR_LATEST + "/update.json?t=" + System.currentTimeMillis());
        String latest = optString(manifest, "version");
        String jarPath = optString(manifest, "jar");
        String url = "";
        if (!jarPath.isBlank()) {
            url = jarPath.startsWith("http") ? jarPath : JSDELIVR_LATEST + "/" + jarPath;
        }
        JsonObject out = new JsonObject();
        out.addProperty("current", currentVersion());
        out.addProperty("latest", latest);
        out.addProperty("tag", latest.isBlank() ? "" : "v" + latest);
        out.addProperty("notes", trim(optString(manifest, "notes"), 1200));
        out.addProperty("url", url);
        out.addProperty("size", manifest.has("jarSize") ? manifest.get("jarSize").getAsLong() : 0L);
        out.addProperty("hasUpdate", isNewer(latest, currentVersion()));
        out.addProperty("repo", REPO);
        return out;
    }

    /// GitHub API 兜底：能连 api.github.com 的网络走这里。
    private static JsonObject checkFromApi() throws IOException {
        JsonObject release = getJson(LATEST_API);
        String tag = optString(release, "tag_name");
        String latest = stripV(tag);
        JsonObject asset = pickAsset(release);

        JsonObject out = new JsonObject();
        out.addProperty("current", currentVersion());
        out.addProperty("latest", latest);
        out.addProperty("tag", tag);
        out.addProperty("notes", trim(optString(release, "body"), 1200));
        out.addProperty("url", asset != null ? optString(asset, "browser_download_url") : "");
        out.addProperty("size", asset != null ? asset.get("size").getAsLong() : 0L);
        out.addProperty("hasUpdate", isNewer(latest, currentVersion()));
        out.addProperty("repo", REPO);
        return out;
    }

    /// 下载更新包。边下边回报百分比（0–100）。
    public static void download(String url, Path target, long expectedSize, LongConsumer progress) throws IOException {
        if (url == null || url.isBlank()) {
            throw new IOException("这个版本没有提供更新包");
        }
        Path tmp = target.resolveSibling(target.getFileName() + ".part");
        Files.createDirectories(target.getParent());
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMinutes(30))
                .header("User-Agent", Metadata.NAME + "/" + Metadata.VERSION)
                .GET()
                .build();
        HttpResponse<InputStream> response;
        try {
            response = CLIENT.send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("下载被中断", e);
        }
        if (response.statusCode() != 200) {
            throw new IOException("下载失败：HTTP " + response.statusCode());
        }

        long total = response.headers().firstValueAsLong("Content-Length").orElse(expectedSize);
        long done = 0;
        try (InputStream in = response.body(); var out = Files.newOutputStream(tmp)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (progress != null) {
                    progress.accept(total > 0 ? Math.min(100, done * 100 / total) : done);
                }
            }
        }
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
    }

    /// 生成并启动替换脚本，然后调用方自行退出进程。
    ///
    /// 两种包：
    /// - `.jar`：热更新，只覆盖 `data/<NAME>.jar`（约 13 MB），走 jsDelivr 在国内也能下；
    /// - `.zip`：完整包，解压覆盖整个安装目录。
    ///
    /// 运行中的 jar / exe 是锁着的，只能等进程退出后再覆盖，所以交给一个延迟脚本执行：
    /// 等本进程结束 → 替换 → 重新启动。
    public static void applyUpdate(Path downloaded, Path installDir) throws IOException {
        Path scriptDir = downloaded.getParent();
        Path script = scriptDir.resolve("apply-update.ps1");
        String exe = installDir.resolve(Metadata.NAME + ".exe").toString();
        boolean jarOnly = downloaded.getFileName().toString().toLowerCase().endsWith(".jar");

        ArrayList<String> lines = new ArrayList<>();
        lines.add("$ErrorActionPreference = 'Stop'");
        lines.add("Start-Sleep -Seconds 2");
        lines.add("Wait-Process -Id " + ProcessHandle.current().pid() + " -ErrorAction SilentlyContinue");
        if (jarOnly) {
            Path targetJar = installDir.resolve("data").resolve(Metadata.NAME + ".jar");
            lines.add("Copy-Item -LiteralPath " + quote(downloaded.toString())
                    + " -Destination " + quote(targetJar.toString()) + " -Force");
        } else {
            lines.add("$tmp = Join-Path $env:TEMP ('mclab-update-' + [guid]::NewGuid().ToString('N'))");
            lines.add("Expand-Archive -LiteralPath " + quote(downloaded.toString()) + " -DestinationPath $tmp -Force");
            lines.add("$src = Join-Path $tmp '" + Metadata.NAME + "'");
            lines.add("if (-not (Test-Path $src)) { $src = $tmp }");
            lines.add("Copy-Item -Path (Join-Path $src '*') -Destination " + quote(installDir.toString()) + " -Recurse -Force");
            lines.add("Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue");
        }
        lines.add("Start-Process -FilePath " + quote(exe));
        lines.add("Remove-Item -LiteralPath " + quote(downloaded.toString()) + " -Force -ErrorAction SilentlyContinue");
        lines.add("");
        Files.writeString(script, String.join("\r\n", lines), StandardCharsets.UTF_8);

        new ProcessBuilder("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-WindowStyle", "Hidden", "-File", script.toString())
                .directory(scriptDir.toFile())
                .start();
    }

    // ==================== 内部 ====================

    private static JsonObject getJson(String url) throws IOException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(20))
                .header("Accept", "application/json")
                .header("User-Agent", Metadata.NAME + "/" + Metadata.VERSION)
                .GET()
                .build();
        HttpResponse<String> response;
        try {
            response = CLIENT.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("请求被中断", e);
        }
        if (response.statusCode() == 404) {
            throw new IOException("更新源里还没有这个文件（HTTP 404）");
        }
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode());
        }
        return JsonUtils.fromNonNullJson(response.body(), JsonObject.class);
    }

    /// 给用户看的短错误：超时不甩一整段堆栈。
    private static String shortMessage(Throwable e) {
        if (e instanceof HttpTimeoutException) {
            return "请求超时";
        }
        if (e instanceof ConnectException) {
            return "连接被拒绝，检查网络或代理";
        }
        String m = e.getMessage();
        return m == null || m.isBlank() ? e.getClass().getSimpleName() : m;
    }

    /// 从 assets 里挑更新包：优先带 `HopeStar` 的 zip，其次任意 zip。
    private static JsonObject pickAsset(JsonObject release) {
        if (!release.has("assets") || !release.get("assets").isJsonArray()) {
            return null;
        }
        JsonArray assets = release.getAsJsonArray("assets");
        JsonObject fallback = null;
        for (var element : assets) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject asset = element.getAsJsonObject();
            String name = optString(asset, "name").toLowerCase();
            String url = optString(asset, "browser_download_url");
            if (!name.endsWith(".zip") || url.isEmpty()) {
                continue;
            }
            if (name.contains("hopestar") || name.contains("mclab")) {
                return asset;
            }
            if (fallback == null) {
                fallback = asset;
            }
        }
        return fallback;
    }

    private static String stripV(String tag) {
        return tag != null && (tag.startsWith("v") || tag.startsWith("V")) ? tag.substring(1) : tag;
    }

    /// 语义化比较：按 `.` 切段，数字比大小，非数字段（SNAPSHOT 之类）当 0。
    static boolean isNewer(String latest, String current) {
        int[] a = parse(latest);
        int[] b = parse(current);
        for (int i = 0; i < Math.max(a.length, b.length); i++) {
            int x = i < a.length ? a[i] : 0;
            int y = i < b.length ? b[i] : 0;
            if (x != y) {
                return x > y;
            }
        }
        return false;
    }

    private static int[] parse(String version) {
        if (version == null || version.isBlank()) {
            return new int[0];
        }
        String[] parts = version.split("[.\\-+]");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try {
                out[i] = Integer.parseInt(parts[i].replaceAll("\\D.*$", ""));
            } catch (NumberFormatException e) {
                out[i] = 0;
            }
        }
        return out;
    }

    private static String optString(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
    }

    private static String trim(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    private static String quote(String s) {
        return "'" + s.replace("'", "''") + "'";
    }
}
