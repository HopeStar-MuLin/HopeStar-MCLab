package org.jackhuang.hmcl.game;

import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jetbrains.annotations.Nullable;

import java.util.List;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 把启动管线的阶段推进转给 Web 界面。
///
/// HMCL 原生用 `TaskExecutorDialogPane` 显示这些阶段，但壳模式下界面是 WebView2 渲染的，
/// JavaFX 对话框用户看不到 —— 点下「启动」就是一段黑屏等待，不知道在干什么，也停不下来。
/// 这里把同一份 `TaskExecutor` 的阶段信号转发出去，由 Web 侧画自己的弹窗，
/// 并把执行器留给「取消」用。
///
/// 只读取既有的阶段声明（`withStagesHints`），不改启动逻辑本身。
public final class LaunchProgressBridge {

    /// 阶段推进的接收方。由 Web 桥接层注册；为 null 时整条链路保持静默。
    public interface Sink {
        /// @param stage   i18n key，`null` 表示没有具体阶段
        /// @param detail  更细的子状态（正在补全依赖库 / 正在校验游戏文件），可为 `null`
        /// @param percent 0..1，按阶段在清单里的位置折算
        /// @param done    这一轮启动是否结束
        /// @param error   结束且失败时的说明，成功为 `null`
        void onProgress(@Nullable String stage, @Nullable String detail, double percent,
                        boolean done, @Nullable String error);
    }

    @Nullable
    private static volatile Sink sink;
    /// 游戏进程退出时的回调。壳模式下用它把隐藏掉的启动器窗口放回来。
    @Nullable
    private static volatile Runnable gameExitAction;
    /// 当前这一轮启动的执行器，供「取消」使用
    @Nullable
    private static volatile TaskExecutor current;
    /// 阶段清单，按声明顺序折算百分比
    private static volatile List<Task.StagesHint> hints = List.of();
    /// 用户点了取消。用来把「取消」和「真出错」分开，前者不该弹失败提示。
    private static volatile boolean cancelling;

    private LaunchProgressBridge() {
    }

    public static void setSink(@Nullable Sink value) {
        sink = value;
    }

    public static void setGameExitAction(@Nullable Runnable action) {
        gameExitAction = action;
    }

    /// 盯住刚拉起来的游戏进程，退出时通知一次。
    ///
    /// 启动器隐藏之后，用户关掉游戏得能把窗口找回来 —— 没有这条回调，
    /// 启动器就真的「消失」了，只能在任务管理器里结束进程。
    public static void watchGameExit(@Nullable org.jackhuang.hmcl.util.platform.ManagedProcess process) {
        if (process == null) {
            return;
        }
        try {
            process.getProcess().onExit().thenRun(() -> {
                Runnable action = gameExitAction;
                if (action != null) {
                    LOG.info("[launch] game exited, notifying launcher");
                    action.run();
                }
            });
        } catch (Throwable e) {
            LOG.warning("[launch] cannot watch game process", e);
        }
    }

    /// 挂到一轮启动的执行器上。`LauncherHelper` 在建好执行器后调用。
    public static void attach(TaskExecutor executor) {
        current = executor;
        hints = executor.getHints();
        // 新一轮启动，清掉上一轮留下的取消标记
        cancelling = false;

        Sink target = sink;
        if (target == null) {
            // 没有 Web 界面（走原生对话框）就什么都不做
            return;
        }
        target.onProgress(null, null, 0, false, null);

        executor.addTaskListener(new TaskListener() {
            @Override
            public void onRunning(Task<?> task) {
                emit(task.getStage(), task);
            }

            @Override
            public void onPropertiesUpdate(Task<?> task) {
                emit(task.getStage(), task);
            }

            @Override
            public void onStop(boolean success, TaskExecutor ex) {
                current = null;
                Sink listener = sink;
                if (listener == null) {
                    return;
                }
                Exception failure = ex.getException();
                String error;
                if (success) {
                    error = null;
                } else if (cancelling || ex.isCancelled()
                        || failure instanceof java.util.concurrent.CancellationException
                        || failure instanceof InterruptedException
                        // cancel() 抛出来的常见包装：任务被中断时上层会转成这个
                        || (failure != null && failure.getClass().getSimpleName().contains("Cancell"))) {
                    // 用户自己点的取消，不是故障
                    error = "cancelled";
                } else {
                    error = failure == null
                            ? "启动失败"
                            : (failure.getMessage() == null
                                    ? failure.getClass().getSimpleName()
                                    : failure.getMessage());
                }
                // 这里不清 cancelling：进程可能还没落地，标志要留到下一轮 attach
                listener.onProgress(null, null, 1, true, error);
            }
        });
    }

    /// 这一轮启动是否已经被用户取消。`LauncherHelper` 在进程真正落地时查一次：
    /// 取消可能发生在 spawn 之前，那时任务还没完成，进程稍后照样会起来。
    public static boolean isCancelled() {
        return cancelling;
    }

