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
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.modpack.ModAdviser;
import org.jackhuang.hmcl.modpack.Modpack;
import org.jackhuang.hmcl.modpack.ModpackExportInfo;
import org.jackhuang.hmcl.modpack.mcbbs.McbbsModpackExportTask;
import org.jackhuang.hmcl.modpack.modrinth.ModrinthModpackExportTask;
import org.jackhuang.hmcl.modpack.server.ServerModpackExportTask;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import java.util.zip.Deflater;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 导出：实例整包、单个存档、整合包。
///
/// <p>实例和存档走同一个 zip 循环（要进度、要跳过 logs 这种垃圾），
/// 整合包交给 HMCL 自己的导出任务（三种格式：Modrinth .mrpack / 启动器通用 zip / 服务端包）。
final class ExportService {

    private final Consumer<String> push;

    /// 任务进度（`onInstallStage`）的唯一出口，见 `TaskProgress`
    private final TaskProgress progress;

    ExportService(Consumer<String> push) {
        this.push = push;
        this.progress = new TaskProgress(push);
    }

    // ==================== 实例 ====================

    /// 把整个实例目录打成 zip。
    ///
    /// <p>跳过日志、崩溃报告、存档备份和缓存：这些要么没意义要么几百 MB，
    /// 用户导出实例是为了搬走或备份，不是为了带走一堆日志。
    void exportInstance(String instanceId, Path target) {
        String taskId = "export:" + instanceId + ":" + System.currentTimeMillis();
        Task.runAsync(() -> {
            try {
                HMCLGameInstance instance = instanceOf(instanceId);
                if (instance == null) {
                    throw new IOException("找不到这个实例");
                }
                pushStage(taskId, "准备打包…", false, null, -1);
                zipDirectory(instance.getInstanceRoot(), target, "", taskId, ExportService::skipInstanceEntry);
                finish(taskId, target, "实例");
            } catch (Throwable e) {
                fail(taskId, target, e);
            }
        }).start();
    }

    /// 实例目录里不值得打包的部分（相对路径，`/` 分隔）。
    private static boolean skipInstanceEntry(String relative) {
        String lower = relative.toLowerCase(Locale.ROOT);
        return lower.startsWith("logs/")
                || lower.startsWith("crash-reports/")
                || lower.startsWith("backups/")
                || lower.startsWith(".hmcl/cache/")
                // Fabric 启动时把模组处理过的副本放这儿，下次启动会重建，
                // 一个中等整合包能占几十 MB，导出时没必要带上
                || lower.startsWith(".fabric/processedmods/")
                // 启动时解压出来的原生库
                || lower.startsWith("natives-")
                || lower.startsWith("downloads/")
                || lower.equals("logs")
                || lower.equals("crash-reports")
                || lower.equals("backups")
                || lower.equals("authlib-injector.log");
    }

    // ==================== 存档 ====================

    /// 把 `saves/<存档>` 打成 zip，压缩包里带一层存档目录名，
    /// 解压出来就是「一个能直接丢进 saves 的文件夹」。
    void exportWorld(String instanceId, String worldName, Path target) {
        String taskId = "export:" + instanceId + ":" + System.currentTimeMillis();
        Task.runAsync(() -> {
            try {
                HMCLGameInstance instance = instanceOf(instanceId);
                if (instance == null) {
                    throw new IOException("找不到这个实例");
                }
                if (worldName == null || worldName.isBlank()
                        || worldName.contains("..") || worldName.contains("/") || worldName.contains("\\")) {
                    throw new IOException("存档目录名不合法");
                }
                Path dir = instance.getSavesDirectory().resolve(worldName);
                if (!Files.isDirectory(dir)) {
                    throw new IOException("存档不存在：" + worldName);
                }
                pushStage(taskId, "准备打包…", false, null, -1);
                zipDirectory(dir, target, worldName + "/", taskId, rel -> false);
                finish(taskId, target, "存档");
            } catch (Throwable e) {
                fail(taskId, target, e);
            }
        }).start();
    }

    // ==================== 整合包 ====================

