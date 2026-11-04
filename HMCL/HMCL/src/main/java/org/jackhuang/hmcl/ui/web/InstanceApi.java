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
import javafx.stage.FileChooser;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.setting.GameInstanceIconType;
import javafx.application.Platform;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.GraphicsAPI;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.Renderer;
import org.jackhuang.hmcl.util.versioning.GameVersionNumber;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.GameSettings;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.ui.instances.Instances;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Base64;
import java.util.List;
import java.util.function.Function;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 实例本身的增删改：改名 / 复制 / 删除 / 清理 / 清资源 / 重下资源 / 打开子目录 / 测试启动。
///
/// <p>从 [WebBridge] 拆出来的第五块。对页面的要求只有「弹提示」和「改完让前端重拉状态」。
@NotNullByDefault
public final class InstanceApi {

    private final BridgeHost host;
    private final BridgeServices services;

    /// 实例摘要 JSON。实例目录体积、图标、上次启动时间都在 WebBridge 那份缓存里，
    /// 所以由外面注入，而不是在这里再算一遍（两套缓存迟早对不上）。
    private final Function<HMCLGameInstance, JsonObject> summary;

    InstanceApi(BridgeHost host, BridgeServices services,
                Function<HMCLGameInstance, JsonObject> summary) {
        this.host = host;
        this.services = services;
        this.summary = summary;
    }

    // ==================== 实例管理动作 ====================
    //
    // 对照 HMCL 的 GameInstancePage.Skin.managementList（重命名 / 复制 / 删除 / 导出 /
    // 重新下载资源索引 / 清除资源 / 清除库 / 清理垃圾）。
    //
    // 那边每个方法都要弹 JavaFX 对话框（Controllers.prompt、ExportWizardProvider、
    // FileChooser…），壳模式没有这些窗口，所以这里全部改写成「参数由前端给、
    // 结果用 toast 回」的无 UI 版本，业务逻辑仍然落在仓库层的同一批方法上。

    /// 重命名实例。
    ///
    /// 实例 id 同时也是目录名，所以这不是改一个字段：仓库层会把整个目录改名，
    /// 并把 manifest 里的 id 与 jar 名一起改掉。改完要重新选中，否则界面上
    /// 那个「当前实例」会指向一个已经不存在的 id。
    public void instanceRename(String id, String newName) {
        if (id == null || newName == null) {
            return;
        }
        String target = newName.trim();
        HMCLGameInstance instance = InstanceLookup.find(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            host.toast("找不到这个实例");
            return;
        }
        if (target.equals(id)) {
            return;
        }
        // 校验规则与 HMCL 一致：id 就是目录名
        if (!HMCLGameRepository.isValidInstanceId(target)) {
            host.toast("名称里不能包含 \\ / : * ? 双引号 尖括号 竖线");
            return;
        }
        if (repository.instanceIdConflicts(target)) {
            host.toast("已经有同名实例了");
            return;
        }

        GameInstanceID oldId = instance.getId();
        GameInstanceID newId = new GameInstanceID(target);
        Task.supplyAsync(Schedulers.io(), () -> repository.renameInstance(oldId, newId))
                .thenAcceptAsync(Schedulers.javafx(), renamed -> {
                    if (!Boolean.TRUE.equals(renamed)) {
                        host.toast("改名失败：目标名称不可用");
                        return;
                    }
                    // 选中项跟着走，否则重进实例页会扑空
                    repository.refreshAsync()
                            .thenRunAsync(Schedulers.javafx(), () -> {
                                if (repository.hasInstance(newId)) {
                                    repository.setSelectedInstance(repository.getInstance(newId));
                                }
                                host.pushState();
                                // 前端正停在旧 id 的实例页上，不告诉它新 id 的话
                                // 页面会一直显示一个已经不存在的实例
                                JsonObject json = new JsonObject();
                                json.addProperty("from", oldId.toString());
                                json.addProperty("to", newId.toString());
                                host.execute("window.__hmcl && window.__hmcl.onInstanceRenamed("
                                        + JsonUtils.GSON.toJson(json.toString()) + ")");
                                host.toast("已改名为 " + target);
                            }).start();
                }).start();
    }

