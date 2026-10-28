/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026 huangyuhui <huanghongxun2008@126.com> and contributors
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
import org.jackhuang.hmcl.download.ComponentRemoteVersion;
import org.jackhuang.hmcl.util.versioning.GameVersionNumber;
import org.jackhuang.hmcl.setting.DownloadProviders;
import org.jackhuang.hmcl.download.game.GameRemoteVersion;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameBuilder;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.List;
import java.util.function.Consumer;

import org.jetbrains.annotations.Nullable;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 下载页的数据与安装入口。
///
/// <p>只做三件事：拉版本清单、把清单转成前端能吃的 JSON、调用 HMCL 原有的
/// {@link HMCLGameBuilder} 装版本。**不重写下载逻辑**——多源候选、sha1 校验、
/// 失败重试、资源索引都在 `HMCLCore` 里，重写一遍只会引入新的边界 bug。
///
/// <p>前端契约（都在 `window.__hmcl` 上）：
/// <ul>
///   <li>`onVersions(json)`：版本清单，`{id, type, date, installed}` 数组</li>
///   <li>`onInstallStage(json)`：安装进度，`{id, stage, done, error}`</li>
/// </ul>
final class DownloadService {

    /// 推 JS 到页面的回调（由 {@link WebBridge} 提供，带异常兜底）
    private final Consumer<String> push;

    /// 上次拉到的清单。为空表示还没拉过，或被主动清掉。
    private volatile List<GameRemoteVersion> versions;

    DownloadService(Consumer<String> push) {
        this.push = push;
    }

    // ==================== 版本清单 ====================

