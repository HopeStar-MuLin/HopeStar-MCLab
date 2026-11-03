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

import com.google.gson.JsonObject;
import javafx.application.Platform;
import javafx.stage.DirectoryChooser;
import javafx.stage.Stage;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.List;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 百宝箱：自定义下载（分段并发）、清理垃圾文件，以及 GitHub 镜像加速。
///
/// <p>从 [WebBridge] 拆出来的第四块：只有 HTTP + 文件操作，不碰实例状态。
@NotNullByDefault
public final class ToolboxApi {

    private final BridgeHost host;
    private final BridgeServices services;

    ToolboxApi(BridgeHost host, BridgeServices services) {
        this.host = host;
        this.services = services;
    }

    private void pushMirrorStatus(JsonObject result) {
        String text = JsonUtils.GSON.toJson(result);
        Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onMirrorStatus("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    private void pushMirrorProgress(GithubMirrorService.Result result) {
        JsonObject item = new JsonObject();
        item.addProperty("id", result.id());
        item.addProperty("name", result.name());
        item.addProperty("ok", result.ok());
        item.addProperty("ttfb", result.ttfbMs());
        item.addProperty("speed", result.speedKbps());
        item.addProperty("error", result.error());
        String text = JsonUtils.GSON.toJson(item);
        Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onMirrorProgress("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    // ==================== 百宝箱 ====================
    //
    // 对照 PCL 的 PageTools：自定义下载器 + 清理。
    // 清理那一块 PCL 实际做的是「删缓存 / 日志 / 崩溃报告 / natives」，
    // 而不是真的去释放物理内存（Java 进程也做不到 EmptyWorkingSet），
    // 所以这里照着它的行为做，文案也如实写「清理垃圾文件」。

    /// 选一个目录给下载器用。返回路径字符串，前端拿来回填输入框。
    public String chooseDownloadFolder() {
        try {
            Stage stage = Controllers.getStage();
            DirectoryChooser chooser = new DirectoryChooser();
            chooser.setTitle("选择下载保存位置");
            File dir = chooser.showDialog(stage);
            return dir == null ? "" : dir.getAbsolutePath();
        } catch (Exception e) {
            LOG.warning("Failed to choose download folder", e);
            return "";
        }
    }

    /// 打开任意目录（百宝箱的「打开保存位置」用）。
    public void openPath(String path) {
        try {
            if (path == null || path.isBlank()) {
                openPath(org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("downloads").toString());
                return;
            }
            Path dir = Path.of(path);
            if (!Files.isDirectory(dir)) {
                Files.createDirectories(dir);
            }
            FXUtils.openFolder(dir);
        } catch (Exception e) {
            LOG.warning("Failed to open path " + path, e);
        }
    }

    // ==================== GitHub 镜像 ====================

    /// 镜像列表 + 上次测速结果 + 当前最优。
    public String mirrorStatus() {
        return GithubMirrorService.status().toString();
    }

    /// 并行测所有镜像（固定 4 路）。
    ///
    /// <p>每测完一个就推一条 `onMirrorProgress`，全部结束后再推一次
    /// `onMirrorStatus`（带排序后的结果和最优镜像）。一百多个站逐个等太难受，
    /// 逐条亮起至少让人看到在动。
    public String mirrorTest() {
        org.jackhuang.hmcl.task.Task.runAsync(org.jackhuang.hmcl.task.Schedulers.io(), () -> {
            try {
                pushMirrorStatus(GithubMirrorService.test(4, this::pushMirrorProgress));
            } catch (Throwable e) {
                LOG.warning("Mirror test failed", e);
            }
        }).start();
        return "started";
    }


    /// 手动指定用哪个镜像。写进配置后，更新检查和百宝箱下载都走它。
    public String mirrorPick(String id) {
        return GithubMirrorService.pick(id).toString();
    }

    /// 百宝箱：把 GitHub 链接按指定镜像改写后再下载。
    ///
    /// <p>镜像站是公益服务，随时可能挂。这里把「镜像 → 原始链接」排成候选，
    /// 镜像失败自动换直连 —— 用户不该因为选了个死站就下不了文件。
    public void toolboxDownloadMirrored(String url, String dir, String fileName,
                                        int threads, String mirrorId) {
        if (url == null || url.isBlank()) {
            return;
        }
        String original = url.trim();
        String finalUrl = GithubMirrorService.rewrite(original, mirrorId);
        if (finalUrl.equals(original)) {
            runToolboxDownload(java.util.List.of(original), dir, fileName, threads);
            return;
        }
        LOG.info("[mirror] " + original + " -> " + finalUrl);
        runToolboxDownload(java.util.List.of(finalUrl, original), dir, fileName, threads);
    }

    /// 自定义下载（PCL 的 Tools.Test.CustomDownload）。
    ///
    /// 支持 Range 的站点会被切成 N 段并发拉，不支持的退回单线程——
    /// 盲目开多线程对不支持的站点没有任何帮助，只会把同一个文件重复下 N 遍。
    public void toolboxDownload(String url, String dir, String fileName, int threads) {
        if (url == null || url.isBlank()) {
            return;
        }
        runToolboxDownload(java.util.List.of(url.trim()), dir, fileName, threads);
    }

    /// 按顺序试候选源，第一个成功的就收工。
    private void runToolboxDownload(java.util.List<String> urls, String dir,
                                    String fileName, int threads) {
        String target = (dir == null || dir.isBlank())
                ? org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("downloads").toString()
                : dir;
        final int n = Math.max(1, Math.min(16, threads));

        Task.runAsync(Schedulers.io(), () -> {
            Exception last = null;
            for (int i = 0; i < urls.size(); i++) {
                String source = urls.get(i);
                try {
                    downloadTo(source, Path.of(target), fileName, n);
                    return;
                } catch (Exception e) {
                    last = e;
                    if (i + 1 < urls.size()) {
                        LOG.warning("[mirror] 下载失败，换下一个源：" + source + " — " + e.getMessage());
                    }
                }
            }
            throw last != null ? last : new java.io.IOException("没有可用的下载源");
        }).whenComplete(Schedulers.javafx(), exception -> {
            if (exception != null) {
                LOG.warning("Toolbox download failed", exception);
                pushToolboxProgress(0, 0, "", true, BridgeHost.localize(exception));
            }
        }).start();
    }

    private void downloadTo(String url, Path dir, String fileName, int threads) throws Exception {
        Files.createDirectories(dir);

        String name = fileName == null ? "" : fileName.trim();
        if (name.isEmpty()) {
            // 从 URL 末段猜一个；猜不出就用时间戳，总比报错强
            String path = URI.create(url).getPath();
            name = (path == null || path.isBlank() || path.endsWith("/"))
                    ? ("download-" + System.currentTimeMillis())
                    : path.substring(path.lastIndexOf('/') + 1);
        }
        // 只取文件名，挡住 `../` 这种路径穿越
        name = Path.of(name).getFileName().toString();
        Path target = dir.resolve(name);
        Path part = dir.resolve(name + ".part");

        var client = java.net.http.HttpClient.newBuilder()
                .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
                .connectTimeout(java.time.Duration.ofSeconds(20))
                .build();

        long total = -1;
        boolean ranged = false;
        try {
            var head = client.send(java.net.http.HttpRequest.newBuilder(URI.create(url))
                    .method("HEAD", java.net.http.HttpRequest.BodyPublishers.noBody())
                    .timeout(java.time.Duration.ofSeconds(20)).build(),
                    java.net.http.HttpResponse.BodyHandlers.discarding());
            String len = head.headers().firstValue("content-length").orElse("-1");
            total = Long.parseLong(len.trim());
            String accept = head.headers().firstValue("accept-ranges").orElse("");
            ranged = accept.toLowerCase().contains("bytes") && total > 4L * 1024 * 1024;
        } catch (Exception e) {
            // HEAD 被拒（很多站直接 405）就当不支持分段，下面走单线程
            LOG.info("HEAD failed, fallback to single connection: " + e);
        }

        int workers = ranged ? threads : 1;
        if (workers <= 1 || total <= 0) {
            downloadSingle(client, url, part, total);
        } else {
            downloadRanged(client, url, part, total, workers);
        }

        // 全部下完再改名，中途失败不会留下一个看起来完整的文件
        Files.move(part, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        // 完成时用落盘后的真实大小，不用 total：HEAD 拿不到 content-length 的站点
        // （很多 CDN 会拒 HEAD，直接 405）total 是 -1，照它显示会变成「0 B」。
        long size = Files.size(target);
        pushToolboxProgress(size, size, name, true, "");
    }

    private void downloadSingle(java.net.http.HttpClient client, String url, Path part, long total)
            throws Exception {
        var request = java.net.http.HttpRequest.newBuilder(URI.create(url))
                .timeout(java.time.Duration.ofMinutes(10)).build();
        var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
        long written = 0;
        long lastPush = 0;
        try (var in = response.body();
             var out = Files.newOutputStream(part)) {
            byte[] buf = new byte[64 * 1024];
            int read;
            while ((read = in.read(buf)) > 0) {
                out.write(buf, 0, read);
                written += read;
                long now = System.currentTimeMillis();
                // 每 200ms 推一次：每个 buffer 都推会把 HTTP 桥打满
                if (now - lastPush > 200) {
                    lastPush = now;
                    pushToolboxProgress(written, total, "", false, "");
                }
            }
        }
        pushToolboxProgress(written, total, "", false, "");
    }

    private void downloadRanged(java.net.http.HttpClient client, String url, Path part,
                                long total, int workers) throws Exception {
        // 先按最终大小建文件：每个线程用 FileChannel 往自己的区间里写，
        // 互不干扰，也不需要先下载完再拼接
        try (var channel = java.nio.channels.FileChannel.open(part,
                java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.WRITE)) {
            channel.truncate(0);
            channel.write(java.nio.ByteBuffer.allocate(1), total - 1);
        }

        java.util.concurrent.atomic.AtomicLong done = new java.util.concurrent.atomic.AtomicLong();
        java.util.concurrent.atomic.AtomicReference<Exception> failure =
                new java.util.concurrent.atomic.AtomicReference<>();

        java.util.concurrent.ExecutorService pool =
                java.util.concurrent.Executors.newFixedThreadPool(workers);
        long chunk = total / workers;
        for (int i = 0; i < workers; i++) {
            long start = i * chunk;
            long end = (i == workers - 1) ? total - 1 : (start + chunk - 1);
            pool.submit(() -> {
                try {
                    var request = java.net.http.HttpRequest.newBuilder(URI.create(url))
                            .header("Range", "bytes=" + start + "-" + end)
                            .timeout(java.time.Duration.ofMinutes(10)).build();
                    var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
                    try (var in = response.body();
                         var channel = java.nio.channels.FileChannel.open(part,
                                 java.nio.file.StandardOpenOption.WRITE)) {
                        byte[] buf = new byte[64 * 1024];
                        long pos = start;
                        int read;
                        while ((read = in.read(buf)) > 0) {
                            channel.write(java.nio.ByteBuffer.wrap(buf, 0, read), pos);
                            pos += read;
                            done.addAndGet(read);
                        }
                    }
                } catch (Exception e) {
                    failure.compareAndSet(null, e);
                }
            });
        }

        pool.shutdown();
        long lastPush = 0;
        while (!pool.awaitTermination(180, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            long now = System.currentTimeMillis();
            if (now - lastPush > 200) {
                lastPush = now;
                pushToolboxProgress(done.get(), total, "", false, "");
            }
        }
        pushToolboxProgress(done.get(), total, "", false, "");
        if (failure.get() != null) {
            throw failure.get();
        }
    }

    private void pushToolboxProgress(long done, long total, String fileName, boolean finished, String error) {
        JsonObject json = new JsonObject();
        json.addProperty("done", done);
        json.addProperty("total", total);
        if (fileName != null && !fileName.isBlank()) {
            json.addProperty("fileName", fileName);
        }
        json.addProperty("finished", finished);
        if (error != null && !error.isBlank()) {
            json.addProperty("error", error);
        }
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onToolboxProgress("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    /// 清理垃圾文件（PCL 的 Tools.Test.Clean）。
    ///
    /// 只清这些：各游戏目录的 logs / crash-reports / natives，以及启动器的 cache。
    /// 不动 libraries、assets、versions——那些删了要重下几百 MB，
    /// 属于「修复」不是「清理」。
    public void cleanupJunk() {
        Task.supplyAsync(Schedulers.io(), () -> {
            long freed = 0;
            int count = 0;
            java.util.List<Path> roots = new java.util.ArrayList<>();

            try {
                var repository = GameDirectoryManager.getSelectedRepository();
                if (repository != null) {
                    Path base = repository.getBaseDirectory();
                    roots.add(base.resolve("logs"));
                    roots.add(base.resolve("crash-reports"));
                    roots.add(base.resolve("natives"));
                    // 每个实例自己的 logs 与 natives
                    try (var dirs = Files.list(base.resolve("versions"))) {
                        for (Path dir : dirs.toList()) {
                            roots.add(dir.resolve("logs"));
                            roots.add(dir.resolve("crash-reports"));
                            roots.add(dir.resolve("natives"));
                        }
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            }

            try {
                String common = SettingsManager.settings().getResolvedCommonDirectory();
                if (common != null && !common.isBlank()) {
                    roots.add(Path.of(common, "cache"));
                }
            } catch (Exception ignored) {
            }

            for (Path dir : roots) {
                if (!Files.isDirectory(dir)) {
                    continue;
                }
                try (var walk = Files.walk(dir)) {
                    for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                        try {
                            if (Files.isRegularFile(p)) {
                                freed += Files.size(p);
                                Files.delete(p);
                                count++;
                            } else if (!p.equals(dir)) {
                                Files.delete(p);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                } catch (Exception ignored) {
                }
            }

            JsonObject result = new JsonObject();
            result.addProperty("count", count);
            result.addProperty("freed", freed);
            return result.toString();
        }).whenComplete(Schedulers.javafx(), (result, exception) -> {
            if (exception != null) {
                LOG.warning("Failed to clean junk", exception);
                host.toast("清理失败：" + BridgeHost.localize(exception));
                return;
            }
            String text = JsonUtils.GSON.toJson(result);
            host.execute("window.__hmcl && window.__hmcl.onCleanupResult(" + text + ")");
            host.toast("清理完成");
        }).start();
    }
}