    /// 取消当前这一轮启动。没有正在跑的启动就返回 `false`。
    ///
    /// 两件事分开做，因为取消的时机决定了哪一步有效：
    /// - 还在准备（下载依赖、拼参数）时，`executor.cancel()` 能中断；
    /// - 进程已经拉起来了，任务其实已经跑完，`cancel()` 什么也拦不住，
    ///   得把游戏进程本身停掉，否则「取消」了游戏照样在跑。
    public static boolean cancel() {
        boolean cancelled = false;

        // 标志无条件置上：进程可能在取消之后才 spawn 出来，
        // LauncherHelper 在那一头靠它决定要不要当场杀掉
        cancelling = true;

        TaskExecutor executor = current;
        if (executor != null) {
            LOG.info("[launch] cancel requested");
            executor.cancel();
            cancelled = true;
        }

        // 进程是异步拉起来的：取消的那一刻它可能还没 spawn，扫一遍会漏。
        // 盯着四秒，期间冒出来就杀。
        //
        // 这里不能先调 countMangedProcesses() 判断 —— 它内部会 removeIf 掉
        // 「看起来没在跑」的项，刚 spawn 还没标记为 running 的进程正好属于这一类，
        // 判断完队列就空了，后面自然杀不到。直接清，空队列是空操作。
        Thread cleanup = new Thread(() -> {
            for (int i = 0; i < 12; i++) {
                try {
                    Thread.sleep(400);
                } catch (InterruptedException e) {
                    return;
                }
                LauncherHelper.forceStopManagedProcesses();
                killGameProcesses();
            }
        }, "launch-cancel-cleanup");
        cleanup.setDaemon(true);
        cleanup.start();
        return cancelled;
    }

    /// 扫出这次启动新冒出来的游戏进程并杀掉。
    ///
    /// 为什么不只用 `LauncherHelper.PROCESSES`：取消可能落在「进程已创建、还没加入队列」
    /// 这个窗口里，注册链路被中断之后队列里永远不会有它 —— 于是「取消」了游戏照样在跑。
    /// 只能按命令行认：带 `--gameDir` 或 Minecraft 主类的，一定是游戏本身。
    private static void killGameProcesses() {
        try {
            for (ProcessHandle handle : ProcessHandle.current().descendants().toList()) {
                String cmd = handle.info().commandLine().orElse("");
                if (cmd.isEmpty()) {
                    continue;
                }
                if (cmd.contains("--gameDir") || cmd.contains("net.minecraft.client.main.Main")) {
                    LOG.info("[launch] killing leftover game process pid=" + handle.pid());
                    handle.destroyForcibly();
                }
            }
        } catch (Throwable e) {
            LOG.warning("[launch] cannot scan for leftover game processes", e);
        }
    }

    private static void emit(@Nullable String stage, @Nullable Task<?> task) {
        Sink target = sink;
        if (target == null) {
            return;
        }
        String detail = detailOf(task);
        // 一堆内部任务既没有 stage 也匹配不上细节，推过去只会刷屏
        if ((stage == null || stage.isBlank()) && detail == null) {
            return;
        }
        double percent = fractionOf(stage == null ? "" : stage);
        LOG.info("[launch-progress] " + (stage == null ? "-" : stage)
                + (detail == null ? "" : " | " + detail)
                + " | " + Math.round(percent * 100) + "%");
        target.onProgress(stage, detail, percent, false, null);
    }

    /// 把正在跑的 Task 翻成一句更具体的话。
    ///
    /// 依赖补全和完整性校验内部是若干个任务，HMCL 没给它们逐个声明 stage，
    /// 光看「处理游戏依赖」看不出是在下载库、在补资源，还是在读盘校验。
    /// 这里按类名补一层，遇到不认识的就返回 `null`，由上层退回阶段名。
    @Nullable
    private static String detailOf(@Nullable Task<?> task) {
        if (task == null) {
            return null;
        }
        return switch (task.getClass().getSimpleName()) {
            case "GameLibrariesTask", "LibraryDownloadTask" -> "正在补全依赖库";
            case "GameAssetDownloadTask", "GameAssetIndexDownloadTask" -> "正在补全资源文件";
            case "GameVerificationFixTask" -> "正在校验游戏文件";
            case "ModpackCompletionTask" -> "正在补全整合包文件";
            case "DecompressNativeTask" -> "正在解压运行库";
            default -> null;
        };
    }

    /// 阶段在清单里的位置折算成百分比。清单里找不到就返回 0，
    /// 前端会保持上一格的进度而不是倒退。
    private static double fractionOf(String stage) {
        List<Task.StagesHint> list = hints;
        if (list.isEmpty()) {
            return 0;
        }
        for (int i = 0; i < list.size(); i++) {
            Task.StagesHint hint = list.get(i);
            if (hint.stage().equals(stage) || hint.aliases().contains(stage)) {
                return (i + 1) / (double) list.size();
            }
        }
        return 0;
    }
}
