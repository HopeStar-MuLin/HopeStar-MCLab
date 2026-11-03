/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026  HopeStar-MuLin and contributors
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
import com.google.gson.JsonObject;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.download.java.JavaPackageType;
import org.jackhuang.hmcl.download.java.disco.DiscoFetchJavaListTask;
import org.jackhuang.hmcl.download.java.disco.DiscoJavaDistribution;
import org.jackhuang.hmcl.download.java.disco.DiscoJavaRemoteVersion;
import org.jackhuang.hmcl.download.java.disco.DiscoRemoteFileInfo;
import org.jackhuang.hmcl.download.java.disco.DiscoResult;
import org.jackhuang.hmcl.java.JavaManager;
import org.jackhuang.hmcl.java.JavaRuntime;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.DigestUtils;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.NetworkUtils;
import org.jackhuang.hmcl.util.platform.OperatingSystem;
import org.jackhuang.hmcl.util.platform.Platform;
import org.jackhuang.hmcl.util.versioning.GameVersionNumber;
import org.jackhuang.hmcl.util.versioning.VersionNumber;
import org.jetbrains.annotations.Nullable;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 内置 Java 运行时的下载与安装。
///
/// <p>清单和安装都复用上游：foojay 的 Disco API 拿「这个平台能装哪些版本」，
/// {@link JavaManager#getInstallJavaTask} 解压成托管 Java 并自动注册。
///
/// <p>**下载是自己写的**，因为 {@code FileDownloadTask} 写的是临时文件、取消即删，
/// 没法暂停续传。这里自己写一份：目标文件直接落地，暂停保留，继续时带 `Range: bytes=N-`
/// 从断点接上 —— 装个几百 MB 的 JDK，中途想停一下不该从头再来。
///
/// <p>进度走**共用的下载任务通道**（`onInstallTitle` + `onInstallStage`），和装版本 /
/// 装整合包同一个列表。点完「安装」弹窗直接关，进度在右上角，能暂停 / 继续 / 取消。
final class JavaInstallService {

    /// 列出来的发行版。GraalVM / Semeru 这类特殊用途的先不放：每个发行版一次请求，
    /// 界面上也用不上，反而拖慢首次打开的速度。
    private static final List<DiscoJavaDistribution> DISTRIBUTIONS = List.of(
            DiscoJavaDistribution.TEMURIN,
            DiscoJavaDistribution.ZULU,
            DiscoJavaDistribution.CORRETTO,
            DiscoJavaDistribution.LIBERICA);

    /// 只列 JDK。JRE 体积小一半，但 Forge / NeoForge 的安装器要 javac，
    /// 装成 JRE 会在装加载器那一步报错 —— 与其让用户踩，不如统一给 JDK。
    private static final JavaPackageType PACKAGE_TYPE = JavaPackageType.JDK;

