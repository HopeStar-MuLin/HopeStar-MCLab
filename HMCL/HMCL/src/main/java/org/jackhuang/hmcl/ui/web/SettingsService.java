package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import javafx.application.Platform;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.game.ProcessPriority;
import org.jackhuang.hmcl.java.JavaManager;
import org.jackhuang.hmcl.java.JavaRuntime;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.GameSettings;
import org.jackhuang.hmcl.setting.GameWindowType;
import org.jackhuang.hmcl.setting.JavaVersionType;
import org.jackhuang.hmcl.setting.LauncherVisibility;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.i18n.SupportedLocale;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.function.Consumer;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 设置页的数据读写：启动器 / Java / 游戏。
///
/// <p>写操作全部按 key 分派，不暴露「把整个配置对象塞回来」的接口。
/// 那样前端得知道每个字段的类型和边界，任何一处不合法都会连累整份配置，
/// 而这些边界（内存上下限、线程数、枚举取值）HMCL 自己已经定好了。
///
/// <p>每写一个 key 都重新推一遍快照。因为有些值会被夹回合法范围
/// （内存超出物理内存、线程数越界），界面必须回填真实值，不能停在用户输入的假值上。
final class SettingsService {

    private final Consumer<String> executeJs;

    SettingsService(Consumer<String> executeJs) {
        this.executeJs = executeJs;
    }

    // ==================== 读取 ====================

