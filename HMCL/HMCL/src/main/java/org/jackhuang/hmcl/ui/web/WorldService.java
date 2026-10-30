/*
 * HopeStar-MCLab
 *
 * 世界（存档）管理：列表、打开目录、备份、重命名、删除。
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.World;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.FileUtils;
import org.jackhuang.hmcl.util.io.Zipper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 实例的「世界」标签背后的实现。
///
/// <p>移植自上游 `WorldListPage` / `WorldManagePage` 的核心能力，只做网页端够用的部分：
/// 列出 `saves/` 下的存档、打开所在目录、备份成 zip、重命名、删除（走系统回收站）。
/// 数据包（datapacks）这类子页面暂时没搬。
final class WorldService {

    private static final DateTimeFormatter BACKUP_STAMP =
            DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneId.systemDefault());

    /// 存档列表。按最后游玩时间倒序——用户找的几乎总是最近那个。
    static String list(HMCLGameInstance instance) {
        JsonObject root = new JsonObject();
        JsonArray items = new JsonArray();
        Path savesDir = instance.getSavesDirectory();
        root.addProperty("dir", savesDir.toString());

        List<World> worlds = new ArrayList<>();
        if (Files.isDirectory(savesDir)) {
            try (Stream<Path> paths = Files.list(savesDir)) {
                paths.filter(Files::isDirectory).forEach(dir -> {
                    // 只认带 level.dat 的目录：saves 下还可能有 .trash、datapacks 之类
                    if (!Files.isRegularFile(dir.resolve("level.dat"))) {
                        return;
                    }
                    try {
                        worlds.add(new World(dir));
                    } catch (Exception e) {
                        LOG.warning("Cannot read world " + dir, e);
                    }
                });
            } catch (IOException e) {
                root.addProperty("error", "读取存档目录失败：" + e.getMessage());
                return JsonUtils.GSON.toJson(root);
            }
        }

        worlds.sort(Comparator.comparingLong(World::getLastPlayed).reversed());
        for (World world : worlds) {
            items.add(toJson(instance, world));
        }
        root.add("worlds", items);
        return JsonUtils.GSON.toJson(root);
    }

    private static JsonObject toJson(HMCLGameInstance instance, World world) {
        JsonObject item = new JsonObject();
        item.addProperty("file", world.getFileName());
        item.addProperty("name", world.getWorldName());
        item.addProperty("lastPlayed", world.getLastPlayed());
        item.addProperty("locked", isLocked(world));
        item.addProperty("supportQuickPlay", world.supportQuickPlay());
        try {
            var version = world.getGameVersion();
            item.addProperty("version", version == null ? "" : version.toString());
        } catch (Exception ignored) {
            item.addProperty("version", "");
        }
        String icon = iconDataUrl(world);
        if (icon != null) {
            item.addProperty("icon", icon);
        }
        item.addProperty("backups", countBackups(instance, world));
        return item;
    }

    /// 存档图标直接读 `icon.png`：Minecraft 就把它放在存档根目录，
    /// 走 World#getIcon() 拿到的是 JavaFX Image，还得转一次，没必要。
    private static String iconDataUrl(World world) {
        Path icon = world.getFile().resolve("icon.png");
        try {
            if (!Files.isRegularFile(icon) || Files.size(icon) > 512 * 1024) {
                return null;
            }
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(Files.readAllBytes(icon));
        } catch (Throwable e) {
            return null;
        }
    }

    private static boolean isLocked(World world) {
        try {
            return world.isLocked();
        } catch (Throwable e) {
            return false;
        }
    }

    /// 备份目录：`<运行目录>/backups/<存档目录名>/`
    private static Path backupsDir(HMCLGameInstance instance, World world) {
        return instance.getRunDirectory().resolve("backups").resolve(world.getFileName());
    }

    private static int countBackups(HMCLGameInstance instance, World world) {
        Path dir = backupsDir(instance, world);
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (Stream<Path> paths = Files.list(dir)) {
            return (int) paths.filter(p -> p.getFileName().toString().endsWith(".zip")).count();
        } catch (IOException e) {
            return 0;
        }
    }

    /// 打开存档所在目录（选中该文件夹）。
    static void open(World world) {
        try {
            // 用 AWT 直接开资源管理器：这条路不依赖 FX 线程
            java.awt.Desktop.getDesktop().open(world.getFile().toFile());
        } catch (Throwable e) {
            LOG.warning("Cannot open world folder " + world.getFile(), e);
        }
    }

    /// 备份成 zip：和上游一致放在 `backups/<存档>/<存档>-<时间>.zip`。
    static String backup(HMCLGameInstance instance, World world) {
        Path dir = backupsDir(instance, world);
        Path target = dir.resolve(world.getFileName() + "-" + BACKUP_STAMP.format(Instant.now()) + ".zip");
        try {
            Files.createDirectories(dir);
            try (Zipper zipper = new Zipper(target)) {
                zipper.putDirectory(world.getFile(), world.getFileName());
            }
            return "{\"ok\":true,\"file\":\"" + escape(target.getFileName().toString()) + "\"}";
        } catch (Throwable e) {
            LOG.warning("Failed to back up world " + world.getFile(), e);
            return error("备份失败：" + e.getMessage());
        }
    }

    static String rename(World world, String newName) {
        if (newName == null || newName.isBlank()) {
            return error("名字不能为空");
        }
        String trimmed = newName.trim();
        // 目录名非法字符在 Windows 上会直接抛异常，先说清楚
        if (!trimmed.matches("[^\\\\/:*?\"<>|]+")) {
            return error("名字里不能有 \\ / : * ? \" < > |");
        }
        try {
            world.rename(trimmed);
            return "{\"ok\":true}";
        } catch (Throwable e) {
            LOG.warning("Failed to rename world " + world.getFile(), e);
            return error("重命名失败：" + e.getMessage());
        }
    }

    static String delete(World world) {
        try {
            Path dir = world.getFile();
            if (FileUtils.moveToTrash(dir)) {
                return "{\"ok\":true}";
            }
            // 系统不支持回收站时不敢直接删——先备份一份再删，是上游的做法
            return error("系统回收站不可用，已取消删除");
        } catch (Throwable e) {
            LOG.warning("Failed to delete world " + world.getFile(), e);
            return error("删除失败：" + e.getMessage());
        }
    }

    private static String error(String message) {
        return "{\"error\":\"" + escape(message) + "\"}";
    }

    private static String escape(String text) {
        StringBuilder builder = new StringBuilder();
        for (char c : text.toCharArray()) {
            switch (c) {
                case '"' -> builder.append("\\\"");
                case '\\' -> builder.append("\\\\");
                case '\n' -> builder.append("\\n");
                case '\r' -> builder.append("\\r");
                case '\t' -> builder.append("\\t");
                default -> {
                    if (c < 0x20) {
                        builder.append(String.format("\\u%04x", (int) c));
                    } else {
                        builder.append(c);
                    }
                }
            }
        }
        return builder.toString();
    }

    private WorldService() {
    }
}
