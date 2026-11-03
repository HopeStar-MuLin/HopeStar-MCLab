/*
 * HopeStar-MCLab
 *
 * 安装进度聚合。前端只有「一条任务、一根进度条」，所有子任务的事件都先灌进这里。
 */
package org.jackhuang.hmcl.ui.web;

import org.jackhuang.hmcl.task.FetchTask;
import org.jackhuang.hmcl.task.Task;

import java.util.HashMap;
import java.util.Map;

/// 把一棵安装任务树压成一条单调上升的进度。
///
/// <p>为什么需要它：HMCL 的 {@link Task#progressProperty()} 在 `doSubTask` 里
/// `progress.bind(task.progress)`——父任务的进度等于**当前那个子任务**的进度。
/// 装一个版本要下几千个文件，每个文件都从 0 走到 1，父任务的百分比于是跟着
/// 0 → 100 → 0 → 100 地抽搐。界面上那根条以前就是直接画这个值。
///
/// <p>现在换成「文件数」口径：
/// <ul>
///   <li>HMCL 在批量下载前会用 `properties("total", n)` 报出这一批的文件总数，
///       每个文件下完会走一次 {@link Task.CountTask}——总量累加、完成数累加，
///       百分比 = 完成数 / 总数；</li>
///   <li>装 Forge / Cleanroom 这类「安装器自己再下一堆文件」的阶段没有总数，
///       于是按真正发起的下载任务（名字就是 URL）自己数：发起算总数 +1、
///       结束算完成 +1，进度照样往前走；</li>
///   <li>整体百分比只允许变大，任何回退都丢掉——这是「不抽搐」的底线。</li>
/// </ul>
///
/// <p>线程模型：{@code TaskListener} 的回调在任务线程池里跑，可能并发，
/// 所以所有入口都是 `synchronized`。
final class InstallProgress {

    /// 分母下限。早期阶段可能只下 1 个 client.jar，
    /// 1/1 会把进度条直接顶到 100%，之后全是「卡住」。
    private static final int MIN_FILES = 40;

    /// 阶段 → 显示文案。只影响任务列表里那一行字，不影响百分比。
    private static final Map<String, String> LABEL = new HashMap<>();

    static {
        LABEL.put("meta", "读取版本信息");
        LABEL.put("resolve", "解析版本依赖");
        LABEL.put("client", "下载游戏本体");
        LABEL.put("libs", "下载依赖库");
        LABEL.put("assetIndex", "获取资源索引");
        LABEL.put("assets", "下载游戏资源");
        LABEL.put("verify", "校验并补全文件");
        LABEL.put("loader", "安装加载器");
        LABEL.put("builder", "整理实例文件");
    }

    /// 一次推送的内容。percent 已经是 0..1 的「整体」进度。
    interface Sink {
        void push(String stage, double percent, int filesDone, int filesTotal);
    }

    private final Sink sink;

    /// 当前阶段。只用来出文案、以及判断「这一段有没有官方总数」。
    private String phase;
    /// 文案用的阶段。和 {@link #phase} 分开是因为依赖库和资源是并行下的：
    /// 类任务是交替出现的，但每个文件的完成都带着自己的计数阶段
    /// （{@code hmcl.install.libraries} / {@code hmcl.install.assets}），
    /// 用后者出文案才不会出现「明明在下资源，写着下载依赖库」。
    private String shownPhase;
    /// 当前阶段的官方总数到了没有。到了就说明文件完成数由 CountTask 驱动，
    /// 不能再把 URL 任务重复算一遍。
    private boolean counted;

    /// 全程累计：完成了几个文件 / 一共要下几个文件。跨阶段不清零，
    /// 因为 HMCL 的依赖库和资源是并行跑的，按阶段算会来回跳。
    private int filesDone;
    private int filesTotal;

    private double lastPercent;

    /// 正在下载的文件各自完成了多少（0..1）。
    ///
    /// <p>为什么需要它：文件数是按「下完一个 +1」统计的，所以一个 10MB 的资源
    /// 在下完之前进度条纹丝不动——实测遇到过一个 9.8MB 的 .ogg 在
    /// resources.download.minecraft.net 上跑了 162 秒，界面上就是「99% 卡两分半」。
    /// 把在飞任务的自身进度也加进去，条就会一直动。
    private final Map<Task<?>, Double> inFlight = new HashMap<>();