    /// 完整快照。顶层保留旧字段（`launcherVersion` / `javaVersion` 那些），
    /// 前端老代码还在用；新代码走 `launcher` / `download` / `java` / `game` 四段。
    String snapshot() {
        JsonObject root = new JsonObject();

        root.addProperty("launcherVersion", Metadata.VERSION);
        // 启动器名单独给一份：前端不该把品牌名写死，改一次名字要动所有文案
        root.addProperty("launcherName", Metadata.NAME);
        root.addProperty("javaVersion", System.getProperty("java.version"));
        root.addProperty("javaVendor", System.getProperty("java.vendor"));
        root.addProperty("javaHome", System.getProperty("java.home"));
        root.addProperty("os", System.getProperty("os.name") + " " + System.getProperty("os.version"));
        // 堆上限：这是 JVM 实际拿到的，不是配置里写的那个数
        root.addProperty("maxMemory", Runtime.getRuntime().maxMemory() / 1048576L);

        String gameDir = "";
        try {
            var repo = GameDirectoryManager.getSelectedRepository();
            if (repo != null) {
                Object base = repo.getBaseDirectory();
                if (base instanceof Path path) {
                    gameDir = path.toAbsolutePath().toString();
                } else if (base != null) {
                    gameDir = base.toString();
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to read game directory", e);
        }
        root.addProperty("gameDirectory", gameDir);

        root.add("launcher", launcherSection());
        root.add("download", downloadSection());
        root.add("java", javaSection());
        root.add("game", gameSection());

        return JsonUtils.GSON.toJson(root);
    }

    private JsonObject launcherSection() {
        JsonObject o = new JsonObject();
        try {
            var s = SettingsManager.settings();
            var u = SettingsManager.userSettings();

            o.addProperty("language", s.languageProperty().get().getName());
            o.addProperty("acceptPreviewUpdate", s.acceptPreviewUpdateProperty().get());
            o.addProperty("disableAutoUpdateDialog", s.disableAutoShowUpdateDialogProperty().get());

            Boolean animation = s.animationDisabledProperty().get();
            o.addProperty("animationDisabled", animation != null && animation);

            Integer logLines = s.logLinesProperty().get();
            o.addProperty("logLines", logLines == null ? 0 : logLines);

            o.addProperty("logRetention", u.logRetentionProperty().get());
            o.addProperty("enableOfflineAccount", u.enableOfflineAccountProperty().get());

            o.addProperty("proxyType", s.proxyTypeProperty().get().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("proxyHost", nullToEmpty(s.proxyHostProperty().get()));
            o.addProperty("proxyPort", s.proxyPortProperty().get());
            o.addProperty("proxyUser", nullToEmpty(s.proxyUserProperty().get()));
            o.addProperty("hasProxyAuth", s.hasProxyAuthProperty().get());

            JsonArray langs = new JsonArray();
            SupportedLocale current = s.languageProperty().get();
            for (SupportedLocale locale : SupportedLocale.getSupportedLocales()) {
                JsonObject item = new JsonObject();
                item.addProperty("name", locale.getName());
                item.addProperty("display", locale.getDisplayName(current));
                langs.add(item);
            }
            o.add("languages", langs);
        } catch (Exception e) {
            LOG.warning("Failed to read launcher settings", e);
        }
        return o;
    }

    private JsonObject downloadSection() {
        JsonObject o = new JsonObject();
        try {
            var s = SettingsManager.settings();
            o.addProperty("versionListSource", s.versionListSourceProperty().get().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("fileDownloadSource", s.fileDownloadSourceProperty().get().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("autoDownloadThreads", s.autoDownloadThreadsProperty().get());
            o.addProperty("downloadThreads", s.downloadThreadsProperty().get());
            o.addProperty("defaultAddonSource", s.defaultAddonSourceProperty().get());
        } catch (Exception e) {
            LOG.warning("Failed to read download settings", e);
        }
        return o;
    }

    /// 物理内存快照（MB）。前端每 30 秒刷一次，只取这三个数，
    /// 不走 getSettings 那一大坨（里面有语言列表、Java 列表，没必要每半分钟搬一遍）。
    public String memorySnapshot() {
        JsonObject o = new JsonObject();
        try {
            var os = (com.sun.management.OperatingSystemMXBean)
                    java.lang.management.ManagementFactory.getOperatingSystemMXBean();
            long totalMb = os.getTotalMemorySize() / 1048576L;
            long freeMb = os.getFreeMemorySize() / 1048576L;
            o.addProperty("total", (int) Math.min(Integer.MAX_VALUE, totalMb));
            o.addProperty("available", (int) Math.max(0, Math.min(Integer.MAX_VALUE, freeMb)));
            o.addProperty("used", (int) Math.max(0, Math.min(Integer.MAX_VALUE, totalMb - freeMb)));
            // 启动器自己占的堆，百宝箱的「整理内存」要用它算前后差
            Runtime rt = Runtime.getRuntime();
            o.addProperty("jvmUsed", (rt.totalMemory() - rt.freeMemory()) / 1048576L);
        } catch (Exception e) {
            LOG.warning("Failed to read memory snapshot", e);
        }
        return JsonUtils.GSON.toJson(o);
    }

    private JsonObject javaSection() {
        JsonObject o = new JsonObject();
        try {
            GameSettings g = global();
            o.addProperty("javaType", g.javaTypeProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("customJavaPath", nullToEmpty(g.customJavaPathProperty().getValue()));
            o.addProperty("jvmOptions", nullToEmpty(g.jvmOptionsProperty().getValue()));
            o.addProperty("noJVMOptions", g.noJVMOptionsProperty().getValue());
            o.addProperty("noOptimizingJVMOptions", g.noOptimizingJVMOptionsProperty().getValue());
            o.addProperty("notUseJavaw", g.notUseJavawProperty().getValue());
            o.addProperty("notCheckJVM", g.notCheckJVMProperty().getValue());
        } catch (Exception e) {
            LOG.warning("Failed to read java settings", e);
        }
        o.add("list", javaListArray());
        return o;
    }

    private JsonObject gameSection() {
        JsonObject o = new JsonObject();
        try {
            GameSettings g = global();
            o.addProperty("autoMemory", g.autoMemoryProperty().getValue());
            Integer min = g.minMemoryProperty().getValue();
            Integer max = g.maxMemoryProperty().getValue();
            o.addProperty("minMemory", min == null ? 0 : min);
            o.addProperty("maxMemory", max == null ? 0 : max);
            // 物理内存三兄弟（MB）。前端的内存滑条要靠这三个值：
            // 总量决定滑条上界，空闲 + 已用决定三段条的长度比例。
            //
            // 必须用 com.sun.management.OperatingSystemMXBean，不能用
            // Runtime.getRuntime()：后者给的是 JVM 堆的余量，和物理内存完全两回事。
            var os = (com.sun.management.OperatingSystemMXBean)
                    java.lang.management.ManagementFactory.getOperatingSystemMXBean();
            long totalMb = os.getTotalMemorySize() / 1048576L;
            long freeMb = os.getFreeMemorySize() / 1048576L;
            o.addProperty("totalMemory", (int) Math.min(Integer.MAX_VALUE, totalMb));
            o.addProperty("availableMemory", (int) Math.max(0, Math.min(Integer.MAX_VALUE, freeMb)));
            o.addProperty("usedMemory", (int) Math.max(0, Math.min(Integer.MAX_VALUE, totalMb - freeMb)));

            o.addProperty("windowType", g.windowTypeProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("width", g.widthProperty().getValue());
            o.addProperty("height", g.heightProperty().getValue());
            o.addProperty("runningDirectory", nullToEmpty(g.runningDirectoryProperty().getValue()));
            o.addProperty("processPriority", g.processPriorityProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("launcherVisibility", g.launcherVisibilityProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("gameArguments", nullToEmpty(g.gameArgumentsProperty().getValue()));
            o.addProperty("notCheckGame", g.notCheckGameProperty().getValue());
            // 快速游玩：启动后直接进存档 / 直连服务器（对应 GameSettingsPage 的 quickSublist）
            o.addProperty("quickPlay", g.quickPlayProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            o.addProperty("quickPlaySingleplayer", nullToEmpty(g.quickPlaySingleplayerProperty().getValue()));
            o.addProperty("quickPlayMultiplayer", nullToEmpty(g.quickPlayMultiplayerProperty().getValue()));
            o.addProperty("allowAutoAgent", g.allowAutoAgentProperty().getValue());
            o.addProperty("disableAutoGameOptions", g.disableAutoGameOptionsProperty().getValue());
        } catch (Exception e) {
            LOG.warning("Failed to read game settings", e);
        }
        return o;
    }

    private static JsonArray javaListArray() {
        JsonArray arr = new JsonArray();
        try {
            Collection<JavaRuntime> all = JavaManager.getAllJavaProperty().get();
            List<JavaRuntime> list = new ArrayList<>(all == null ? List.of() : all);
            // 和 HMCL 的列表一致：按版本号从新到旧
            list.sort(Comparator.reverseOrder());
            for (JavaRuntime java : list) {
                JsonObject o = new JsonObject();
                o.addProperty("path", java.getBinary().toString());
                o.addProperty("version", java.getVersion());
                o.addProperty("vendor", java.getVendor());
                o.addProperty("arch", java.getArchitecture().getDisplayName());
                o.addProperty("jdk", java.isJDK());
                o.addProperty("managed", java.isManaged());
                arr.add(o);
            }
        } catch (Exception e) {
            LOG.warning("Failed to list java runtimes", e);
        }
        return arr;
    }

    // ==================== 写入 ====================

    void setLauncher(String key, String value) {
        try {
            var s = SettingsManager.settings();
            var u = SettingsManager.userSettings();
            switch (key == null ? "" : key) {
                case "language" -> {
                    SupportedLocale target = SupportedLocale.getSupportedLocales().stream()
                            .filter(l -> l.getName().equalsIgnoreCase(value))
                            .findFirst()
                            .orElse(SupportedLocale.DEFAULT);
                    s.languageProperty().set(target);
                }
                case "acceptPreviewUpdate" -> s.acceptPreviewUpdateProperty().set(bool(value));
                case "disableAutoUpdateDialog" -> s.disableAutoShowUpdateDialogProperty().set(bool(value));
                case "animationDisabled" -> s.animationDisabledProperty().set(bool(value));
                // 默认附加内容源（模组 / 资源包优先从哪个站找）
                case "defaultAddonSource" -> s.defaultAddonSourceProperty().set(nullToEmpty(value));
                case "logLines" -> s.logLinesProperty().set(positiveOrNull(value));
                case "logRetention" -> {
                    Integer days = positiveOrNull(value);
                    if (days != null) {
                        u.logRetentionProperty().set(days);
                    }
                }
                case "enableOfflineAccount" -> u.enableOfflineAccountProperty().set(bool(value));
                case "proxyType" -> s.proxyTypeProperty().set(switch (value == null ? "" : value) {
                    case "http" -> org.jackhuang.hmcl.setting.ProxyType.HTTP;
                    case "socks" -> org.jackhuang.hmcl.setting.ProxyType.SOCKS;
                    case "direct" -> org.jackhuang.hmcl.setting.ProxyType.DIRECT;
                    default -> org.jackhuang.hmcl.setting.ProxyType.SYSTEM;
                });
                case "proxyHost" -> s.proxyHostProperty().set(nullToEmpty(value));
                case "proxyPort" -> s.proxyPortProperty().set((int) Math.max(0, Math.min(65535, parseInt(value, 0))));
                case "proxyUser" -> s.proxyUserProperty().set(nullToEmpty(value));
                case "proxyPassword" -> s.proxyPasswordProperty().set(nullToEmpty(value));
                default -> LOG.warning("Unknown launcher setting: " + key);
            }
        } catch (Exception e) {
            LOG.warning("Failed to set launcher setting " + key, e);
        }
        pushAll();
    }

    void setGame(String key, String value) {
        try {
            GameSettings g = global();
            switch (key == null ? "" : key) {
                case "autoMemory" -> g.autoMemoryProperty().setValue(bool(value));
                case "minMemory" -> g.minMemoryProperty().setValue(clampMemory(value));
                case "maxMemory" -> g.maxMemoryProperty().setValue(clampMemory(value));
                case "windowType" -> g.windowTypeProperty().setValue(enumOr(value, GameWindowType.class, GameWindowType.WINDOWED));
                case "width" -> g.widthProperty().setValue(positiveDouble(value, 854.0));
                case "height" -> g.heightProperty().setValue(positiveDouble(value, 480.0));
                case "runningDirectory" -> g.runningDirectoryProperty().setValue(nullToEmpty(value));
                case "processPriority" -> g.processPriorityProperty().setValue(
                        enumOr(value, ProcessPriority.class, ProcessPriority.NORMAL));
                case "launcherVisibility" -> g.launcherVisibilityProperty().setValue(
                        enumOr(value, LauncherVisibility.class, LauncherVisibility.HIDE));
                case "gameArguments" -> g.gameArgumentsProperty().setValue(nullToEmpty(value));
                case "jvmOptions" -> g.jvmOptionsProperty().setValue(nullToEmpty(value));
                case "javaType" -> g.javaTypeProperty().setValue(enumOr(value, JavaVersionType.class, JavaVersionType.AUTO));
                case "customJavaPath" -> g.customJavaPathProperty().setValue(nullToEmpty(value));
                case "noJVMOptions" -> g.noJVMOptionsProperty().setValue(bool(value));
                case "noOptimizingJVMOptions" -> g.noOptimizingJVMOptionsProperty().setValue(bool(value));
                case "notUseJavaw" -> g.notUseJavawProperty().setValue(bool(value));
                case "notCheckJVM" -> g.notCheckJVMProperty().setValue(bool(value));
                case "notCheckGame" -> g.notCheckGameProperty().setValue(bool(value));
                case "allowAutoAgent" -> g.allowAutoAgentProperty().setValue(bool(value));
                case "disableAutoGameOptions" -> g.disableAutoGameOptionsProperty().setValue(bool(value));
                case "quickPlay" -> g.quickPlayProperty().setValue(
                        enumOr(value, org.jackhuang.hmcl.game.QuickPlayType.class,
                                org.jackhuang.hmcl.game.QuickPlayType.NONE));
                case "quickPlaySingleplayer" -> g.quickPlaySingleplayerProperty().setValue(nullToEmpty(value));
                case "quickPlayMultiplayer" -> g.quickPlayMultiplayerProperty().setValue(nullToEmpty(value));
                default -> LOG.warning("Unknown game setting: " + key);
            }
        } catch (Exception e) {
            LOG.warning("Failed to set game setting " + key, e);
        }
        pushAll();
    }

    // ==================== Java 运行时 ====================

    void refreshJava() {
        try {
            JavaManager.refresh();
        } catch (Exception e) {
            LOG.warning("Failed to refresh java list", e);
        }
        pushJavaList();
    }

    /// 添加一个 Java 可执行文件。任务在后台线程跑，完成后推列表。
    /// 打开启动器日志目录。HMCL 那边是 `FXUtils.openFolder(LOG.getLogFile().getParent())`，
    /// 壳模式没有 JavaFX 窗口，但 `openFolder` 走的是系统文件管理器，照样有效。
    public void openLogFolder() {
        try {
            // getLogFile() 返回 Path，FXUtils.openFolder 也吃 Path，直接取父目录
            java.nio.file.Path file = org.jackhuang.hmcl.util.logging.Logger.LOG.getLogFile();
            if (file == null || file.getParent() == null) {
                return;
            }
            org.jackhuang.hmcl.ui.FXUtils.openFolder(file.getParent());
        } catch (Exception e) {
            LOG.warning("Failed to open log folder", e);
        }
    }

    /// 导出日志（HMCL 的 settings.launcher.launcher_log.export）。
    ///
    /// 把整个 logs 目录打成 zip 放到下载目录，再在资源管理器里选中它——
    /// 用户拿到就是一个能直接发给开发者的文件，不用自己去翻 .hmcl/logs。
    public void exportLogs() {
        try {
            java.nio.file.Path logFile = org.jackhuang.hmcl.util.logging.Logger.LOG.getLogFile();
            if (logFile == null || logFile.getParent() == null) {
                return;
            }
            java.nio.file.Path logDir = logFile.getParent();
            java.nio.file.Path target = java.nio.file.Path.of(System.getProperty("user.home"), "Downloads")
                    .resolve("hmcl-logs-" + new java.text.SimpleDateFormat("yyyyMMdd-HHmmss").format(new java.util.Date())
                            + ".zip");

            org.jackhuang.hmcl.task.Task.runAsync(org.jackhuang.hmcl.task.Schedulers.io(), () -> {
                java.nio.file.Files.createDirectories(target.getParent());
                try (var zos = new java.util.zip.ZipOutputStream(java.nio.file.Files.newOutputStream(target));
                     var stream = java.nio.file.Files.walk(logDir)) {
                    for (java.nio.file.Path path : stream.toList()) {
                        if (!java.nio.file.Files.isRegularFile(path)) {
                            continue;
                        }
                        // zip 条目名必须用正斜杠，Windows 风格的反斜杠会让解压工具建出奇怪目录
                        String entryName = logDir.relativize(path).toString().replace(java.io.File.separatorChar, '/');
                        var entry = new java.util.zip.ZipEntry(entryName);
                        zos.putNextEntry(entry);
                        java.nio.file.Files.copy(path, zos);
                        zos.closeEntry();
                    }
                }
            }).whenComplete(org.jackhuang.hmcl.task.Schedulers.javafx(), exception -> {
                if (exception != null) {
                    LOG.warning("Failed to export logs", exception);
                    return;
                }
                org.jackhuang.hmcl.ui.FXUtils.showFileInExplorer(target);
            }).start();
        } catch (Exception e) {
            LOG.warning("Failed to export logs", e);
        }
    }

    /// 清理下载缓存（HMCL 的 launcher.cache_directory.clean）。
    ///
    /// 只清 cache/ 这一层，不动 libraries 和 assets——那两个删了要重新下载几百 MB。
    public void cleanCache() {
        try {
            var s = SettingsManager.settings();
            String dir = s.getResolvedCommonDirectory();
            if (dir == null || dir.isBlank()) {
                return;
            }
            java.nio.file.Path cache = java.nio.file.Path.of(dir, "cache");
            org.jackhuang.hmcl.task.Task.runAsync(org.jackhuang.hmcl.task.Schedulers.io(), () -> {
                org.jackhuang.hmcl.util.io.FileUtils.cleanDirectoryQuietly(cache);
            }).start();
        } catch (Exception e) {
            LOG.warning("Failed to clean cache", e);
        }
    }

    void addJava(String binary) {
        if (binary == null || binary.isBlank()) {
            return;
        }
        // 和 JavaManagementPage 一样：whenComplete 的回调已经在 FX 线程，
        // 直接在里面推新列表。start() 是异步的，不会卡住 HTTP 线程。
        JavaManager.getAddJavaTask(Path.of(binary.trim()))
                .whenComplete(org.jackhuang.hmcl.task.Schedulers.javafx(), exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to add java " + binary, exception);
                    }
                    pushAll();
                })
                .start();
    }

    void removeJava(String binary) {
        if (binary == null || binary.isBlank()) {
            return;
        }
        Task.runAsync(() -> {
            try {
                for (JavaRuntime java : JavaManager.getAllJavaProperty().get()) {
                    if (java.getBinary().toString().equals(binary)) {
                        JavaManager.removeJava(java);
                        break;
                    }
                }
            } catch (Exception e) {
                LOG.warning("Failed to remove java " + binary, e);
            }
            pushAll();
        }).start();
    }

    // ==================== 推送 ====================

    private void pushAll() {
        String json = snapshot();
        push("onSettings", json);
        push("onJavaList", JsonUtils.GSON.toJson(javaListArray()));
    }

    void requestJavaList() {
        pushJavaList();
    }

    private void pushJavaList() {
        push("onJavaList", JsonUtils.GSON.toJson(javaListArray()));
    }

    private void push(String callback, String jsonText) {
        String script = "window.__hmcl && window.__hmcl." + callback + "("
                + JsonUtils.GSON.toJson(jsonText) + ")";
        // 设置可能从 HTTP 线程改，DOM 操作要回 FX 线程
        if (Platform.isFxApplicationThread()) {
            executeJs.accept(script);
        } else {
            Platform.runLater(() -> executeJs.accept(script));
        }
    }

    // ==================== 工具 ====================

    private static GameSettings global() {
        return SettingsManager.getDefaultGameSettingsPresetOrCreate();
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    private static boolean bool(String value) {
        return "true".equalsIgnoreCase(value) || "1".equals(value);
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value == null ? "" : value.trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static Integer positiveOrNull(String value) {
        int n = parseInt(value, -1);
        return n > 0 ? n : null;
    }

    private static double positiveDouble(String value, double fallback) {
        try {
            double d = Double.parseDouble(value == null ? "" : value.trim());
            return d > 0 ? d : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    /// 内存夹到 256 MB ~ 物理内存。HMCL 启动时也会再夹一次，
    /// 这里先夹是为了界面能立刻回填真实值。
    private static Integer clampMemory(String value) {
        int mb = parseInt(value, 0);
        if (mb <= 0) {
            return null;
        }
        return Math.max(256, Math.min(65536, mb));
    }

    private static <E extends Enum<E>> E enumOr(String value, Class<E> type, E fallback) {
        if (value == null) {
            return fallback;
        }
        try {
            return Enum.valueOf(type, value.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return fallback;
        }
    }
}