    /// 复制实例。`copySaves` 对应 HMCL 里「是否一并复制存档」那个勾选。
    public void instanceDuplicate(String id, String newName, boolean copySaves) {
        if (id == null || newName == null) {
            return;
        }
        String target = newName.trim();
        HMCLGameInstance instance = InstanceLookup.find(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            host.toast("找不到这个实例");
            return;
        }
        if (!HMCLGameRepository.isValidInstanceId(target)) {
            host.toast("名称里不能包含 \\ / : * ? 双引号 尖括号 竖线");
            return;
        }
        if (repository.instanceIdConflicts(target)) {
            host.toast("已经有同名实例了");
            return;
        }

        GameInstanceID srcId = instance.getId();
        GameInstanceID dstId = new GameInstanceID(target);
        Task.runAsync(Schedulers.io(), () -> repository.duplicateInstance(srcId, dstId, copySaves))
                .whenComplete(Schedulers.javafx(), exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to duplicate instance", exception);
                        host.toast("复制失败：" + BridgeHost.localize(exception));
                        return;
                    }
                    repository.refreshAsync()
                            .thenRunAsync(Schedulers.javafx(), () -> {
                                host.toast("已复制为 " + target);
                                host.pushState();
                            }).start();
                }).start();
    }

    /// 删除实例。独立运行目录（不在 versions/<id> 下）的情况和 HMCL 一样整体删掉。
    public void instanceDelete(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            host.toast("找不到这个实例");
            return;
        }
        GameInstanceID instanceId = instance.getId();
        Task.supplyAsync(Schedulers.io(), () -> repository.removeInstanceFromDisk(instanceId))
                .whenComplete(Schedulers.javafx(), (deleted, exception) -> {
                    if (exception != null || !Boolean.TRUE.equals(deleted)) {
                        LOG.warning("Failed to delete instance", exception);
                        host.toast("删除失败");
                        return;
                    }
                    repository.refreshAsync()
                            .thenRunAsync(Schedulers.javafx(), () -> {
                                host.toast("已删除 " + instanceId);
                                host.pushState();
                            }).start();
                }).start();
    }

    /// 清理垃圾文件（HMCL 的 instance.manage.clean）。
    ///
    /// 仓库层的 clean() 只删实例目录下的日志、崩溃转储这类东西，不动游戏内容，
    /// 所以不需要二次确认。
    public void instanceClean(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            return;
        }
        GameInstanceID instanceId = instance.getId();
        Task.runAsync(Schedulers.io(), () -> {
            repository.clean(instanceId);
        }).whenComplete(Schedulers.javafx(), exception -> {
            if (exception != null) {
                LOG.warning("Failed to clean instance", exception);
                host.toast("清理失败：" + BridgeHost.localize(exception));
            } else {
                host.toast("已清理垃圾文件");
            }
        }).start();
    }

    /// 清除资源文件（assets + 实例下的 resources）。
    ///
    /// 注意 assets 是**整个游戏目录共享**的，不是实例私有：删了之后这个目录下
    /// 所有实例下次启动都要重新下载。前端确认框里必须写清楚。
    public void instanceClearAssets(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            return;
        }
        Path assetsDir = repository.getBaseDirectory().resolve("assets");
        Path resourcesDir = instance.getRunDirectory().resolve("resources");
        Task.runAsync(Schedulers.io(), () -> {
            org.jackhuang.hmcl.util.io.FileUtils.deleteDirectoryQuietly(assetsDir);
            org.jackhuang.hmcl.util.io.FileUtils.deleteDirectoryQuietly(resourcesDir);
        }).whenComplete(Schedulers.javafx(), exception ->
                host.toast(exception == null ? "已清除资源文件" : ("清除失败：" + BridgeHost.localize(exception)))).start();
    }

    /// 清除库文件。同样是整个游戏目录共享的 libraries/。
    public void instanceClearLibraries(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            return;
        }
        Path libraries = repository.getBaseDirectory().resolve("libraries");
        Task.runAsync(Schedulers.io(), () -> {
            org.jackhuang.hmcl.util.io.FileUtils.deleteDirectoryQuietly(libraries);
        }).whenComplete(Schedulers.javafx(), exception ->
                host.toast(exception == null ? "已清除库文件" : ("清除失败：" + BridgeHost.localize(exception)))).start();
    }

    /// 重新下载资源索引（HMCL 的 instance.manage.redownload_assets_index）。
    ///
    /// 用于 assets 索引损坏、贴图全白的情况。HMCL 会开一个任务窗口显示进度，
    /// 壳模式没有那个窗口，这里就后台跑、结束时 toast 一句。
    public void instanceRedownloadAssets(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            return;
        }
        try {
            var executor = new org.jackhuang.hmcl.download.game.GameAssetDownloadTask(
                    instance.getRepository().getDependency(),
                    instance.getResolvedManifest(),
                    org.jackhuang.hmcl.download.game.GameAssetDownloadTask.DOWNLOAD_INDEX_FORCIBLY,
                    true).executor();
            // 用 onStop 而不是 onFinished：onFinished 是「每个任务结束」都会调，
            // 一次资产下载有几千个子任务，那会弹几千条提示
            executor.addTaskListener(new org.jackhuang.hmcl.task.TaskListener() {
                @Override
                public void onStop(boolean success, org.jackhuang.hmcl.task.TaskExecutor executor) {
                    Platform.runLater(() -> host.toast(success ? "资源索引已重新下载" : "资源下载中断"));
                }
            });
            executor.start();
        } catch (Exception e) {
            LOG.warning("Failed to redownload assets", e);
            host.toast("重新下载失败：" + BridgeHost.localize(e));
        }
    }

    /// 实例运行目录下某个子文件夹的绝对路径。探索菜单用它判断目录是否存在。
    public String instanceSubfolder(String id, String sub) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null || sub == null) {
            return "";
        }
        try {
            // 只允许单层目录名，挡住前端传来的 ..
            String leaf = Path.of(sub).getFileName().toString();
            Path dir = instance.getRunDirectory().resolve(leaf).toAbsolutePath().normalize();
            return Files.isDirectory(dir) ? dir.toString() : "";
        } catch (Exception e) {
            return "";
        }
    }

    /// 测试启动（HMCL 的 instance.launch.test）。
    ///
    /// 和普通启动的唯一差别是 LauncherHelper 会带上 testMode：不写启动记录、
    /// 不更新「上次启动的实例」这类状态，专门用来验证「这个实例现在能不能起来」。
    public void launchTest(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            return;
        }
        // 测试启动也是启动，没账号一样起不来
        if (Accounts.getSelectedAccount() == null) {
            host.toast("请添加账号后再启动实例");
            return;
        }
        // 测试启动走的是另一条链路（Instances.testGame），不经过 startInstance，
        // 补丁必须在这里也挂一次，否则「测试启动」看到的还是旧客户端。
        // 保留 HMCL 原生显示，不再改客户端
        Instances.testGame(instance);
    }

    /// 打开实例运行目录下的某个子目录（探索菜单）。
    public void instanceOpenSubfolder(String id, String sub) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            return;
        }
        try {
            String leaf = sub == null || sub.isBlank() ? "" : Path.of(sub).getFileName().toString();
            Path dir = instance.getRunDirectory().resolve(leaf);
            if (!Files.isDirectory(dir)) {
                host.toast("这个文件夹还不存在");
                return;
            }
            FXUtils.openFolder(dir);
        } catch (Exception e) {
            LOG.warning("Failed to open subfolder", e);
        }
    }

    /// 取仓库。实例可能来自另一个游戏目录，不能直接用「当前选中的仓库」。
    private static @Nullable HMCLGameRepository repositoryOf(HMCLGameInstance instance) {
        if (instance == null) {
            return null;
        }
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            if (repository != null && repository.hasInstance(instance.getId())) {
                return repository;
            }
        } catch (Exception ignored) {
        }
        try {
            return instance.getRepository();
        } catch (Exception e) {
            return null;
        }
    }

    /// 单个实例的完整信息：基础字段 + 路径 + 生效中的游戏设置 + 各类内容数量。
    public String instanceDetail(String instanceId) {
        JsonObject root = new JsonObject();
        HMCLGameInstance instance = InstanceLookup.find(instanceId);
        if (instance == null) {
            root.addProperty("error", "找不到这个实例");
            return JsonUtils.GSON.toJson(root);
        }

        JsonObject base = summary.apply(instance);
        for (var entry : base.entrySet()) {
            root.add(entry.getKey(), entry.getValue());
        }

        try {
            root.addProperty("directory", instance.getRunDirectory().toAbsolutePath().toString());
        } catch (Exception e) {
            root.addProperty("directory", "");
        }

        // null = 这个实例还没有自己的设置文件，全部跟全局走
        boolean custom = instance.getSettings() != null;
        root.addProperty("customSettings", custom);

        try {
            GameSettings source = custom ? instance.getSettings()
                    : org.jackhuang.hmcl.setting.SettingsManager.getDefaultGameSettingsPresetOrCreate();
            JsonObject game = new JsonObject();
            game.addProperty("autoMemory", Boolean.TRUE.equals(source.autoMemoryProperty().getValue()));
            // 实例页也有内存滑条，同样要这三个值
            var os = (com.sun.management.OperatingSystemMXBean)
                    java.lang.management.ManagementFactory.getOperatingSystemMXBean();
            long totalMb = os.getTotalMemorySize() / 1048576L;
            long freeMb = os.getFreeMemorySize() / 1048576L;
            game.addProperty("totalMemory", (int) Math.min(Integer.MAX_VALUE, totalMb));
            game.addProperty("availableMemory", (int) Math.max(0, Math.min(Integer.MAX_VALUE, freeMb)));
            game.addProperty("usedMemory", (int) Math.max(0, Math.min(Integer.MAX_VALUE, totalMb - freeMb)));
            game.addProperty("maxMemory", source.maxMemoryProperty().getValue() == null
                    ? 0 : source.maxMemoryProperty().getValue());
            game.addProperty("minMemory", source.minMemoryProperty().getValue() == null
                    ? 0 : source.minMemoryProperty().getValue());
            game.addProperty("jvmOptions", nullToEmpty(source.jvmOptionsProperty().getValue()));
            game.addProperty("windowType", source.windowTypeProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            game.addProperty("width", source.widthProperty().getValue());
            game.addProperty("height", source.heightProperty().getValue());
            game.addProperty("gameArguments", nullToEmpty(source.gameArgumentsProperty().getValue()));
            game.addProperty("javaType", source.javaTypeProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            game.addProperty("customJavaPath", nullToEmpty(source.customJavaPathProperty().getValue()));
            // 图形 API 与渲染器（26.x 起游戏自身支持在 OpenGL / Vulkan 之间切换）。
            // 空串表示「跟随全局」，前端据此显示占位符而不是硬选一个值。
            game.addProperty("graphicsBackend", nameOf(source.graphicsBackendProperty().getValue()));
            game.addProperty("openGLRenderer", rendererName(source.openGLRendererProperty().getValue()));
            game.addProperty("vulkanRenderer", rendererName(source.vulkanRendererProperty().getValue()));

            // 下面这些对应 GameSettingsPage 里 game / launcher 两个分组的其余条目
            game.addProperty("runningDirectory", nullToEmpty(source.runningDirectoryProperty().getValue()));
            game.addProperty("processPriority",
                    source.processPriorityProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            game.addProperty("launcherVisibility",
                    source.launcherVisibilityProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            game.addProperty("quickPlay",
                    source.quickPlayProperty().getValue().name().toLowerCase(java.util.Locale.ROOT));
            game.addProperty("quickPlaySingleplayer",
                    nullToEmpty(source.quickPlaySingleplayerProperty().getValue()));
            game.addProperty("quickPlayMultiplayer",
                    nullToEmpty(source.quickPlayMultiplayerProperty().getValue()));
            game.addProperty("notUseJavaw", Boolean.TRUE.equals(source.notUseJavawProperty().getValue()));
            game.addProperty("noJVMOptions", Boolean.TRUE.equals(source.noJVMOptionsProperty().getValue()));
            game.addProperty("noOptimizingJVMOptions",
                    Boolean.TRUE.equals(source.noOptimizingJVMOptionsProperty().getValue()));
            game.addProperty("notCheckJVM", Boolean.TRUE.equals(source.notCheckJVMProperty().getValue()));
            game.addProperty("notCheckGame", Boolean.TRUE.equals(source.notCheckGameProperty().getValue()));
            game.addProperty("allowAutoAgent", Boolean.TRUE.equals(source.allowAutoAgentProperty().getValue()));
            game.addProperty("disableAutoGameOptions",
                    Boolean.TRUE.equals(source.disableAutoGameOptionsProperty().getValue()));
            root.add("game", game);
        } catch (Exception e) {
            LOG.warning("Failed to read instance settings " + instanceId, e);
        }

        JsonObject counts = new JsonObject();
        for (String kind : List.of("mod", "resourcepack", "shader", "world", "screenshot")) {
            counts.addProperty(kind, countAddons(instanceId, kind));
        }
        root.add("counts", counts);

        return JsonUtils.GSON.toJson(root);
    }

    /// 写一个实例级设置。第一次写会创建该实例自己的设置文件，
    /// 之后这个实例就不再跟随全局（和 HMCL 的「独立设置」一致）。
    /// 图形 API 与渲染器的可选值，供实例设置页填下拉框。
    ///
    /// <p>渲染器列表依赖当前机器：不同显卡/驱动能用的渲染器不一样，
    /// 游戏版本还会限制 API 本身（26.2 之前只有 OpenGL）。所以这里一次性
    /// 把「这个版本能选哪些 API」「每个 API 下有哪些渲染器」都返回给前端，
    /// 由界面决定显示什么，而不是在 JS 里写死。
    public String graphicsOptions(String instanceId) {
        JsonObject root = new JsonObject();
        try {
            HMCLGameInstance instance = GameDirectoryManager.getSelectedRepository()
                    .getInstance(new GameInstanceID(instanceId));

            GameVersionNumber version = instance.getVersion();
            GraphicsAPI defaultApi = GraphicsAPI.getDefaultGraphicsAPI(version);

            JsonArray apis = new JsonArray();
            for (GraphicsAPI api : GraphicsAPI.values()) {
                // DEFAULT 是「跟随游戏版本」，单独一项；其余按版本支持情况过滤
                if (api == GraphicsAPI.DEFAULT || api.isSupported(version)) {
                    JsonObject o = new JsonObject();
                    o.addProperty("id", api.name());
                    o.addProperty("label", switch (api) {
                        case DEFAULT -> "跟随游戏版本（" + defaultApi.name() + "）";
                        case OPENGL -> "OpenGL";
                        case VULKAN -> "Vulkan";
                    });
                    apis.add(o);
                }
            }

            JsonObject renderers = new JsonObject();
            for (GraphicsAPI api : new GraphicsAPI[]{GraphicsAPI.OPENGL, GraphicsAPI.VULKAN}) {
                JsonArray list = new JsonArray();
                try {
                    for (Renderer renderer : Renderer.getSupported(api)) {
                        JsonObject o = new JsonObject();
                        o.addProperty("id", renderer.name());
                        o.addProperty("label", renderer.name());
                        list.add(o);
                    }
                } catch (Throwable e) {
                    LOG.warning("[instance] 枚举 " + api + " 渲染器失败", e);
                }
                renderers.add(api.name(), list);
            }

            root.addProperty("ok", true);
            root.add("apis", apis);
            root.add("renderers", renderers);
            root.addProperty("defaultApi", defaultApi.name());
            root.addProperty("version", version == null ? "" : version.toString());
        } catch (Throwable e) {
            LOG.warning("[instance] graphicsOptions 失败", e);
            root.addProperty("ok", false);
            root.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
        }
        return JsonUtils.GSON.toJson(root);
    }

    private static String rendererName(@Nullable Renderer renderer) {
        return renderer == null ? "" : renderer.name();
    }

    private static @Nullable Renderer rendererOf(@Nullable String name) {
        return name == null || name.isBlank() ? null : Renderer.of(name);
    }

    private static String nameOf(@Nullable Enum<?> value) {
        return value == null ? "" : value.name();
    }

    private static @Nullable String blankToNull(@Nullable String value) {
        return value == null || value.isBlank() ? null : value;
    }

    public void instanceSetting(String instanceId, String key, String value) {
        HMCLGameInstance instance = InstanceLookup.find(instanceId);
        if (instance == null) {
            return;
        }
        try {
            GameSettings.Instance settings = instance.getSettingsOrCreate();
            if (settings == null) {
                LOG.warning("Instance settings are read-only: " + instanceId);
                return;
            }
            switch (key == null ? "" : key) {
                case "autoMemory" -> settings.autoMemoryProperty().setValue(Boolean.parseBoolean(value));
                case "maxMemory" -> settings.maxMemoryProperty().setValue(parseIntOrNull(value));
                case "minMemory" -> settings.minMemoryProperty().setValue(parseIntOrNull(value));
                case "jvmOptions" -> settings.jvmOptionsProperty().setValue(nullToEmpty(value));
                case "windowType" -> settings.windowTypeProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.setting.GameWindowType.class,
                                org.jackhuang.hmcl.setting.GameWindowType.WINDOWED));
                case "width" -> settings.widthProperty().setValue(parseDouble(value, 854.0));
                case "height" -> settings.heightProperty().setValue(parseDouble(value, 480.0));
                case "gameArguments" -> settings.gameArgumentsProperty().setValue(nullToEmpty(value));
                case "javaType" -> settings.javaTypeProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.setting.JavaVersionType.class,
                                org.jackhuang.hmcl.setting.JavaVersionType.AUTO));
                case "customJavaPath" -> settings.customJavaPathProperty().setValue(nullToEmpty(value));
                // 图形相关三项必须同时打 override 标记。
                // InheritableProperty 的值和「是否被实例覆盖」是两份数据：只 setValue
                // 的话值落在内存里，重启后读到的还是全局默认 —— 用户改完看不见效果。
                case "graphicsBackend" -> {
                    settings.graphicsBackendProperty().setValue(
                            enumOf(value, org.jackhuang.hmcl.game.GraphicsAPI.class,
                                    org.jackhuang.hmcl.game.GraphicsAPI.DEFAULT));
                    settings.getOverrideProperties().add("graphicsBackend");
                }
                case "openGLRenderer" -> {
                    settings.openGLRendererProperty().setValue(rendererOf(value));
                    settings.getOverrideProperties().add("openGLRenderer");
                }
                case "vulkanRenderer" -> {
                    settings.vulkanRendererProperty().setValue(rendererOf(value));
                    settings.getOverrideProperties().add("vulkanRenderer");
                }
                case "runningDirectory" -> settings.runningDirectoryProperty().setValue(nullToEmpty(value));
                case "processPriority" -> settings.processPriorityProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.game.ProcessPriority.class,
                                org.jackhuang.hmcl.game.ProcessPriority.NORMAL));
                case "launcherVisibility" -> settings.launcherVisibilityProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.setting.LauncherVisibility.class,
                                org.jackhuang.hmcl.setting.LauncherVisibility.HIDE_AND_REOPEN));
                case "quickPlay" -> settings.quickPlayProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.game.QuickPlayType.class,
                                org.jackhuang.hmcl.game.QuickPlayType.NONE));
                case "quickPlaySingleplayer" ->
                        settings.quickPlaySingleplayerProperty().setValue(nullToEmpty(value));
                case "quickPlayMultiplayer" ->
                        settings.quickPlayMultiplayerProperty().setValue(nullToEmpty(value));
                case "notUseJavaw" -> settings.notUseJavawProperty().setValue(Boolean.parseBoolean(value));
                case "noJVMOptions" -> settings.noJVMOptionsProperty().setValue(Boolean.parseBoolean(value));
                case "noOptimizingJVMOptions" ->
                        settings.noOptimizingJVMOptionsProperty().setValue(Boolean.parseBoolean(value));
                case "notCheckJVM" -> settings.notCheckJVMProperty().setValue(Boolean.parseBoolean(value));
                case "notCheckGame" -> settings.notCheckGameProperty().setValue(Boolean.parseBoolean(value));
                case "allowAutoAgent" -> settings.allowAutoAgentProperty().setValue(Boolean.parseBoolean(value));
                case "disableAutoGameOptions" ->
                        settings.disableAutoGameOptionsProperty().setValue(Boolean.parseBoolean(value));
                default -> LOG.warning("Unknown instance setting: " + key);
            }
            pushInstanceDetail(instanceId);
        } catch (Exception e) {
            LOG.warning("Failed to set instance setting " + key, e);
        }
    }

    private void pushInstanceDetail(String instanceId) {
        String json = instanceDetail(instanceId);
        Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onInstanceDetail("
                + JsonUtils.GSON.toJson(json) + ")"));
    }

    private static int countAddons(String instanceId, String kind) {
        Path dir = ContentApi.addonDir(instanceId, kind);
        if (dir == null || !Files.isDirectory(dir)) {
            return 0;
        }
        boolean isWorld = "world".equals(kind);
        try (var list = Files.list(dir)) {
            return (int) list.filter(isWorld ? Files::isDirectory : Files::isRegularFile).count();
        } catch (IOException e) {
            return 0;
        }
    }

    private static Integer parseIntOrNull(String value) {
        try {
            int n = Integer.parseInt(value == null ? "" : value.trim());
            return n > 0 ? n : null;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static double parseDouble(String value, double fallback) {
        try {
            double d = Double.parseDouble(value == null ? "" : value.trim());
            return d > 0 ? d : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static <E extends Enum<E>> E enumOf(String value, Class<E> type, E fallback) {
        try {
            return Enum.valueOf(type, value == null ? "" : value.trim().toUpperCase(java.util.Locale.ROOT));
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    /// 带附加组件（fabric-api / quilt-api）的安装
    public void installLoaderWithAddon(String gameVersion, String loaderType, String loaderVersion,
                                       String instanceName, String addonsSpec) {
        services.download.installLoader(gameVersion, loaderType, loaderVersion, instanceName, addonsSpec);
    }

    /// 列出一个附属组件当前游戏版本下可选的版本（Fabric API / QSL / Fugue / Scalar Legacy）。
    ///
    /// <p>前端点开附属卡片的版本弹窗时调；结果通过 `onAddonVersions` 推回。
    public void requestAddonVersions(String addonId, String gameVersion) {
        services.download.requestAddonVersions(addonId, gameVersion);
    }

    /// 把加载器装进已有实例（HMCL 的「安装到现有实例」）。
    /// instanceId 为空时退回新建，前端不用分两条路径。
    public void installLoaderTo(String instanceId, String gameVersion, String loaderType, String loaderVersion) {
        if (instanceId == null || instanceId.isBlank()) {
            services.download.installLoader(gameVersion, loaderType, loaderVersion);
            return;
        }
        services.download.installLoaderTo(instanceId, gameVersion, loaderType, loaderVersion);
    }

    /// 弹文件选择框，返回 data URL（给前端裁剪用）
    public String pickImage() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("选择实例图标");
        chooser.getExtensionFilters().add(FXUtils.getImageExtensionFilter());
        Path file = Controllers.showOpenDialog(chooser);
        if (file == null) {
            return null;
        }
        try {
            byte[] bytes = Files.readAllBytes(file);
            String mime = file.getFileName().toString().toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
            return "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes);
        } catch (IOException e) {
            LOG.warning("Failed to read image " + file, e);
            return null;
        }
    }

    /// 前端裁剪出的 256×256 PNG（data URL）直接写进实例目录
    public void setIconData(String id, String dataUrl) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null || dataUrl == null) {
            return;
        }
        int comma = dataUrl.indexOf(',');
        if (comma < 0) {
            return;
        }
        try {
            byte[] bytes = Base64.getDecoder().decode(dataUrl.substring(comma + 1));
            Path temp = Files.createTempFile("hmcl-icon-", ".png");
            Files.write(temp, bytes);
            instance.setIconFile(temp);
            Files.deleteIfExists(temp);
            instance.invalidateIconImage();
            host.pushState();
        } catch (Exception e) {
            LOG.warning("Failed to set instance icon", e);
            host.toast("设置图标失败：" + e.getMessage());
        }
    }

    public void setBuiltinIcon(String id, String typeName) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            return;
        }
        try {
            GameSettings.Instance settings = instance.getSettingsOrCreate();
            if (settings == null) {
                return;
            }
            instance.deleteIconFile();
            settings.iconProperty().setValue(GameInstanceIconType.valueOf(typeName));
            instance.invalidateIconImage();
            host.pushState();
        } catch (Exception e) {
            LOG.warning("Failed to set builtin icon " + typeName, e);
        }
    }
}