    /// 导出整合包。
    ///
    /// @param format `mrpack`（Modrinth，跨启动器）/ `mcbbs`（启动器通用 zip）/ `server`（服务端包）
    void exportModpack(String instanceId, String format, Path target,
                       String name, String version, String author, String description) {
        String taskId = "export:" + instanceId + ":" + System.currentTimeMillis();
        Task.runAsync(() -> {
            try {
                HMCLGameInstance instance = instanceOf(instanceId);
                if (instance == null) {
                    throw new IOException("找不到这个实例");
                }

                ModpackExportInfo info = new ModpackExportInfo();
                info.setName(blankTo(name, instance.getId().toString()));
                info.setVersion(blankTo(version, "1.0"));
                info.setAuthor(blankTo(author, "HopeStar"));
                info.setDescription(description == null ? "" : description);
                // 白名单不是可选项：Modrinth 导出任务只处理白名单里的文件，
                // 留空的话所有模组都会被塞进 overrides（既大又失去「按需下载」的意义），
                // 而且 saves / natives 也会被打进包里。这里先算一份「整合包该带什么」。
                info.setWhitelist(buildWhitelist(instance.getRunDirectory(), instance.getId().toString()));

                String kind = format == null ? "mrpack" : format.trim().toLowerCase(Locale.ROOT);
                Task<?> exportTask = switch (kind) {
                    case "server" -> new ServerModpackExportTask(instance, info, target);
                    case "mcbbs" -> new McbbsModpackExportTask(instance, info, target);
                    default -> new ModrinthModpackExportTask(instance, info, target);
                };

                pushStage(taskId, "正在整理整合包…", false, null, -1);
                AtomicReference<Throwable> lastError = attachProgress(exportTask, taskId);
                exportTask.onDone().register(event -> Platform.runLater(() -> {
                    if (event.isFailed()) {
                        Throwable cause = lastError.get();
                        String message = cause == null ? "未知错误" : shortMessage(cause);
                        pushStage(taskId, "导出失败：" + message, true, String.valueOf(cause), -1);
                        deleteQuietly(target);
                        return;
                    }
                    finishNow(taskId, target, "整合包");
                }));
                exportTask.executor().start();
            } catch (Throwable e) {
                fail(taskId, target, e);
            }
        }).start();
    }

    /// 整合包该包含哪些文件（相对路径，`/` 分隔）。
    ///
    /// <p>只收 `mods` / `resourcepacks` / `shaderpacks` / `config` 四个目录，
    /// 加上根目录里的散文件（options.txt、servers.dat 这类）。存档、日志、
    /// 解压出来的 natives、Fabric 的处理缓存都不算整合包内容。
    private static List<String> buildWhitelist(Path runDirectory, String instanceId) {
        List<String> blackList = new ArrayList<>(ModAdviser.MODPACK_BLACK_LIST);
        blackList.add(instanceId + ".jar");
        blackList.add(instanceId + ".json");

        List<String> out = new ArrayList<>();
        for (String dir : new String[]{"mods", "resourcepacks", "shaderpacks", "config"}) {
            Path dirPath = runDirectory.resolve(dir);
            if (!Files.isDirectory(dirPath)) {
                continue;
            }
            try (var stream = Files.walk(dirPath)) {
                for (Path p : stream.toList()) {
                    String relative = runDirectory.relativize(p).toString().replace('\\', '/');
                    // 目录也要进白名单：putDirectory 是先按目录名过滤再递归的，
                    // 只放文件的话整个 config/ 会被判成「不要」而整棵跳过
                    if (Files.isDirectory(p)) {
                        out.add(relative);
                        continue;
                    }
                    if (Files.isRegularFile(p) && Modpack.acceptFile(relative, blackList, List.of())) {
                        out.add(relative);
                    }
                }
            } catch (IOException e) {
                LOG.warning("Failed to list " + dirPath, e);
            }
        }

        try (var stream = Files.list(runDirectory)) {
            for (Path p : stream.toList()) {
                if (!Files.isRegularFile(p)) {
                    continue;
                }
                String name = p.getFileName().toString();
                if (name.equals(instanceId + ".jar") || name.equals(instanceId + ".json")
                        || name.endsWith(".log") || name.startsWith(".abnormal")
                        || name.equals("session.lock")) {
                    continue;
                }
                if (Modpack.acceptFile(name, blackList, List.of())) {
                    out.add(name);
                }
            }
        } catch (IOException e) {
            LOG.warning("Failed to list " + runDirectory, e);
        }
        return out;
    }