    /// GitHub 直链在国内经常连不上；就算能连，本机装了 SteamTools / Watt Toolkit 这类
    /// 工具时它会用自己的根证书拦 HTTPS，Java 只认自己 cacerts 里那套，直接报
    /// `PKIX path building failed`。这几个镜像实测都能下，按顺序兜底。
    private static final String[] GITHUB_MIRRORS = {
            "https://ghfast.top/",
            "https://gh-proxy.com/",
            "https://ghproxy.net/",
    };

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(20))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final Consumer<String> executeJs;
    /// 装完要通知外面刷新 Java 列表（SettingsService 那边负责推 onJavaList）
    private final Runnable onInstalled;

    /// `temurin-21` → 远端条目。前端只传 id，对象留在后端。
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    /// 正在跑的任务：taskId → 任务。暂停 / 继续 / 取消都从这里找。
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    /// 同一时间只允许一个下载：两个下载抢同一个目标文件会写坏
    private final AtomicBoolean busy = new AtomicBoolean(false);

    record Entry(DiscoJavaDistribution distribution, DiscoJavaRemoteVersion version) {
        String id() {
            return distribution.getApiParameter() + "-" + version.getJdkVersion();
        }
    }

    /// 一个正在进行的安装任务。下载阶段可以暂停；解压阶段只保留取消。
    private final class Job {
        final String taskId;
        final String title;
        final Path archive;
        /// aria2 的断点控制文件（`<文件名>.aria2`）。暂停时留着，继续时靠它接上
        final Path ctl;
        final String[] urls;
        /// 兜底下载器用：当前用到第几个候选源。直连挂了就换镜像，换过去不再回头
        volatile int urlIndex;
        /// 正在跑的 aria2c 进程。暂停/取消靠它中断
        volatile Process proc;
        /// aria2 报的百分比；-1 表示还没收到（走 downloaded/total 那套）
        volatile int aria2Percent = -1;
        @Nullable final String checksumType;
        @Nullable final String checksum;
        final String installName;
        final Map<String, Object> updateInfo;

        /// 已经写进目标文件的字节数（兜底下载器用；aria2 走 aria2Percent）
        volatile long downloaded;
        /// 文件总大小，0 表示服务端没给
        volatile long total;
        volatile boolean paused;
        volatile boolean cancelled;
        /// 解压阶段才有
        volatile TaskExecutor installExecutor;
        volatile Thread thread;

        Job(String taskId, String title, Path archive, String[] urls,
            @Nullable String checksumType, @Nullable String checksum,
            String installName, Map<String, Object> updateInfo) {
            this.taskId = taskId;
            this.title = title;
            this.archive = archive;
            this.ctl = Aria2.controlFile(archive);
            this.urls = urls;
            this.checksumType = checksumType;
            this.checksum = checksum;
            this.installName = installName;
            this.updateInfo = updateInfo;
        }
    }

    JavaInstallService(Consumer<String> executeJs, Runnable onInstalled) {
        this.executeJs = executeJs;
        this.onInstalled = onInstalled;
    }

    // ==================== 列表 ====================

    /// 拉一遍「当前设备可安装的 Java」。四个发行版串行拉，任何一个失败都不影响其它。
    void requestList() {
        Thread worker = new Thread(() -> {
            Platform platform = Platform.SYSTEM_PLATFORM;
            List<Entry> collected = new ArrayList<>();
            StringBuilder failures = new StringBuilder();

            for (DiscoJavaDistribution distribution : DISTRIBUTIONS) {
                if (!distribution.isSupport(platform)) {
                    continue;
                }
                try {
                    collected.addAll(fetchDistribution(distribution, platform));
                } catch (Throwable e) {
                    LOG.warning("[java] 拉取 " + distribution.getApiParameter() + " 列表失败", e);
                    if (failures.length() > 0) {
                        failures.append("、");
                    }
                    failures.append(distribution.getApiParameter());
                }
            }

            // 排序：LTS 先进（8/11/17/21/25 是 Minecraft 真正会用的），同类里版本从新到旧，
            // 同版本 Temurin 靠前。不这么排的话 Java 27 EA 会排在第一屏，玩家看着莫名其妙。
            collected.sort(Comparator
                    .comparingInt((Entry e) -> isLts(e.version.getJdkVersion()) ? 0 : 1)
                    .thenComparing(Comparator.comparingInt((Entry e) -> e.version.getJdkVersion()).reversed())
                    .thenComparingInt(e -> e.distribution == DiscoJavaDistribution.TEMURIN ? 0 : 1)
                    .thenComparing(e -> e.distribution.getApiParameter()));

            entries.clear();
            JsonArray rows = new JsonArray();
            String installed = installedVersions();
            for (Entry entry : collected) {
                entries.put(entry.id(), entry);
                rows.add(toJson(entry, installed));
            }

            JsonObject root = new JsonObject();
            root.addProperty("os", platform.getOperatingSystem().getCheckedName());
            root.addProperty("arch", platform.getArchitecture().getCheckedName());
            root.add("list", rows);
            if (failures.length() > 0) {
                root.addProperty("warning", "这些源暂时拉不到：" + failures);
            }
            push("onJavaInstallable", JsonUtils.GSON.toJson(root));
        }, "java-installable");
        worker.setDaemon(true);
        worker.start();
    }

    private List<Entry> fetchDistribution(DiscoJavaDistribution distribution, Platform platform) throws Exception {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("distribution", distribution.getApiParameter());
        params.put("operating_system", platform.getOperatingSystem().getCheckedName());
        params.put("architecture", platform.getArchitecture().getCheckedName());
        params.put("archive_type", platform.getOperatingSystem() == OperatingSystem.WINDOWS ? "zip" : "tar.gz");
        params.put("directly_downloadable", "true");
        if (platform.getOperatingSystem() == OperatingSystem.LINUX) {
            params.put("lib_c_type", "glibc");
        }

        String url = NetworkUtils.withQuery(DiscoFetchJavaListTask.API_ROOT + "/packages", params);
        String json = httpGet(url);
        List<DiscoJavaRemoteVersion> all = JsonUtils
                .fromNonNullJson(json, DiscoResult.typeOf(DiscoJavaRemoteVersion.class))
                .getResult();

        // 同一个主版本会有很多构建，只留最新的那一个
        Map<Integer, DiscoJavaRemoteVersion> latest = new LinkedHashMap<>();
        for (DiscoJavaRemoteVersion version : all) {
            if (!distribution.getApiParameter().equals(version.getDistribution())
                    || !version.isDirectlyDownloadable()
                    || !distribution.testVersion(version)) {
                continue;
            }
            if (JavaPackageType.of("jdk".equalsIgnoreCase(version.getPackageType()), version.isJavaFXBundled())
                    != PACKAGE_TYPE) {
                continue;
            }
            DiscoJavaRemoteVersion old = latest.get(version.getJdkVersion());
            if (old == null || VersionNumber.compare(version.getDistributionVersion(),
                    old.getDistributionVersion()) > 0) {
                latest.put(version.getJdkVersion(), version);
            }
        }

        List<Entry> result = new ArrayList<>();
        latest.values().forEach(version -> result.add(new Entry(distribution, version)));
        return result;
    }

    private JsonObject toJson(Entry entry, @Nullable String installed) {
        DiscoJavaRemoteVersion version = entry.version;
        long size = version.getSize();

        JsonObject o = new JsonObject();
        o.addProperty("id", entry.id());
        o.addProperty("distro", entry.distribution.getApiParameter());
        o.addProperty("vendor", entry.distribution.getVendor());
        o.addProperty("jdkVersion", version.getJdkVersion());
        o.addProperty("javaVersion", version.getJavaVersion());
        o.addProperty("type", PACKAGE_TYPE.name());
        o.addProperty("size", size);
        o.addProperty("sizeText", humanSize(size));
        o.addProperty("lts", isLts(version.getJdkVersion()));
        o.addProperty("installed", installed != null && installed.contains("|" + shortVersion(version) + "|"));
        return o;
    }

    /// 已经装过的版本拼成一个 `|21.0.12.1|17.0.15|` 这样的串，用来标「已安装」。
    /// 只看版本号不看发行版：判断的是「这个版本我需不需要再装一份」，不是「装的是谁家的」。
    private static String installedVersions() {
        StringBuilder sb = new StringBuilder("|");
        try {
            var all = JavaManager.getAllJavaProperty().get();
            if (all != null) {
                for (JavaRuntime java : all) {
                    String v = java.getVersion();
                    if (v != null && !v.isBlank()) {
                        sb.append(v.trim()).append('|');
                    }
                }
            }
        } catch (Throwable e) {
            LOG.warning("[java] 读取已安装版本失败", e);
        }
        return sb.toString();
    }

    // ==================== 安装 ====================

    /// 下载 + 解压 + 注册。立即返回，进度进右上角的下载任务列表。
    void install(String id) {
        Entry entry = entries.get(id);
        if (entry == null) {
            pushTask("java-" + id, "安装 Java", "列表已过期，请重开窗口", true, true);
            return;
        }
        installEntry(entry);
    }

    /// 装一个已经解析好的条目。列表里点「安装」和「装完游戏自动补 Java」共用这一段。
    private void installEntry(Entry entry) {
        if (!busy.compareAndSet(false, true)) {
            pushTask("java-" + entry.id(), "安装 Java", "正在安装另一个 Java，等它装完再试", true, true);
            return;
        }

        String taskId = "java-" + entry.id();
        String title = "Java " + entry.version.getJavaVersion() + " · " + entry.distribution.getVendor();

        pushTitle(taskId, title);

        Thread worker = new Thread(() -> {
            try {
                pushTask(taskId, "读取下载信息…", null, false, false, false, 0.01);
                DiscoRemoteFileInfo fileInfo = fetchFileInfo(entry.version.getLinks().pkgInfoUri());

                Path dir = Metadata.HMCL_LOCAL_HOME.resolve("java-downloads");
                Files.createDirectories(dir);
                Path archive = dir.resolve(safeFileName(fileInfo.fileName()));

                Map<String, Object> updateInfo = new LinkedHashMap<>();
                updateInfo.put("type", "disco");
                updateInfo.put("info", entry.version);
                String installName = entry.distribution.getApiParameter() + "-" + shortVersion(entry.version);

                Job job = new Job(taskId, title, archive, withMirrors(fileInfo.directDownloadUri()),
                        fileInfo.checksumType(), fileInfo.checksum(), installName, updateInfo);
                job.total = entry.version.getSize();
                jobs.put(taskId, job);

                // 上次留下的文件直接接着用（暂停后重进、或换了进程）
                if (Files.isRegularFile(job.archive)) {
                    job.downloaded = Files.size(job.archive);
                }

                runDownload(job);
            } catch (Throwable e) {
                LOG.warning("[java] 安装失败", e);
                pushTask(taskId, "安装失败", "安装失败：" + describe(e), true, true);
                busy.set(false);
            }
        }, "java-install");
        worker.setDaemon(true);
        worker.start();
    }

    /// 暂停。已经下好的字节留在目标文件里（aria2 还有 .aria2 控制文件），继续时接上。
    boolean pause(String taskId) {
        Job job = jobs.get(taskId);
        if (job == null || job.paused || job.installExecutor != null) {
            return false;
        }
        job.paused = true;
        Process proc = job.proc;
        if (proc != null) {
            // 强杀。aria2 是边下边更新 .aria2 控制文件的，下次 -c 能接着下
            proc.destroy();
        }
        return true;
    }

    /// 继续。aria2 靠 `.aria2` 控制文件接上，兜底下载器靠 archive 已有长度接上。
    boolean resume(String taskId) {
        Job job = jobs.get(taskId);
        if (job == null || !job.paused || job.cancelled) {
            return false;
        }
        job.paused = false;
        Thread worker = new Thread(() -> {
            try {
                runDownload(job);
            } catch (Throwable e) {
                LOG.warning("[java] 继续下载失败", e);
                pushTask(taskId, "安装失败", "安装失败：" + describe(e), true, true);
                cleanup(job);
            }
        }, "java-resume");
        worker.setDaemon(true);
        job.thread = worker;
        worker.start();
        return true;
    }

    /// 装完一个游戏实例后调用：这个版本需要的 Java 本地没有，就自动下一个。
    ///
    /// <p>对应最经典的卡点：玩家装完 1.12.2，点启动才被告知「需要 Java 8」。
    /// 这里在装完的瞬间就静默补上 —— 只在右上角任务列表里出现一条，不弹确认框，
    /// 也不打断用户手上的操作。
    void ensureForGame(String versionId) {
        int major = requiredMajor(versionId);
        if (major <= 0) {
            return;
        }
        if (hasJavaMajor(major)) {
            LOG.info("[java] " + versionId + " 需要 Java " + major + "，本地已有");
            return;
        }

        Thread worker = new Thread(() -> {
            try {
                Entry picked = resolveEntry(major);
                if (picked == null) {
                    LOG.warning("[java] 找不到 Java " + major + " 的可下载条目，跳过自动补齐");
                    return;
                }
                LOG.info("[java] " + versionId + " 需要 Java " + major + "，开始静默补齐");
                installEntry(picked);
            } catch (Throwable e) {
                LOG.warning("[java] 自动补 Java " + major + " 失败", e);
            }
        }, "java-ensure");
        worker.setDaemon(true);
        worker.start();
    }

    /// 现拉一次 foojay，挑出指定大版本的条目（Temurin 优先，没有再试 Zulu）
    @Nullable
    private Entry resolveEntry(int major) throws Exception {
        for (DiscoJavaDistribution distribution : new DiscoJavaDistribution[]{
                DiscoJavaDistribution.TEMURIN, DiscoJavaDistribution.ZULU}) {
            if (!distribution.isSupport(Platform.SYSTEM_PLATFORM)) {
                continue;
            }
            for (Entry entry : fetchDistribution(distribution, Platform.SYSTEM_PLATFORM)) {
                if (entry.version.getJdkVersion() == major) {
                    entries.put(entry.id(), entry);
                    return entry;
                }
            }
        }
        return null;
    }

    /// 游戏版本 → 它需要的 Java 大版本。
    ///
    /// 1.20.5 起强制 21；1.17–1.20.4 是 17；更早的一律按 8 处理
    /// （1.16.5 及以下用 8 最稳，装 17 反而会崩）。
    private static int requiredMajor(String versionId) {
        try {
            var version = GameVersionNumber.asGameVersion(versionId);
            if (version.compareTo(GameVersionNumber.asGameVersion("1.20.5")) >= 0) {
                return 21;
            }
            if (version.compareTo(GameVersionNumber.asGameVersion("1.17")) >= 0) {
                return 17;
            }
            return 8;
        } catch (Throwable e) {
            return 0;
        }
    }

    /// 本地已经有的 Java 里有没有这个主版本
    private static boolean hasJavaMajor(int major) {
        try {
            var all = JavaManager.getAllJavaProperty().get();
            if (all == null) {
                return false;
            }
            for (JavaRuntime java : all) {
                String raw = java.getVersion();
                if (raw == null || raw.isBlank()) {
                    continue;
                }
                String[] parts = raw.trim().split("[._+-]");
                if (parts.length == 0) {
                    continue;
                }
                int first;
                try {
                    first = Integer.parseInt(parts[0]);
                } catch (NumberFormatException e) {
                    continue;
                }
                // 1.8.0_504 这种老写法
                int actual = first;
                if (first == 1 && parts.length > 1) {
                    try {
                        actual = Integer.parseInt(parts[1]);
                    } catch (NumberFormatException ignored) {
                    }
                }
                if (actual == major) {
                    return true;
                }
            }
        } catch (Throwable e) {
            LOG.warning("[java] 读本地 Java 版本失败", e);
        }
        return false;
    }

    /// 取消。删掉 `.part`，不留残渣。
    boolean cancel(String taskId) {
        Job job = jobs.get(taskId);
        if (job == null) {
            return false;
        }
        job.cancelled = true;
        TaskExecutor installing = job.installExecutor;
        if (installing != null) {
            // 解压阶段没有 loop 可退，直接停执行器
            installing.cancel();
            return true;
        }
        Process proc = job.proc;
        if (proc != null) {
            proc.destroy();
        }
        Thread thread = job.thread;
        if (thread == null || !thread.isAlive()) {
            // 已经停下了（暂停状态），这里直接收尾
            deleteDownloaded(job);
            pushTask(taskId, "已取消", "已取消", true, true);
            cleanup(job);
        }
        // 正在跑的话由 runDownload 里的循环收尾
        return true;
    }

    // ==================== 下载循环 ====================

    /// 一个 Job 的下载主流程：下完 → 校验 → 解压安装。可能被暂停/取消打断。
    private void runDownload(Job job) throws Exception {
        job.thread = Thread.currentThread();

        if (Aria2.locate() != null) {
            downloadWithAria2(job);
        } else {
            downloadWithOwnClient(job);
        }

        // 两条路径各自处理暂停/取消的收尾，走到这里就是下完了
        if (job.cancelled || job.paused) {
            return;
        }

        // 校验：sha256 对不上就删掉重来，别把坏包解压进去
        if (!verify(job)) {
            deleteDownloaded(job);
            pushTask(job.taskId, "安装失败", "安装失败：下载的文件校验不通过，请重试", true, true);
            cleanup(job);
            return;
        }

        startInstall(job);
    }

    /// 主路径：交给 aria2c。多源并行、16 连接分块，进程被强杀后靠 `.aria2` 续上。
    private void downloadWithAria2(Job job) throws Exception {
        Path exe = Aria2.locate();
        if (exe == null) {
            downloadWithOwnClient(job);
            return;
        }

        List<String> urls = List.of(job.urls);
        int failures = 0;

        while (true) {
            if (job.cancelled) {
                deleteDownloaded(job);
                pushTask(job.taskId, "已取消", "已取消", true, true);
                cleanup(job);
                return;
            }
            if (job.paused) {
                pushTask(job.taskId, "已暂停", null, false, true, true, progressOf(job));
                return;
            }

            Process proc = new ProcessBuilder(Aria2.command(exe, job.archive, urls))
                    .redirectErrorStream(true)
                    .start();
            job.proc = proc;

            // 进度靠 stdout：每秒一行，形如
            // [#446a7e 2.0MiB/6.0MiB(34%) CN:16 DL:1.0MiB ETA:3s]
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    Aria2.Progress progress = Aria2.parse(line);
                    if (progress == null) {
                        continue;
                    }
                    job.aria2Percent = progress.percent();
                    String speed = progress.speed() == null ? "" : " · " + progress.speed() + "/s";
                    pushTask(job.taskId, "下载 " + job.archive.getFileName() + speed,
                            null, false, false, false, progressOf(job));
                }
            }
            int rc = proc.waitFor();
            job.proc = null;

            if (job.cancelled || job.paused) {
                continue;   // 回到循环顶，让上面那两段统一收尾
            }
            if (rc == 0 && Files.isRegularFile(job.archive)) {
                job.aria2Percent = 100;
                pushTask(job.taskId, "下载完成，准备安装", null, false, false, false, 0.88);
                return;
            }

            if (++failures >= 2) {
                throw new IOException("下载失败（aria2c 退出码 " + rc + "）");
            }
            LOG.warning("[java] aria2c 退出码 " + rc + "，重试第 " + failures + " 次");
            Thread.sleep(1000);
        }
    }

    /// 兜底：没有 aria2c 时用 JVM 自己的 HTTP 客户端，单连接 + Range 续传。
    private void downloadWithOwnClient(Job job) throws Exception {
        while (true) {
            if (job.cancelled) {
                deleteDownloaded(job);
                pushTask(job.taskId, "已取消", "已取消", true, true);
                cleanup(job);
                return;
            }
            if (job.paused) {
                pushTask(job.taskId, "已暂停", null, false, true, true, progressOf(job));
                return;
            }
            if (job.total > 0 && job.downloaded >= job.total) {
                return;
            }

            boolean reachedEnd = fetchChunk(job);
            if (reachedEnd) {
                return;
            }
            // 服务端提前断开但没下完：歇一下接着来，别空转
            Thread.sleep(300);
        }
    }

    /// 依次试候选源（直连 → 镜像）。某个源连不上就换下一个，并记住能用的那个。
    private boolean fetchChunk(Job job) throws Exception {
        Exception last = null;
        while (job.urlIndex < job.urls.length) {
            String url = job.urls[job.urlIndex];
            try {
                return fetchFrom(job, url);
            } catch (Exception e) {
                LOG.warning("[java] 源不可用，换下一个：" + url + " → " + e);
                last = e;
                job.urlIndex++;
                // 换了源，总大小和断点都可能对不上，重新探测
                job.total = 0;
            }
        }
        throw last instanceof IOException io ? io
                : new IOException("没有可用的下载源", last);
    }

    /// 从指定地址拉一段，追加到 `.part`。返回 true 表示已经到文件末尾。
    private boolean fetchFrom(Job job, String url) throws Exception {
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("User-Agent", Metadata.NAME + "/" + Metadata.VERSION);
        if (job.downloaded > 0) {
            builder.header("Range", "bytes=" + job.downloaded + "-");
        }

        HttpResponse<InputStream> response = CLIENT.send(builder.GET().build(),
                HttpResponse.BodyHandlers.ofInputStream());
        int code = response.statusCode();
        if (code != 200 && code != 206) {
            throw new IOException("HTTP " + code);
        }

        if (code == 206) {
            // Content-Range: bytes 0-123/456 → 顺手把总大小补准
            String range = response.headers().firstValue("Content-Range").orElse("");
            int slash = range.lastIndexOf('/');
            if (slash > 0 && slash < range.length() - 1) {
                try {
                    job.total = Long.parseLong(range.substring(slash + 1).trim());
                } catch (NumberFormatException ignored) {
                }
            }
        } else if (job.downloaded > 0) {
            // 服务端没理 Range：只能从头写
            job.downloaded = 0;
            deleteQuietly(job.archive);
        } else {
            long length = response.headers().firstValueAsLong("Content-Length").orElse(-1);
            if (length > 0) {
                job.total = length;
            }
        }

        try (InputStream in = response.body();
             FileChannel out = FileChannel.open(job.archive,
                     StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.APPEND)) {
            byte[] buffer = new byte[64 * 1024];
            int n;
            while (!job.paused && !job.cancelled && (n = in.read(buffer)) > 0) {
                ByteBuffer bb = ByteBuffer.wrap(buffer, 0, n);
                while (bb.hasRemaining()) {
                    out.write(bb);
                }
                job.downloaded += n;
                pushTask(job.taskId, "下载 " + job.archive.getFileName(), null,
                        false, false, false, progressOf(job));
                if (job.total > 0 && job.downloaded >= job.total) {
                    return true;
                }
            }
        }
        return job.total > 0 && job.downloaded >= job.total;
    }

    /// 下载阶段占 2%–88%，解压 90%–100%。
    private double progressOf(Job job) {
        if (job.aria2Percent >= 0) {
            return 0.02 + (Math.min(100, job.aria2Percent) / 100.0) * 0.86;
        }
        if (job.total <= 0) {
            return 0.02;
        }
        double ratio = Math.max(0, Math.min(1, (double) job.downloaded / job.total));
        return 0.02 + ratio * 0.86;
    }

    private boolean verify(Job job) {
        if (job.checksum == null || job.checksum.isBlank() || job.checksumType == null) {
            return true;
        }
        try {
            String actual = DigestUtils.digestToString(job.checksumType, job.archive);
            return job.checksum.equalsIgnoreCase(actual);
        } catch (Exception e) {
            LOG.warning("[java] 校验失败", e);
            return false;
        }
    }

    /// 解压成托管 Java 并注册。JavaManager 内部会 addJava，列表随之刷新。
    private void startInstall(Job job) {
        pushTask(job.taskId, "解压安装…", null, false, false, false, 0.9);
        try {
            Task<JavaRuntime> task = JavaManager.getInstallJavaTask(
                    Platform.SYSTEM_PLATFORM, job.installName, job.updateInfo, job.archive);

            AtomicReference<Throwable> lastError = new AtomicReference<>();
            TaskExecutor executor = task.executor();
            job.installExecutor = executor;
            executor.addTaskListener(new TaskListener() {
                @Override
                public void onFailed(Task<?> sub, Throwable throwable) {
                    lastError.compareAndSet(null, throwable);
                }
            });

            task.onDone().register(event -> {
                try {
                    if (event.isFailed()) {
                        if (job.cancelled) {
                            pushTask(job.taskId, "已取消", "已取消", true, true);
                            return;
                        }
                        pushTask(job.taskId, "安装失败", "安装失败：" + describe(lastError.get()), true, true);
                        return;
                    }
                    pushTask(job.taskId, "安装完成", null, true, true, false, 1.0);
                    onInstalled.run();
                } finally {
                    deleteQuietly(job.archive);
                    deleteQuietly(job.archive);
                    cleanup(job);
                }
            });
            executor.start();
        } catch (Throwable e) {
            LOG.warning("[java] 解压失败", e);
            pushTask(job.taskId, "安装失败", "安装失败：" + describe(e), true, true);
            deleteQuietly(job.archive);
            cleanup(job);
        }
    }

    private void cleanup(Job job) {
        jobs.remove(job.taskId);
        busy.set(false);
    }

    private DiscoRemoteFileInfo fetchFileInfo(String uri) throws Exception {
        String json = httpGet(uri);
        List<DiscoRemoteFileInfo> result = JsonUtils
                .fromNonNullJson(json, DiscoResult.typeOf(DiscoRemoteFileInfo.class))
                .getResult();
        if (result == null || result.size() != 1) {
            throw new IOException("下载信息异常");
        }
        return result.get(0);
    }

    // ==================== 推送（共用下载任务通道）====================

    private void pushTask(String taskId, String stage, @Nullable String error, boolean done, boolean isError) {
        pushTask(taskId, stage, error, done, isError, false, -1);
    }

    /// `percent` 是 0..1；-1 表示这一步没有量化进度（前端画不确定动画）。
    /// `paused` 让前端把 ⏸ 换成 ▶。
    private void pushTask(String taskId, String stage, @Nullable String error,
                          boolean done, boolean isError, boolean paused, double percent) {
        JsonObject o = new JsonObject();
        o.addProperty("id", taskId);
        o.addProperty("stage", stage);
        o.addProperty("done", done);
        o.addProperty("error", error);
        o.addProperty("kind", "java");
        o.addProperty("paused", paused);
        // 暂停时不带「可取消」，前端据此把 ✕ 换成「继续 + 移除」
        o.addProperty("percent", percent);
        push("onInstallStage", JsonUtils.GSON.toJson(o));
    }

    private void pushTitle(String taskId, String title) {
        JsonObject o = new JsonObject();
        o.addProperty("id", taskId);
        o.addProperty("title", title);
        push("onInstallTitle", JsonUtils.GSON.toJson(o));
    }

    private void push(String callback, String jsonText) {
        executeJs.accept("window.__hmcl && window.__hmcl." + callback + "("
                + JsonUtils.GSON.toJson(jsonText) + ")");
    }

    // ==================== 工具 ====================

    /// GitHub 的直链拆成「直连 + 几个镜像」，按顺序试。
    /// 非 GitHub 的地址原样返回，不绕。
    private static String[] withMirrors(String url) {
        if (url == null || url.isBlank()) {
            return new String[0];
        }
        boolean github = url.startsWith("https://github.com/")
                || url.startsWith("https://objects.githubusercontent.com/")
                || url.startsWith("https://release-assets.githubusercontent.com/");
        if (!github) {
            return new String[]{url};
        }
        String[] out = new String[GITHUB_MIRRORS.length + 1];
        out[0] = url;
        for (int i = 0; i < GITHUB_MIRRORS.length; i++) {
            out[i + 1] = GITHUB_MIRRORS[i] + url;
        }
        return out;
    }

    private static String httpGet(String url) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("User-Agent", Metadata.NAME + "/" + Metadata.VERSION)
                .GET()
                .build();
        HttpResponse<String> response = CLIENT.send(request,
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            throw new IOException("HTTP " + response.statusCode() + " " + url);
        }
        return response.body();
    }

    /// `21.0.9+11` → `21.0.9`。加号后面的构建号在目录名和「已安装」比对里都是噪音。
    private static String shortVersion(DiscoJavaRemoteVersion version) {
        String v = version.getJavaVersion();
        int plus = v.indexOf('+');
        return plus > 0 ? v.substring(0, plus) : v;
    }

    private static final java.util.Set<Integer> LTS = java.util.Set.of(8, 11, 17, 21, 25);

    private static boolean isLts(int major) {
        return LTS.contains(major);
    }

    private static String humanSize(long bytes) {
        if (bytes <= 0) {
            return "";
        }
        if (bytes >= 1073741824L) {
            return String.format(Locale.ROOT, "%.1f GB", bytes / 1073741824.0);
        }
        return Math.round(bytes / 1048576.0) + " MB";
    }

    /// 远端文件名只取最后一段，防 `../` 之类的越界写法
    private static String safeFileName(String raw) {
        String name = raw == null ? "" : raw.replace('\\', '/');
        int slash = name.lastIndexOf('/');
        if (slash >= 0) {
            name = name.substring(slash + 1);
        }
        name = name.replaceAll("[^A-Za-z0-9._+-]", "_");
        return name.isBlank() ? "java-archive.zip" : name;
    }

    private static String describe(@Nullable Throwable e) {
        if (e == null) {
            return "未知错误";
        }
        Throwable cause = org.jackhuang.hmcl.util.Lang.resolveException(e);
        String message = cause.getMessage();
        if (message == null || message.isBlank()) {
            return cause.getClass().getSimpleName();
        }
        int newline = message.indexOf('\n');
        return newline > 0 ? message.substring(0, newline) : message;
    }

    /// 删掉下载产物和 aria2 的控制文件。取消、校验失败时用。
    private static void deleteDownloaded(Job job) {
        deleteQuietly(job.archive);
        deleteQuietly(job.ctl);
    }

    private static void deleteQuietly(@Nullable Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            LOG.warning("[java] 清理下载文件失败：" + path, e);
        }
    }
}
