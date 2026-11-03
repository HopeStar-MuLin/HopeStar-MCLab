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

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import javafx.application.Platform;
import org.jackhuang.hmcl.download.DefaultDependencyManager;
import org.jackhuang.hmcl.download.game.GameLibrariesTask;
import org.jackhuang.hmcl.game.AssetIndex;
import org.jackhuang.hmcl.game.AssetIndexInfo;
import org.jackhuang.hmcl.game.AssetObject;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.GameInstanceManifest;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.game.Library;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 游戏文件完整性检查与修复。
///
/// <p>检查三种东西：客户端 jar、libraries、assets。缺哪个补哪个 —— 修复本身
/// 交给 `DefaultDependencyManager.checkGameCompletionAsync(..., integrityCheck=true)`，
/// 那是 HMCL 启动前跑的那套，会逐文件校验 SHA-1 并把损坏的重新下。
///
/// <p>扫描和修复分开：扫描不联网、只 stat 文件，几百毫秒内出结果；用户看完
/// 「缺 6 个文件、约 12 MB」再决定要不要下。
final class GameIntegrityService {

    private final Consumer<String> push;

    /// 任务进度（`onInstallStage`）的唯一出口，见 `TaskProgress`
    private final TaskProgress progress;

    GameIntegrityService(Consumer<String> push) {
        this.push = push;
        this.progress = new TaskProgress(push);
    }

    // ==================== 扫描 ====================

    /// 扫一遍实例依赖的文件，返回缺失清单。
    ///
    /// <p>只查「在不在、大小对不对」：几百个 library 逐个算 SHA-1 要好几秒，
    /// 放在点按钮的这一刻不合适。真正修复时 HMCL 自己会做深度校验。
    static String scan(String instanceId) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            if (repository == null) {
                throw new IOException("没有可用的游戏目录");
            }
            HMCLGameInstance instance = repository.getInstance(new GameInstanceID(instanceId));
            GameInstanceManifest manifest = instance.getResolvedManifest();
            var layout = repository.getLayout();

            int missing = 0;
            long downloadSize = 0;

            // 1) 客户端 jar。Fabric/Forge 实例的 jar 是安装器二次生成的，
            //    和官方 client 的 sha1 对不上，所以只查存在性和非空。
            Path jar = instance.getInstanceJarFile();
            boolean jarOk = Files.isRegularFile(jar) && Files.size(jar) > 0;
            JsonObject jarJson = new JsonObject();
            jarJson.addProperty("ok", jarOk);
            jarJson.addProperty("file", jar.getFileName().toString());
            if (jarOk) {
                jarJson.addProperty("size", Files.size(jar));
            } else {
                missing++;
                if (manifest.getDownloadInfo() != null) {
                    downloadSize += manifest.getDownloadInfo().getSize();
                }
            }
            root.add("jar", jarJson);

            // 2) libraries
            JsonArray libItems = new JsonArray();
            int libTotal = 0;
            int libMissing = 0;
            for (Library library : manifest.getLibraries()) {
                boolean need;
                try {
                    // 和 GameLibrariesTask.execute 的过滤保持一致：
                    // 一、其它平台的 native 库（linux/macos 的 netty、jogl）不参与本机运行；
                    // 二、没有下载地址的库是安装器现场生成的（Forge 的 patched jar 之类），
                    //     它们不该出现在「缺失」里，否则扫出来一片红但其实一切正常。
                    if (!library.appliesToCurrentEnvironment()) {
                        continue;
                    }
                    if (!library.hasDownloadURL() && !"optifine".equals(library.groupId())) {
                        continue;
                    }
                    libTotal++;
                    // integrityCheck=false：只判断文件在不在，和修复阶段的判断口径一致
                    need = GameLibrariesTask.shouldDownloadLibrary(repository, manifest, library, false);
                } catch (Throwable e) {
                    continue;
                }
                if (!need) {
                    continue;
                }
                libMissing++;
                long size = library.getDownload() != null ? library.getDownload().getSize() : 0;
                downloadSize += Math.max(0, size);
                if (libItems.size() < 40) {
                    JsonObject o = new JsonObject();
                    var artifact = library.artifact();
                    o.addProperty("name", artifact.getGroup() + ":" + artifact.getName()
                            + ":" + artifact.getVersion());
                    o.addProperty("size", size);
                    libItems.add(o);
                }
            }
            JsonObject libs = new JsonObject();
            libs.addProperty("total", libTotal);
            libs.addProperty("missing", libMissing);
            libs.add("items", libItems);
            root.add("libraries", libs);
            missing += libMissing;