    // ==================== 压缩 ====================

    /// 把一个目录压成 zip，按字节数推进度。
    ///
    /// <p>用 `ZipOutputStream` 而不是 `Zipper`：后者没有进度回调，
    /// 一个 2 GB 的实例打包时界面会一动不动十分钟。
    private void zipDirectory(Path source, Path target, String prefix, String taskId,
                              Predicate<String> skip) throws IOException {
        List<Path> files = new ArrayList<>();
        long totalBytes = 0;
        try (var stream = Files.walk(source)) {
            for (Path p : stream.toList()) {
                if (!Files.isRegularFile(p)) {
                    continue;
                }
                String relative = source.relativize(p).toString().replace('\\', '/');
                if (skip != null && skip.test(relative)) {
                    continue;
                }
                files.add(p);
                try {
                    totalBytes += Files.size(p);
                } catch (IOException ignored) {
                }
            }
        }
        if (totalBytes <= 0) {
            totalBytes = 1;
        }

        Path parent = target.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }

        byte[] buffer = new byte[64 * 1024];
        long written = 0;
        long lastPush = 0;
        try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(target))) {
            zos.setLevel(Deflater.DEFAULT_COMPRESSION);
            for (Path file : files) {
                String relative = source.relativize(file).toString().replace('\\', '/');
                zos.putNextEntry(new ZipEntry(prefix + relative));
                try (var in = Files.newInputStream(file)) {
                    int n;
                    while ((n = in.read(buffer)) > 0) {
                        zos.write(buffer, 0, n);
                        written += n;
                        // 每 4 MB 推一次，几千个文件的实例也不会把前端刷爆
                        if (written - lastPush > 4L * 1024 * 1024) {
                            lastPush = written;
                            pushStage(taskId, "正在打包 " + relative, false, null,
                                    Math.min(0.99, (double) written / totalBytes));
                        }
                    }
                }
                zos.closeEntry();
            }
        }
    }

    // ==================== 结果 ====================

    private void finish(String taskId, Path target, String what) {
        finishNow(taskId, target, what);
    }

    private void finishNow(String taskId, Path target, String what) {
        long size = 0;
        try {
            size = Files.size(target);
        } catch (IOException ignored) {
        }
        pushStage(taskId, what + "已导出", true, null, 1);

        JsonObject done = new JsonObject();
        done.addProperty("ok", true);
        done.addProperty("path", target.toAbsolutePath().toString());
        done.addProperty("size", size);
        done.addProperty("what", what);
        String text = JsonUtils.GSON.toJson(done);
        push.accept("window.__hmcl && window.__hmcl.onExportDone("
                + JsonUtils.GSON.toJson(text) + ")");
    }

    private void fail(String taskId, Path target, Throwable e) {
        LOG.warning("Export failed: " + target, e);
        deleteQuietly(target);
        pushStage(taskId, "导出失败：" + shortMessage(e), true, String.valueOf(e), -1);
    }

    // ==================== 杂项 ====================

    private static HMCLGameInstance instanceOf(String instanceId) {
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            return repository == null ? null : repository.getInstance(new GameInstanceID(instanceId));
        } catch (Throwable e) {
            return null;
        }
    }

    private static String blankTo(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static String shortMessage(Throwable e) {
        String message = e.getMessage();
        if (message == null || message.isBlank()) {
            message = e.getClass().getSimpleName();
        }
        return shorten(message);
    }

    /// 任务名常常是整段堆栈，推给前端前只留第一行再限长。
    private static String shorten(String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.strip();
        int newline = text.indexOf('\n');
        if (newline > 0) {
            text = text.substring(0, newline).strip();
        }
        return text.length() > 160 ? text.substring(0, 160) + "…" : text;
    }

    private static void deleteQuietly(Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (Throwable ignored) {
        }
    }

    // ==================== 进度通道 ====================

    /// `TaskProgress` 的薄封装，调用点保持不变，实现只有一份。
    private AtomicReference<Throwable> attachProgress(Task<?> task, String taskId) {
        return progress.attach(task, taskId);
    }

    private void pushStage(String id, String stage, boolean done, String error, double percent) {
        progress.stage(id, stage, done, error, percent);
    }
}
