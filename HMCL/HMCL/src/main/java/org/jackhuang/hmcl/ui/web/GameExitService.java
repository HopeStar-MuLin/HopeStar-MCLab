/*
 * HopeStar-MCLab
 *
 * 游戏退出后的数据保全：自动备份这一局动过的存档、记录游玩时长。
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.launch.ProcessListener.ExitType;
import org.jackhuang.hmcl.setting.LauncherSettings;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.Zipper;
import org.jetbrains.annotations.NotNullByDefault;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 游戏进程退出后的收尾。
///
/// <p>做两件事，都要求**在启动器收尾之前**做完（见 [org.jackhuang.hmcl.game.LauncherHelper.ExitListener]）：
///
/// 1. **自动备份这一局动过的存档**。判断依据是 `level.dat` 的修改时间晚于启动时刻，
///    所以没进过的世界不会每次都重压一遍 —— 一个 2 GB 的存档目录每次启动都备份是不可接受的。
/// 2. **记录游玩时长**。顺带把「上次玩到几点」存下来，首页的时长统计以后可以直接读。
///
/// <p>备份落在 `<运行目录>/backups/<存档名>/<存档名>-<时间戳>.zip`，和手动备份同一个位置，
/// 所以实例页的「存档」标签里能直接看到份数，不用另建一套索引。
///
/// <p>崩溃退出（[ExitType#JVM_ERROR] 等）会在文件名里带 `-crash`，方便事后分辨
/// 「这份是正常退出时的状态，还是崩之前的状态」。
@NotNullByDefault
final class GameExitService {

    private static final DateTimeFormatter STAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneId.systemDefault());

    /// 单次备份的体积上限。超过就不压，只提示 —— 一个几十 GB 的存档目录压起来要几分钟，
    /// 而这时候用户已经关掉游戏了，让启动器干等着更糟。
    private static final long MAX_BACKUP_BYTES = 2L * 1024 * 1024 * 1024;

    /// 注册用的单例守卫。`BridgeServices` 每次构造都会 new 一个，
    /// 但退出回调只能挂一次，否则同一局会被备份两遍。
    private static final AtomicBoolean REGISTERED = new AtomicBoolean();
    private static volatile GameExitService INSTANCE;

    private final Consumer<String> js;

    /// 实例 id → 这一局的启动时刻。退出时用来判断哪些存档被动过。
    private final Map<String, Long> startedAt = new ConcurrentHashMap<>();

    private final Object playtimeLock = new Object();

    GameExitService(Consumer<String> js) {
        this.js = js;
    }

    /// 挂到 [org.jackhuang.hmcl.game.LauncherHelper] 上。
    ///
    /// <p>监听器只挂一次（[#REGISTERED] 守卫），但 [#INSTANCE] 每次都会指向最新构造的那个 ——
    /// 这样即使 Web 层重建，回调也不会打到已经废弃的实例上。
    static void register(GameExitService service) {
        INSTANCE = service;
        if (!REGISTERED.compareAndSet(false, true)) {
            return;
        }
        org.jackhuang.hmcl.game.LauncherHelper.addExitListener((instance, exitCode, exitType) -> {
            GameExitService current = INSTANCE;
            if (current != null) {
                current.onExit(instance, exitCode, exitType);
            }
        });
    }

    /// 记下启动时刻。`WebBridge.startInstance` 在真正拉起进程之后调。
    void markLaunched(String instanceId) {
        startedAt.put(instanceId, System.currentTimeMillis());
    }

    /// 游戏退出。**在游戏进程已经结束、启动器开始收尾之前同步执行**，
    /// 所以这里的耗时会计入「关游戏到启动器有反应」的间隔，别做没必要的重活。
    void onExit(HMCLGameInstance instance, int exitCode, ExitType exitType) {
        String instanceId = instance.getId().toString();
        Long started = startedAt.remove(instanceId);
        long now = System.currentTimeMillis();
        long duration = started == null ? 0 : Math.max(0, now - started);
        boolean crashed = exitType != ExitType.NORMAL;

        JsonObject result = new JsonObject();
        result.addProperty("instanceId", instanceId);
        result.addProperty("exitCode", exitCode);
        result.addProperty("type", exitType.name());
        result.addProperty("crashed", crashed);
        result.addProperty("durationMs", duration);

        try {
            result.addProperty("totalMs", addPlaytime(instanceId, duration));
        } catch (Throwable e) {
            LOG.warning("Failed to record playtime for " + instanceId, e);
        }

        try {
            JsonArray backups = new JsonArray();
            JsonArray skipped = new JsonArray();
            backupWorlds(instance, started, crashed, backups, skipped);
            result.add("backups", backups);
            if (!skipped.isEmpty()) {
                result.add("skipped", skipped);
            }
        } catch (Throwable e) {
            LOG.warning("Failed to back up worlds of " + instanceId, e);
            result.addProperty("backupError", String.valueOf(e.getMessage()));
        }

        // 参数必须是一段 JSON 文本（`toJson(String)` 会再套一层引号），
        // 直接传 JsonObject 会变成对象字面量，前端 JSON.parse 拿到 object 会抛。
        push("window.__hmcl && window.__hmcl.onGameExited("
                + JsonUtils.GSON.toJson(result.toString()) + ")");
    }

    /// 备份这一局动过的存档。
    ///
    /// @param started 启动时刻；为 null（比如从外部启动的）时退化成「全部备份一遍」
    private void backupWorlds(HMCLGameInstance instance, Long started, boolean crashed,
                              JsonArray backups, JsonArray skipped) throws IOException {
        LauncherSettings settings = SettingsManager.settings();
        if (!Boolean.TRUE.equals(settings.autoBackupOnExitProperty().get())) {
            return;
        }

        Path saves = instance.getSavesDirectory();
        if (!Files.isDirectory(saves)) {
            return;
        }

        int keep = Math.max(1, Math.min(50, settings.backupKeepProperty().get()));
        List<Path> worlds = new ArrayList<>();
        try (Stream<Path> stream = Files.list(saves)) {
            stream.filter(Files::isDirectory).forEach(worlds::add);
        }

        for (Path world : worlds) {
            Path level = world.resolve("level.dat");
            if (!Files.isRegularFile(level)) {
                continue;
            }
            // 这一局没进过这个世界：level.dat 的修改时间还停在启动之前。
            // 留 2 秒余量 —— 文件系统的时间精度和 NTP 校时都可能带来抖动。
            if (started != null && Files.getLastModifiedTime(level).toMillis() < started - 2000) {
                continue;
            }

            String name = world.getFileName().toString();
            long size = directorySize(world);
            if (size > MAX_BACKUP_BYTES) {
                JsonObject item = new JsonObject();
                item.addProperty("world", name);
                item.addProperty("size", size);
                skipped.add(item);
                continue;
            }

            Path dir = instance.getRunDirectory().resolve("backups").resolve(name);
            Files.createDirectories(dir);
            String fileName = name + "-" + STAMP.format(Instant.now()) + (crashed ? "-crash" : "") + ".zip";
            Path target = dir.resolve(fileName);

            try (Zipper zipper = new Zipper(target)) {
                // session.lock 是游戏进程的独占标记，备份里带着它没有意义，还原时还会挡路
                zipper.putDirectory(world, name, path -> !"session.lock".equals(path));
            }

            JsonObject item = new JsonObject();
            item.addProperty("world", name);
            item.addProperty("file", fileName);
            item.addProperty("size", Files.size(target));
            backups.add(item);

            prune(dir, keep);
        }
    }

    /// 只留最近 [keep] 份。按修改时间排，不按文件名 —— 带 `-crash` 后缀的那些
    /// 排序会和普通备份错开，按名字取会删错。
    private void prune(Path dir, int keep) {
        try (Stream<Path> stream = Files.list(dir)) {
            List<Path> zips = stream
                    .filter(p -> p.getFileName().toString().endsWith(".zip"))
                    .sorted(Comparator.comparingLong(this::mtime).reversed())
                    .toList();
            for (int i = keep; i < zips.size(); i++) {
                try {
                    Files.deleteIfExists(zips.get(i));
                } catch (IOException e) {
                    LOG.warning("Failed to delete old backup " + zips.get(i), e);
                }
            }
        } catch (IOException e) {
            LOG.warning("Failed to list backups in " + dir, e);
        }
    }

    private long mtime(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0;
        }
    }

    private long directorySize(Path dir) {
        try (Stream<Path> stream = Files.walk(dir)) {
            return stream.filter(Files::isRegularFile).mapToLong(p -> {
                try {
                    return Files.size(p);
                } catch (IOException e) {
                    return 0;
                }
            }).sum();
        } catch (IOException e) {
            return 0;
        }
    }

    /// 累加游玩时长，返回累计毫秒。
    ///
    /// <p>存 `data/state/playtime.json`：`{ "<实例 id>": { "totalMs":..., "sessions":..., "lastExit":... } }`。
    /// 写得很稀疏（一局一次），不值得上数据库；用临时文件 + 原子替换防止写一半断电。
    private long addPlaytime(String instanceId, long durationMs) throws IOException {
        if (durationMs <= 0) {
            return readTotal(instanceId);
        }
        synchronized (playtimeLock) {
            Path file = Metadata.HMCL_USER_HOME.resolve("state").resolve("playtime.json");
            JsonObject root = new JsonObject();
            if (Files.isRegularFile(file)) {
                try {
                    String text = Files.readString(file, StandardCharsets.UTF_8);
                    if (!text.isBlank()) {
                        root = JsonParser.parseString(text).getAsJsonObject();
                    }
                } catch (Throwable e) {
                    // 文件坏了就重来，不要因为一个统计文件起不来
                    LOG.warning("Corrupted playtime.json, resetting", e);
                    root = new JsonObject();
                }
            }

            JsonObject entry = root.has(instanceId) && root.get(instanceId).isJsonObject()
                    ? root.getAsJsonObject(instanceId)
                    : new JsonObject();
            long total = (entry.has("totalMs") ? entry.get("totalMs").getAsLong() : 0L) + durationMs;
            int sessions = (entry.has("sessions") ? entry.get("sessions").getAsInt() : 0) + 1;

            entry.addProperty("totalMs", total);
            entry.addProperty("sessions", sessions);
            entry.addProperty("lastExit", System.currentTimeMillis());
            entry.addProperty("lastDurationMs", durationMs);
            root.add(instanceId, entry);

            Files.createDirectories(file.getParent());
            Path tmp = file.resolveSibling("playtime.json.tmp");
            Files.writeString(tmp, JsonUtils.GSON.toJson(root), StandardCharsets.UTF_8);
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            return total;
        }
    }

    private long readTotal(String instanceId) {
        try {
            Path file = Metadata.HMCL_USER_HOME.resolve("state").resolve("playtime.json");
            if (!Files.isRegularFile(file)) {
                return 0;
            }
            JsonObject root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            return root.has(instanceId) && root.get(instanceId).isJsonObject()
                    ? root.getAsJsonObject(instanceId).get("totalMs").getAsLong()
                    : 0;
        } catch (Throwable e) {
            return 0;
        }
    }

    private void push(String script) {
        try {
            js.accept(script);
        } catch (Throwable e) {
            LOG.warning("Failed to push game exit event", e);
        }
    }
}