    /// 任务是否还在跑。用来决定要不要在文案里带「已用 mm:ss」。
    private boolean active;
    /// 开始时间。文案里的计时全靠它——百分比卡在 99% 时，至少还有东西在动。
    private final long startedAt = System.currentTimeMillis();

    private long lastPushAt;

    InstallProgress(Sink sink) {
        this.sink = sink;
    }

    // ==================== 事件入口 ====================

    synchronized void onRunning(Task<?> task) {
        active = true;
        String name = task.getName();

        String next = phaseOf(name);
        if (next != null && !next.equals(phase)) {
            phase = next;
            shownPhase = next;
            counted = false;
            emit(true);
            // 阶段切换时上一阶段还没结束的下载（并行任务）继续记着，
            // 但它们属于旧阶段，进度仍要算——所以这里只 return 不清理
            return;
        }

        // 没有官方总数的阶段（Forge / Cleanroom 安装器）：把每个发起下载的任务
        // 当成一个文件计入分母。等它结束再计入分子。
        if (phase != null && !counted && isFetch(name)) {
            filesTotal++;
            emit(false);
        }

        // 文件任务自身的进度（FetchTask 每秒上报一次）：加进分子，让条一直动
        if (task instanceof FetchTask && !inFlight.containsKey(task)) {
            // 初始值是 -1（还没开始），夹到 0..1
            inFlight.put(task, Math.min(1.0, Math.max(0.0, task.progressProperty().get())));
            task.progressProperty().addListener((observable, oldValue, newValue) ->
                    onFileProgress(task, newValue));
        }
    }

    /// 单个文件的下载进度回调。可能在 IO 线程上被调用。
    private void onFileProgress(Task<?> task, Number value) {
        synchronized (this) {
            // 已经结束（或不是我们跟踪的）就不更新了
            if (!inFlight.containsKey(task)) {
                return;
            }
            double progress = value == null ? 0.0 : value.doubleValue();
            inFlight.put(task, Math.min(1.0, Math.max(0.0, progress)));
        }
        emit(false);
    }

    synchronized void onFinished(Task<?> task) {
        inFlight.remove(task);

        if (task instanceof Task.CountTask) {
            // HMCL 每下完一个文件就包一层 CountTask，它的完成就是「文件到手」。
            // countStage 顺便告诉我们这个文件属于依赖库还是资源，用来纠正文案。
            counted = true;
            filesDone++;
            String cs = countStageOf(task);
            if (cs != null) {
                shownPhase = cs;
            }
            emit(false);
            return;
        }
        if (phase != null && !counted && isFetch(task.getName())) {
            filesDone++;
            emit(false);
        }
    }

    /// 任务属性变更。`total` 是 HMCL 在批量下载前塞进去的文件总数
    /// （GameLibrariesTask / GameAssetDownloadTask 都会写）。
    synchronized void onProperties(Task<?> task) {
        if (phase == null) {
            // 还没进过任何已知阶段时，「total」不知道属于哪一段
            return;
        }
        Object total = task.getProperties() == null ? null : task.getProperties().get("total");
        if (!(total instanceof Number number)) {
            return;
        }
        int value = number.intValue();
        if (value <= 0) {
            return;
        }
        counted = true;
        // 同一个阶段可能分几批（依赖库一轮、补全一轮），总数累加
        filesTotal += value;
        emit(true);
    }

    /// 收尾：直接推到 100%。
    synchronized void finish() {
        active = false;
        lastPercent = 1.0;
        sink.push(stageText(), 1.0, filesDone, filesTotal);
    }

    /// 心跳：每秒调一次。
    ///
    /// <p>没有下载事件的时候（比如一个 10MB 的文件正在慢慢拉），前面所有推送都停了，
    /// 界面看上去就是「卡住」。这里强制推一次，靠文案里的计时器证明还活着。
    synchronized void tick() {
        if (!active) {
            return;
        }
        sink.push(stageText(), percent(), filesDone, filesTotal);
    }

    // ==================== 内部 ====================

    private String stageText() {
        if (shownPhase == null) {
            return "";
        }
        String label = LABEL.getOrDefault(shownPhase, "");
        if (filesTotal > 0) {
            label = label + " " + filesDone + "/" + filesTotal;
        }
        // 大文件下载时百分比和文件数都会长时间不动，这行计时是唯一的「还活着」信号
        return active ? label + " · 已用 " + elapsed() : label;
    }