    /// 请求版本清单。已缓存时直接推给前端，避免每次进下载页都打一次网络。
    void requestVersions(boolean force) {
        List<GameRemoteVersion> cached = versions;
        if (!force && cached != null) {
            pushVersions(cached);
            return;
        }

        pushStage(null, "正在获取版本清单…", false, null);

        GameRemoteVersion.fetchAsync(DownloadProviders.getDownloadProvider())
                .thenAcceptAsync(list -> {
                    List<GameRemoteVersion> all = new ArrayList<>();
                    // ComponentRemoteVersionList 就是 AbstractList，直接迭代
                    for (ComponentRemoteVersion version : list) {
                        if (version instanceof GameRemoteVersion game) {
                            all.add(game);
                        }
                    }
                    all.sort((a, b) -> b.getReleaseDate().compareTo(a.getReleaseDate()));
                    versions = all;
                    pushVersions(all);
                    pushStage(null, "", true, null);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to fetch version list", exception);
                        pushStage(null, "获取版本清单失败：" + exception, false, exception.toString());
                    }
                })
                .start();
    }

    private void pushVersions(List<GameRemoteVersion> list) {
        // 本地已有同名实例就标成「已安装」，避免用户重复点安装再撞同名冲突
        var repository = GameDirectoryManager.getSelectedRepository();

        JsonArray array = new JsonArray();
        for (GameRemoteVersion version : list) {
            JsonObject item = new JsonObject();
            String id = version.getGameVersion().toString();
            boolean installed = false;
            try {
                installed = repository.findInstance(new GameInstanceID(id)) != null;
            } catch (Exception ignored) {
                // 版本号不是合法实例 id（极少见）时按未安装处理
            }
            item.addProperty("installed", installed);
            item.addProperty("id", id);
            // release / snapshot / old-beta / old-alpha，前端按前缀分组
            item.addProperty("type", version.getType().getId());
            item.addProperty("date", version.getReleaseDate() != null
                    ? version.getReleaseDate().toEpochMilli() : 0L);
            array.add(item);
        }

        JsonObject root = new JsonObject();
        root.add("versions", array);
        String json = JsonUtils.GSON.toJson(root);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onVersions("
                + JsonUtils.GSON.toJson(json) + ")"));
    }

    // ==================== 加载器 ====================

    /// 加载器版本缓存，key 是 `patchId@游戏版本`。
    ///
    /// <p>同时存下 {@link ComponentRemoteVersion} 对象本身——安装时要用它，
    /// 而前端只传得回一个版本号字符串。只存字符串的话安装阶段还得再拉一次清单。
    private final Map<String, List<ComponentRemoteVersion>> loaderVersions = new ConcurrentHashMap<>();

    /// 请求某个游戏版本下的加载器版本列表。type 取 fabric / quilt / forge / neoforge。
    void requestLoaderVersions(String gameVersion, String loaderType) {
        GameComponentType type = GameComponentType.fromPatchId(loaderType);
        if (type == null || !type.isModLoader()) {
            pushLoaderVersions(gameVersion, loaderType, List.of(), "未知的加载器类型");
            return;
        }

        GameVersionNumber target;
        try {
            target = GameVersionNumber.asGameVersion(gameVersion);
        } catch (Exception e) {
            pushLoaderVersions(gameVersion, loaderType, List.of(), "版本号无法解析");
            return;
        }

        DownloadProviders.getDownloadProvider()
                .getVersionsAsync(type, target, false)
                .thenAcceptAsync(rawList -> {
                    List<ComponentRemoteVersion> result = new ArrayList<>();
                    for (ComponentRemoteVersion version : rawList) {
                        // provider 有的分支会返回全量，这里再按游戏版本过滤一次
                        if (target.equals(version.getGameVersion())) {
                            result.add(version);
                        }
                    }
                    loaderVersions.put(loaderType + "@" + gameVersion, result);
                    pushLoaderVersions(gameVersion, loaderType, result, null);
                })
                .whenComplete(exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to fetch " + loaderType + " versions", exception);
                        pushLoaderVersions(gameVersion, loaderType, List.of(), String.valueOf(exception));
                    }
                })
                .start();
    }

    private void pushLoaderVersions(String gameVersion, String loaderType,
                                    List<ComponentRemoteVersion> list, String error) {
        JsonArray array = new JsonArray();
        for (ComponentRemoteVersion version : list) {
            array.add(version.getSelfVersion());
        }
        JsonObject json = new JsonObject();
        json.addProperty("game", gameVersion);
        json.addProperty("type", loaderType);
        json.addProperty("error", error);
        json.add("versions", array);

        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onLoaderVersions("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    // ==================== 安装 ====================

    /// 安装原版。
    void installVersion(String versionId) {
        if (versionId == null || versionId.isBlank()) {
            return;
        }
        if (findGameVersion(versionId) == null) {
            pushStage(versionId, "版本清单里没有 " + versionId, false, "unknown version");
            return;
        }
        startBuild(new GameInstanceID(versionId), versionId, versionId,
                builder -> builder.component(GameComponentType.GAME, versionId));
    }

    /// 安装「游戏 + 加载器」。实例名按 `<游戏版本>-<patchId>-<加载器版本>` 生成，
    /// 与原版并存，不覆盖已有实例。
    void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        if (gameVersion == null || loaderType == null || loaderVersion == null) {
            return;
        }

        List<ComponentRemoteVersion> cached = loaderVersions.get(loaderType + "@" + gameVersion);
        if (cached == null || cached.isEmpty()) {
            pushStage(gameVersion, "加载器列表还没加载完，稍后重试", false, "no loader list");
            return;
        }

        ComponentRemoteVersion target = null;
        for (ComponentRemoteVersion version : cached) {
            if (loaderVersion.equals(version.getSelfVersion())) {
                target = version;
                break;
            }
        }
        if (target == null) {
            pushStage(gameVersion, "列表里没有这个加载器版本", false, "unknown loader version");
            return;
        }

        String instanceName = gameVersion + "-" + loaderType + "-" + loaderVersion;
        GameInstanceID instanceId = new GameInstanceID(instanceName);
        ComponentRemoteVersion loader = target;

        startBuild(instanceId, instanceName, gameVersion + " + " + loaderType + " " + loaderVersion, builder -> {
            builder.component(GameComponentType.GAME, gameVersion);
            builder.component(loader);
            // 带加载器的实例通常要装模组，按 HMCL 的设置决定是否开隔离
            if (GameDirectoryManager.getSelectedRepository().shouldIsolateNewInstance(true)) {
                builder.enableIsolation();
            }
        });
    }

    private @Nullable GameRemoteVersion findGameVersion(String versionId) {
        List<GameRemoteVersion> cached = versions;
        if (cached == null) {
            return null;
        }
        for (GameRemoteVersion version : cached) {
            if (version.getGameVersion().toString().equals(versionId)) {
                return version;
            }
        }
        return null;
    }

    /// 创建实例并跑安装任务。原版与加载器共用这一段，
    /// 差别只在 `configure` 里挂了几个组件。
    private void startBuild(GameInstanceID instanceId, String taskId, String label,
                            Consumer<HMCLGameBuilder> configure) {
        var repository = GameDirectoryManager.getSelectedRepository();
        if (repository.findInstance(instanceId) != null) {
            pushStage(taskId, instanceId + " 已经装过了", false, "instance exists");
            return;
        }

        pushStage(taskId, "准备安装 " + label + "…", false, null);

        try {
            var dependencyManager = repository.getDependency(DownloadProviders.getDownloadProvider());

            // try-with-resources 关闭的是「构建器」而不是任务：buildAsync() 已把
            // 仓库草稿的所有权转移给任务，这里关掉是安全且必须的（否则草稿一直占着）。
            try (HMCLGameBuilder builder = dependencyManager.newGameBuilder(instanceId)) {
                configure.accept(builder);
                Task<?> buildTask = builder.buildAsync();

                TaskExecutor executor = buildTask.executor();
                executor.addTaskListener(new TaskListener() {
                    @Override
                    public void onRunning(Task<?> task) {
                        String stage = humanStage(task.getName());
                        if (stage != null && !stage.isEmpty()) {
                            pushStage(taskId, stage, false, null);
                        }
                    }
                });

                buildTask.onDone().register(event -> Platform.runLater(() -> {
                    if (event.isFailed()) {
                        // TaskEvent 只带 failed 标记，真正的异常在 executor 上
                        Exception cause = executor.getException();
                        pushStage(taskId, "安装失败：" + (cause != null ? cause : "未知错误"),
                                false, String.valueOf(cause));
                        return;
                    }
                    // 装完切成当前实例，首页立刻能看到
                    try {
                        repository.setSelectedInstance(repository.getInstance(instanceId));
                    } catch (Exception e) {
                        LOG.warning("Failed to select the new instance", e);
                    }
                    pushStage(taskId, "安装完成", true, null);
                    // 实例列表变了，让页面重新拉一次状态
                    push.accept("window.__hmcl && window.__hmcl.onInstallFinished("
                            + JsonUtils.GSON.toJson(taskId) + ")");
                }));

                executor.start();
            }
        } catch (Exception e) {
            LOG.warning("Failed to build " + instanceId, e);
            pushStage(taskId, "安装失败：" + e.getMessage(), false, String.valueOf(e));
        }
    }

    /// 把内部任务名翻译成人话。
    ///
    /// <p>HMCL 的 {@link TaskListener#onRunning} 给的是任务自己的 `getName()`，
    /// 里面既有 `GameLibrariesTask` 这种类名，也有裸 URL 和 `foo.bar$$Lambda@123` 这种内部标识。
    /// 直接推给界面就是一堆乱码似的英文，用户不知道现在在干什么。
    private static String humanStage(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        // 内部标识与裸地址：没有信息量，一律跳过（界面保留上一条可读文案）
        if (raw.startsWith("http") || raw.contains("$") || raw.contains("@")
                || raw.contains("(") || raw.endsWith(".json") || raw.endsWith(".jar")) {
            return null;
        }

        // 注意：任务名有些带 Task 后缀（类名），有些是 setName 过的裸名（FabricInstall 这种），
        // 两套都要覆盖，否则界面会漏出一半英文一半中文
        switch (raw) {
            case "GameInstanceJsonDownloadTask", "GameInstanceJsonDownload": return "读取版本信息";
            case "GameInstallTask", "GameInstall": return "解析版本依赖";
            case "GameDownloadTask", "GameDownload": return "下载游戏本体";
            case "GameLibrariesTask", "GameLibraries": return "下载依赖库";
            case "GameAssetIndexDownloadTask", "GameAssetIndexDownload": return "获取资源索引";
            case "GameAssetDownloadTask", "GameAssetDownload": return "下载游戏资源";
            case "GameVerificationFixTask", "GameVerificationFix": return "校验并补全文件";
            case "LibraryDownloadTask", "LibraryDownload": return "下载依赖库";
            case "FabricInstall": return "安装 Fabric";
            case "QuiltInstall": return "安装 Quilt";
            case "ForgeInstall": return "安装 Forge";
            case "NeoForgeInstall": return "安装 NeoForge";
            case "GameBuilder": return "整理实例文件";
            default: break;
        }

        // 兜底：去掉包名和 Task 后缀，至少读起来像「FileDownload」
        String simple = raw.substring(raw.lastIndexOf('.') + 1);
        if (simple.endsWith("Task") && simple.length() > 4) {
            simple = simple.substring(0, simple.length() - 4);
        }
        return simple;
    }

    private void pushStage(String id, String stage, boolean done, String error) {
        JsonObject json = new JsonObject();
        json.addProperty("id", id);
        json.addProperty("stage", stage);
        json.addProperty("done", done);
        json.addProperty("error", error);
        // 打到 Java 日志：安装链路的问题大多只能在时间线上看出来
        LOG.info("[download] " + (id == null ? "-" : id) + " | " + stage
                + (done ? " | done" : "") + (error != null ? " | " + error : ""));
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallStage("
                + JsonUtils.GSON.toJson(text) + ")"));
    }
}