            // 3) assets。1.6 以前没有索引，跳过。
            JsonArray assetItems = new JsonArray();
            int assetTotal = 0;
            int assetMissing = 0;
            boolean indexOk = true;
            AssetIndexInfo indexInfo = manifest.getAssetIndex();
            if (indexInfo != null && indexInfo.getId() != null && !indexInfo.getId().isBlank()) {
                Path indexFile = layout.getAssetIndexFile(indexInfo.getId());
                if (!Files.isRegularFile(indexFile)) {
                    indexOk = false;
                    missing++;
                    downloadSize += 1024 * 1024; // 索引本身通常 1 MB 上下
                } else {
                    try {
                        AssetIndex index = JsonUtils.fromNonNullJson(
                                Files.readString(indexFile), AssetIndex.class);
                        for (Map.Entry<String, AssetObject> e : index.getObjects().entrySet()) {
                            assetTotal++;
                            Path file = layout.getAssetObject(e.getValue());
                            if (Files.isRegularFile(file)) {
                                continue;
                            }
                            assetMissing++;
                            downloadSize += e.getValue().size();
                            if (assetItems.size() < 40) {
                                JsonObject o = new JsonObject();
                                o.addProperty("name", e.getKey());
                                o.addProperty("size", e.getValue().size());
                                assetItems.add(o);
                            }
                        }
                    } catch (Throwable e) {
                        // 索引读不出来等于坏了，修复时会重新下
                        indexOk = false;
                        missing++;
                        LOG.warning("Failed to read asset index of " + instanceId, e);
                    }
                }
            }
            JsonObject assets = new JsonObject();
            assets.addProperty("total", assetTotal);
            assets.addProperty("missing", assetMissing);
            assets.addProperty("indexOk", indexOk);
            assets.addProperty("indexId", indexInfo == null ? "" : indexInfo.getId());
            assets.add("items", assetItems);
            root.add("assets", assets);
            missing += assetMissing;

            root.addProperty("ok", true);
            root.addProperty("missing", missing);
            root.addProperty("downloadSize", downloadSize);
            root.addProperty("checkedAt", System.currentTimeMillis());
            return JsonUtils.GSON.toJson(root);
        } catch (Throwable e) {
            LOG.warning("Failed to scan game integrity of " + instanceId, e);
            root.addProperty("ok", false);
            root.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(root);
        }
    }

    // ==================== 修复 ====================

    /// 补全缺失和损坏的文件。
    ///
    /// <p>走 `checkGameCompletionAsync(..., true)`：它会先把客户端 jar 补上，
    /// 再逐个校验 libraries 和 assets 的 SHA-1，损坏的重新下。进度推给右上角
    /// 那条任务，完成后再通知前端刷新。
    void fix(String instanceId) {
        String taskId = "integrity:" + instanceId;
        Task.runAsync(() -> {
            try {
                HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
                if (repository == null) {
                    throw new IOException("没有可用的游戏目录");
                }
                HMCLGameInstance instance = repository.getInstance(new GameInstanceID(instanceId));
                DefaultDependencyManager dependency = repository.getDependency();
                Task<?> task = dependency.checkGameCompletionAsync(
                        instance, instance.getResolvedManifest(), true);

                pushStage(taskId, "正在校验游戏文件…", false, null, -1);
                AtomicReference<Throwable> lastError = attachProgress(task, taskId);
                task.onDone().register(event -> Platform.runLater(() -> {
                    if (event.isFailed()) {
                        Throwable cause = lastError.get();
                        String message = cause == null ? "未知错误" : shortStage(String.valueOf(cause));
                        pushStage(taskId, "修复失败：" + message, true, String.valueOf(cause), -1);
                        return;
                    }
                    pushStage(taskId, "游戏文件已补全", true, null, 1);
                    JsonObject done = new JsonObject();
                    done.addProperty("ok", true);
                    done.addProperty("instanceId", instanceId);
                    String text = JsonUtils.GSON.toJson(done);
                    push.accept("window.__hmcl && window.__hmcl.onGameIntegrityFixed("
                            + JsonUtils.GSON.toJson(text) + ")");
                }));
                task.executor().start();
            } catch (Throwable e) {
                LOG.warning("Failed to fix game files of " + instanceId, e);
                pushStage(taskId, "修复失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage()),
                        true, String.valueOf(e), -1);
            }
        }).start();
    }

    // ==================== 进度通道 ====================

    /// `TaskProgress` 的薄封装，调用点保持不变，实现只有一份。
    private AtomicReference<Throwable> attachProgress(Task<?> task, String taskId) {
        return progress.attach(task, taskId);
    }

    private void pushStage(String id, String stage, boolean done, String error, double percent) {
        progress.stage(id, stage, done, error, percent);
    }

    private static String shortStage(String raw) {
        return TaskProgress.shorten(raw);
    }
}