    /// mm:ss，超过一小时加小时段。
    private String elapsed() {
        long seconds = (System.currentTimeMillis() - startedAt) / 1000L;
        long h = seconds / 3600;
        long m = (seconds % 3600) / 60;
        long s = seconds % 60;
        return h > 0
                ? String.format("%d:%02d:%02d", h, m, s)
                : String.format("%02d:%02d", m, s);
    }

    private double percent() {
        if (filesTotal <= 0) {
            return lastPercent;
        }
        // 已完成 + 在飞文件各自的比例：最后那个大文件下载时条也不会停
        double partial = 0.0;
        for (double value : inFlight.values()) {
            partial += value;
        }
        double ratio;
        if (filesTotal >= MIN_FILES) {
            ratio = (filesDone + partial) / filesTotal;
        } else {
            // 文件很少（基本都命中缓存）时不能拿 40 当分母，否则 2/2 会显示成 5%，
            // 然后一直「卡」在那里直到结束。直接按比例映射到 90%，剩下的 10% 留给收尾。
            ratio = filesTotal <= 0 ? lastPercent : (filesDone + partial) / filesTotal * 0.9;
        }
        if (ratio > 1.0) {
            ratio = 1.0;
        }
        // 上限留 1% 给「安装完成」：条先跑满、后面还在写实例文件会很怪
        if (ratio > 0.99) {
            ratio = 0.99;
        }
        if (ratio > lastPercent) {
            lastPercent = ratio;
        }
        return lastPercent;
    }

    private void emit(boolean force) {
        long now = System.currentTimeMillis();
        // 限流：几千个文件，每个都推一次 SSE 会打爆 WebView
        if (!force && now - lastPushAt < 120L) {
            return;
        }
        lastPushAt = now;
        sink.push(stageText(), percent(), filesDone, filesTotal);
    }

    /// 下载任务的名字就是它的地址（{@code FetchTask} 的默认名）。
    /// 用它来区分「一个文件的下载」和「一个流程节点」。
    private static boolean isFetch(String name) {
        return name != null && (name.startsWith("http://") || name.startsWith("https://"));
    }

    /// {@link Task.CountTask#getCountStage()} → 我们的阶段 key。
    /// HMCL 目前只在这两处挂计数器：`hmcl.install.libraries` / `hmcl.install.assets`。
    @SuppressWarnings("rawtypes")
    private static String countStageOf(Task<?> task) {
        if (!(task instanceof Task.CountTask)) {
            return null;
        }
        String stage = ((Task.CountTask) task).getCountStage();
        if (stage == null) {
            return null;
        }
        if (stage.contains("assets")) {
            return "assets";
        }
        if (stage.contains("librar")) {
            return "libs";
        }
        return null;
    }

    /// 任务名 → 阶段。
    ///
    /// <p>注意 {@code getName()} 给的**不是**简单类名：`Task` 的默认名就是
    /// {@code getClass().getName()}，也就是 `org.jackhuang.hmcl.download.game.GameAssetDownloadTask`。
    /// 直接拿全名去 switch 永远不命中（老代码就是这么漏掉一半阶段的），
    /// 所以先剥包名、再剥 `Task` 后缀，两种写法都认。
    private static String phaseOf(String raw) {
        if (raw == null || raw.startsWith("http://") || raw.startsWith("https://")) {
            return null;
        }
        String name = raw.substring(raw.lastIndexOf('.') + 1);
        if (name.endsWith("Task") && name.length() > 4) {
            name = name.substring(0, name.length() - 4);
        }
        switch (name) {
            case "GameInstanceJsonDownload", "GameInstanceJson":
                return "meta";
            case "GameInstall":
                return "resolve";
            case "GameDownload":
                return "client";
            case "GameLibraries", "LibraryDownload":
                return "libs";
            case "GameAssetIndexDownload":
                return "assetIndex";
            case "GameAssetDownload":
                return "assets";
            case "GameVerificationFix":
                return "verify";
            case "ForgeInstall", "FabricInstall", "QuiltInstall", "NeoForgeInstall",
                 "CleanroomInstall", "LiteLoaderInstall", "OptiFineInstall", "LegacyFabricInstall":
                return "loader";
            case "GameBuilder", "DefaultGameBuilder":
                return "builder";
            default:
                return null;
        }
    }
}
