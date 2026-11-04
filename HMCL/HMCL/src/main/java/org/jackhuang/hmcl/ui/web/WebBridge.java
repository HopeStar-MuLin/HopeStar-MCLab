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
import javafx.scene.web.WebEngine;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorAccount;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.GameInstanceIconType;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.ui.instances.Instances;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/**
 * 暴露给 WebView 前端的方法集合：JS 侧只做展示，所有状态读取与变更都走这里，
 * 返回值一律是 JSON 字符串。方法由 JavaScript 调用、运行在 JavaFX 线程上，
 * 耗时操作必须自己转后台。
 *
 * <p><b>这里是 API 门面，不承载业务。</b>具体逻辑按域拆在下面这些类里。
 *
 * <p>接口本身按领域拆在 `*Api` 里，通过 [#apiTargets] 登记给
 * {@link WebHttpServer}；本类只剩「状态读取 + 实例选择与启动 + 宿主能力」：
 * <ul>
 *   <li>{@link AccountApi} —— 离线 / 微软 / 外置认证登录，改名单删</li>
 *   <li>{@link AppearanceApi} —— 皮肤衣柜、披风、3D 预览、头像</li>
 *   <li>{@link ContentApi} —— 下载页与实例内容（模组 / 整合包 / 截图 / 崩溃 / 导入导出）</li>
 *   <li>{@link InstanceApi} —— 实例增删改与详情</li>
 *   <li>{@link InstanceThemeApi} / {@link ThemeApi} —— 实例主题、启动器外观偏好</li>
 *   <li>{@link MigrationApi} —— 从旧启动器或手动目录导入</li>
 *   <li>{@link SettingsApi} —— 设置页与本机 Java</li>
 *   <li>{@link ToolboxApi} / {@link NewsApi} / {@link WindowApi} / {@link LauncherUpdateApi}</li>
 * </ul>
 *
 * <p>下面这些是业务服务，`*Api` 通过 {@link BridgeServices} 共用同一份实例：
 * <ul>
 *   <li>{@link AddonService} —— 模组 / 资源包 / 光影 / 世界 / 整合包的搜索、安装、更新</li>
 *   <li>{@link DownloadService} —— 游戏版本、加载器、Java 的下载与安装</li>
 *   <li>{@link GameIntegrityService} —— 客户端文件完整性检查与补全</li>
 *   <li>{@link ExportService} —— 实例 / 存档 / 整合包的导出</li>
 *   <li>{@link InstanceThemeService} —— 实例主题（图标、窗口标题、强调色、背景图）</li>
 *   <li>{@link CrashService} / {@link ModScanService} / {@link WorldService} —— 体检与存档</li>
 *   <li>{@link AppearanceStore} —— 皮肤衣柜的素材与离线渲染</li>
 * </ul>
 *
 * <p>加新接口的顺序：先看上面有没有现成的服务能挂；没有再动这里。
 * 加完在 {@code assets/web/src/js/00-core.js} 头部的模块索引补一行，否则下一个人找不到。
 *
 * <p>任务进度统一走 {@link TaskProgress}（前端 `onInstallStage`），
 * 不要自己拼 SSE 字符串 —— 以前三份实现各发各的，改个字段要改三处。
 */
public final class WebBridge {


    private final WebEngine engine;
    private final WebUIPage page;

    /// 非 JavaFX 宿主（Tauri 壳）时使用；为 null 则回落到 engine.executeScript
    private volatile WebChannel channel;

    /// 实例目录占用缓存：id -> bytes
    private final Map<String, Long> instanceSizes = new ConcurrentHashMap<>();
    private final Set<String> pendingSizes = ConcurrentHashMap.newKeySet();


    // ==================== 拆出去的接口 ====================
    //
    // 本类只保留「状态读取 + 实例操作 + 宿主能力」。其余按领域拆成独立类，通过
    // apiTargets() 登记到 WebHttpServer 的方法表里；每个类只拿 BridgeHost
    // （推 JS / 弹提示 / 重拉状态），拿不到 WebBridge 本身，避免拆了又绕回去。

    /// 拆出去的类共用的出口
    private final BridgeHost host = new BridgeHost(this::execute, this::toast, this::push);

    /// 下载 / 内容 / 设置 / Java 安装这组服务，多个 `*Api` 共用同一份实例
    /// （SettingsService 内部有缓存，各建一个会出现「改了设置页面不刷新」）。
    private final BridgeServices services = new BridgeServices(this::execute);

    /// 启动器自身更新（设置 → 关于）
    private final LauncherUpdateApi launcherUpdate = new LauncherUpdateApi(host);

    /// 主页动态与正文阅读
    private final NewsApi news = new NewsApi(host);

    /// 自绘标题栏：最小化 / 最大化 / 关闭 / 拖动 / 缩放
    private final WindowApi windowControls = new WindowApi();

    /// 百宝箱：自定义下载、清理、GitHub 镜像
    private final ToolboxApi toolbox = new ToolboxApi(host, services);

    /// 联机：托管外部下载的陶瓦联机（Terracotta），只起进程不改它
    private final LanApi lan = new LanApi(host);

    /// 实例增删改（改名 / 复制 / 删除 / 清理 / 重下）
    private final InstanceApi instances = new InstanceApi(host, services, this::instanceJson);

    /// 外观：皮肤衣柜、披风、3D 预览、头像。
    /// 要在构造器里初始化——字段初始化时 `page` 还没赋值。
    private final AppearanceApi appearanceApi;

    /// 设置页：启动器 / 下载 / Java / 游戏，以及本机 Java 的扫描安装
    private final SettingsApi settingsApi = new SettingsApi(host, services);

    /// 下载页与实例内容：版本 / 加载器 / 模组 / 整合包 / 截图 / 崩溃分析
    private final ContentApi content = new ContentApi(host, services);

    /// 实例的导出与导入（ZIP / 整合包 / 存档 / 拖放 / 上传落盘）
    private final ArchiveApi archive = new ArchiveApi(host, services);

    /// 实例主题：图标 / 窗口标题 / 强调色 / 背景图
    private final InstanceThemeApi instanceTheme = new InstanceThemeApi(host);

    /// 启动器界面外观偏好：主题色 / 背景图
    private final ThemeApi theme = new ThemeApi(host);

    /// 从旧启动器 / 手动目录导入已有游戏
    private final MigrationApi migration = new MigrationApi(host);

    /// 账号：离线 / 微软 / 外置认证
    private final AccountApi accounts;

    /// 给 WebHttpServer 的直连口子（图标字节流不走 JSON-RPC）
    ContentApi contentApi() {
        return content;
    }

    /// 上传落盘的直连口子（`/api/upload` 走 multipart，不走 JSON-RPC）
    ArchiveApi archiveApi() {
        return archive;
    }

    /// 额外登记到 HTTP 方法表的桥对象。
    ///
    /// WebHttpServer 启动时会把本类和这里返回的每个对象都扫一遍 method。新功能
    /// 按领域写成独立的 `*Api` 类后加到这个列表，不要再往本类里塞几千行。
    java.util.List<Object> apiTargets() {
        return java.util.List.of(launcherUpdate, news, windowControls, toolbox, lan, instances,
                appearanceApi, settingsApi, content, archive, instanceTheme, theme, migration, accounts);
    }

    WebBridge(WebEngine engine, WebUIPage page) {
        this.engine = engine;
        this.page = page;
        this.appearanceApi = new AppearanceApi(host, page);
        this.accounts = new AccountApi(host, appearanceApi::discardAppearanceDraft);

        // 启动进度：壳模式下界面是 WebView2 渲染的，JavaFX 那个启动对话框用户看不见 ——
        // 点「启动」到游戏窗口出现之间是一片空白。把管线里的阶段推进转成页面事件，
        // 用户能看到正在做什么，也能中途取消。
        org.jackhuang.hmcl.game.LaunchProgressBridge.setSink((stage, detail, percent, done, error) -> {
            JsonObject payload = new JsonObject();
            payload.addProperty("stage", stage == null ? "" : stage);
            // 有更细的子状态就用它：「正在补全依赖库」比「处理游戏依赖」有用得多
            String label = detail != null && !detail.isBlank()
                    ? detail
                    : (stage == null ? "" : stageLabel(stage));
            payload.addProperty("label", label);
            payload.addProperty("percent", percent);
            payload.addProperty("done", done);
            payload.addProperty("error", error == null ? "" : error);
            if (done && error == null) {
                // 壳模式下界面是 Tauri 窗口，JavaFX 那套隐藏/恢复对它无效，
                // 把设置翻成两个布尔值交给页面，由页面调窗口 API
                org.jackhuang.hmcl.setting.LauncherVisibility visibility = currentLauncherVisibility();
                payload.addProperty("hideLauncher",
                        visibility == org.jackhuang.hmcl.setting.LauncherVisibility.HIDE
                                || visibility == org.jackhuang.hmcl.setting.LauncherVisibility.HIDE_AND_REOPEN);
                payload.addProperty("reopenLauncher",
                        visibility == org.jackhuang.hmcl.setting.LauncherVisibility.HIDE_AND_REOPEN);
            }
            String text = JsonUtils.GSON.toJson(payload);
            pushJs("window.__hmcl && window.__hmcl.onLaunchProgress("
                    + JsonUtils.GSON.toJson(text) + ")");
        });

        // 游戏退出：把隐藏掉的启动器窗口放回来
        org.jackhuang.hmcl.game.LaunchProgressBridge.setGameExitAction(() ->
                pushJs("window.__hmcl && window.__hmcl.onGameExit()"));
    }

    /// 当前生效的「启动后启动器」设置。取不到就按默认的隐藏并恢复。
    private static org.jackhuang.hmcl.setting.LauncherVisibility currentLauncherVisibility() {
        try {
            HMCLGameInstance instance = GameDirectoryManager.getSelectedInstance();
            if (instance != null) {
                return instance.getEffectiveSettings()
                        .getInheritable(org.jackhuang.hmcl.setting.GameSettings::launcherVisibilityProperty);
            }
        } catch (Throwable e) {
            LOG.warning("Cannot read launcher visibility", e);
        }
        return org.jackhuang.hmcl.setting.LauncherVisibility.HIDE_AND_REOPEN;
    }

    /// 阶段 key 翻成人话（`launch.state.java` → 检测 Java 版本）。
    /// 语言包里没有就返回空串，前端会保留上一格的文字而不是显示一个 key。
    private static String stageLabel(String key) {
        try {
            String text = org.jackhuang.hmcl.util.i18n.I18n.i18n(key);
            return text == null || text.isBlank() || text.equals(key) ? "" : text;
        } catch (Throwable e) {
            return "";
        }
    }

    /// 取消正在进行的启动。返回 `false` 表示当时没有启动在跑。
    public boolean cancelLaunchProgress() {
        return org.jackhuang.hmcl.game.LaunchProgressBridge.cancel();
    }


    /// Tauri/HTTP 模式下没有 WebEngine，用这里接管 Java -> JS 的输出
    void setChannel(WebChannel channel) {
        this.channel = channel;
    }

    /// 轻提示。JavaFX 模式落到 Decorator 的 toast，壳模式推给页面。
    /// 壳模式用的是全限定名，避免下面批量替换时递归到自己。
    private void toast(String message) {
        if (channel != null) {
            execute("window.__hmcl && window.__hmcl.onToast(" + JsonUtils.GSON.toJson(message) + ")");
        } else {
            org.jackhuang.hmcl.ui.Controllers.showToast(message);
        }
    }

    /// 壳模式下提供离屏预览画布
    void setOffscreenPreview(OffscreenPreview preview) {
        appearanceApi.setOffscreenPreview(preview);
    }

    /// 衣柜图渲染器
    void setSkinGallery(SkinGallery gallery) {
        appearanceApi.setSkinGallery(gallery);
    }

    // ==================== 状态 ====================

    public String getState() {
        return JsonUtils.GSON.toJson(buildState());
    }

    public void refresh() {
        // 清掉可能过期的实例引用，让 UI 重新拉一次
        push();
    }

    private JsonObject buildState() {
        JsonObject root = new JsonObject();

        // 首屏就要按用户选的动画速度渲染：设置页不是启动时打开的，
        // 等 onSettings 回来再应用，第一次切页的动画就是全速了。
        try {
            var launcher = org.jackhuang.hmcl.setting.SettingsManager.settings();
            String animSpeed = launcher.animationSpeedProperty().get();
            root.addProperty("animationSpeed",
                    animSpeed == null || animSpeed.isBlank() ? "fast" : animSpeed);
            Boolean animOff = launcher.animationDisabledProperty().get();
            root.addProperty("animationDisabled", animOff != null && animOff);
        } catch (Throwable e) {
            root.addProperty("animationSpeed", "fast");
            root.addProperty("animationDisabled", false);
        }

        // 选中账号变了就重挂一次纹理绑定。正版账号的皮肤/披风都是异步到手的，
        // 不挂绑定的话缓存永远是空的（「账号当前皮肤」卡片空白、披风渲染不出来）。
        // 放在这里而不是 push()：页面首次加载走的是 getState，不一定会有 push。
        appearanceApi.attachAccountTextures(Accounts.getSelectedAccount());

        Account selected = Accounts.getSelectedAccount();
        if (selected != null) {
            root.add("account", accountJson(selected, true));
        } else {
            root.add("account", null);
        }

        JsonArray accounts = new JsonArray();
        for (Account account : Accounts.getAccounts()) {
            accounts.add(accountJson(account, account == selected));
        }
        root.add("accounts", accounts);

        JsonArray instances = new JsonArray();
        HMCLGameInstance selectedInstance = GameDirectoryManager.getSelectedInstance();
        String selectedId = selectedInstance != null ? selectedInstance.getId().toString() : null;

        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        List<HMCLGameInstance> displayInstances;
        try {
            displayInstances = repository.getDisplayInstances().toList();
        } catch (Exception e) {
            LOG.warning("Failed to list instances", e);
            displayInstances = List.of();
        }

        for (HMCLGameInstance instance : displayInstances) {
            instances.add(instanceJson(instance));
        }
        root.add("instances", instances);
        root.addProperty("selected", selectedId);

        root.add("iconTypes", iconTypesJson());
        // 未登录时前端拿它当头像，取代原来的紫色渐变色块
        root.addProperty("defaultAvatar", appearanceApi.avatars().defaultAvatarDataUrl());
        root.addProperty("theme", isDark() ? "dark" : "light");
        root.addProperty("env", org.jackhuang.hmcl.Metadata.NAME + " " + org.jackhuang.hmcl.Metadata.VERSION
                + " · Java " + System.getProperty("java.version")
                + " · " + System.getProperty("os.name"));
        return root;
    }

    private JsonObject accountJson(Account account, boolean selected) {
        JsonObject json = new JsonObject();
        json.addProperty("uuid", account.getAccountID().toString());
        json.addProperty("name", displayName(account));
        json.addProperty("channel", channel(account));
        json.addProperty("avatar", appearanceApi.avatars().avatarDataUrl(account));
        json.addProperty("selected", selected);
        return json;
    }

    static String displayName(Account account) {
        String name = account.getProfileName();
        return name != null && !name.isBlank() ? name : account.getProfileID().toString();
    }

    /// 登录渠道文案：离线登录 / 微软登录 / 皮肤站名字（LittleSkin 等）
    static String channel(Account account) {
        try {
            if (account instanceof AuthlibInjectorAccount authlibAccount) {
                String serverName = authlibAccount.getServer().getName();
                if (serverName != null && !serverName.isBlank()) {
                    return serverName;
                }
            }
            return Accounts.getLocalizedLoginTypeName(Accounts.getAccountFactory(account));
        } catch (Exception e) {
            LOG.warning("Failed to resolve login channel", e);
            return "";
        }
    }

    JsonObject instanceJson(HMCLGameInstance instance) {
        JsonObject json = new JsonObject();
        String id = instance.getId().toString();
        json.addProperty("id", id);
        json.addProperty("name", id);

        // 版本号优先取 manifest 里 game patch 的 version。
        // instance.getVersion() 在「缺 jar / 手写的最小 manifest」这类情况下会把实例 id
        // 当成版本号返回（比如 test-fabric），拿它去 Modrinth 搜模组会一个都匹配不上。
        String gameVersion = null;
        var gamePatch = instance.getManifest().findPatch(GameComponentType.GAME);
        if (gamePatch != null && gamePatch.version() != null && !gamePatch.version().isBlank()) {
            gameVersion = gamePatch.version();
        }
        if (gameVersion == null || gameVersion.isBlank()
                || "unknown".equalsIgnoreCase(gameVersion) || "0.0".equals(gameVersion)) {
            gameVersion = instance.getVersion().toString();
        }
        if (gameVersion == null || gameVersion.isBlank()
                || "unknown".equalsIgnoreCase(gameVersion) || "0.0".equals(gameVersion)) {
            gameVersion = instance.getManifest().id().toString();
        }
        json.addProperty("gameVersion", gameVersion);
        json.addProperty("isModpack", instance.isModpack());

        // 模组加载器：取第一个命中的加载器 + 版本
        String loader = null;
        String loaderVersion = null;
        for (GameComponentType type : GameComponentType.MOD_LOADERS) {
            String version = instance.getComponentVersion(type);
            if (version != null) {
                var modLoaderType = type.getModLoaderType();
                loader = modLoaderType != null ? modLoaderType.displayName() : type.name();
                loaderVersion = version;
                break;
            }
        }
        json.addProperty("loader", loader != null ? loader : "原版");
        json.addProperty("loaderVersion", loaderVersion);

        json.addProperty("java", javaVersion(instance));

        Long size = instanceSizes.get(id);
        json.addProperty("size", size != null ? size : -1);
        if (size == null) {
            ensureSize(instance);
        }

        json.addProperty("lastLaunch", lastLaunchMillis(instance));
        json.addProperty("icon", iconDataUrl(instance));
        return json;
    }

    private static String javaVersion(HMCLGameInstance instance) {
        try {
            var manifest = instance.getResolvedManifest();
            var javaVersion = manifest.javaVersion();
            if (javaVersion != null) {
                return String.valueOf(javaVersion.majorVersion());
            }
        } catch (Exception e) {
            LOG.warning("Failed to read java version of " + instance.getId(), e);
        }
        return null;
    }

    /// 最后启动时间：优先取 logs/latest.log 的修改时间，退化为实例目录修改时间
    private static long lastLaunchMillis(HMCLGameInstance instance) {
        Path root = instance.getInstanceRoot();
        Path log = root.resolve("logs").resolve("latest.log");
        try {
            if (Files.isRegularFile(log)) {
                return Files.getLastModifiedTime(log).toMillis();
            }
            return Files.getLastModifiedTime(root).toMillis();
        } catch (IOException e) {
            return 0;
        }
    }

    /// 目录占用：后台统计，算完推一次完整状态
    private void ensureSize(HMCLGameInstance instance) {
        String id = instance.getId().toString();
        if (instanceSizes.containsKey(id) || !pendingSizes.add(id)) {
            return;
        }
        Path root = instance.getInstanceRoot();
        Task.runAsync(() -> {
            long total = 0;
            try (Stream<Path> stream = Files.walk(root)) {
                total = stream.filter(Files::isRegularFile)
                        .mapToLong(path -> {
                            try {
                                return Files.size(path);
                            } catch (IOException e) {
                                return 0;
                            }
                        })
                        .sum();
            } catch (IOException e) {
                LOG.warning("Failed to compute size of " + root, e);
            }
            instanceSizes.put(id, total);
            pendingSizes.remove(id);
            Platform.runLater(this::push);
        }).start();
    }

    private JsonArray iconTypesJson() {
        JsonArray array = new JsonArray();
        for (GameInstanceIconType type : GameInstanceIconType.values()) {
            JsonObject item = new JsonObject();
            item.addProperty("id", type.name());
            item.addProperty("label", type.name());
            try {
                item.addProperty("preview", ImageCodec.toDataUrl(type.getIcon(), 64));
            } catch (Exception e) {
                item.addProperty("preview", "");
            }
            array.add(item);
        }
        return array;
    }

    // ==================== 实例操作 ====================

    public void selectInstance(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            return;
        }
        GameDirectoryManager.setSelectedInstance(instance);
        push();
    }

    public void launch(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            // 静默 return 会让「点启动没反应」变成一个查不出来的问题：
            // 列表可能是过期的，实例也许刚被删掉或者改名
            LOG.warning("[launch] instance not found: " + id);
            toast("找不到这个实例，回首页刷新一下列表再试");
            return;
        }
        startInstance(instance);
    }

    /// 启动当前选中的实例。
    ///
    /// 首页实例卡片双击和实例页顶部的「启动游戏」都调这个。
    /// 之前前端一直在 `call('launchInstance')`，但后端根本没有这个方法——
    /// 两处的启动按钮点了都没反应，只是没人注意。
    public void launchInstance() {
        HMCLGameInstance instance = GameDirectoryManager.getSelectedInstance();
        if (instance == null) {
            return;
        }
        startInstance(instance);
    }

    /// 已经过「启动前检查」、用户点了「仍然启动」的实例 id。
    ///
    /// <p>只放行一次：消费掉之后，下一次点启动仍然要重新检查 —— 用户可能只是
    /// 想先试试，试完回头修了问题，不能因为放行过一次就永久跳过。
    private final Set<String> launchConfirmed = ConcurrentHashMap.newKeySet();

    /// 前端在检查弹窗里点「仍然启动」后调这个。
    public void launchConfirmed(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance == null) {
            return;
        }
        launchConfirmed.add(id);
        startInstance(instance);
    }

    /// 前端点了「取消」，把放行标记清掉（防止下次启动误放行）。
    public void cancelLaunch(String id) {
        launchConfirmed.remove(id);
    }

    /// 真正拉起游戏的唯一入口。
    ///
    /// 没有账号就不让启动：HMCL 拿不到 AuthInfo 会抛异常，界面上只剩一句
    /// 看不懂的堆栈。这里提前拦住并说清楚该怎么办。
    ///
    /// 启动前先跑一遍资源检查（[LaunchCheckService]）：有问题就推给前端出弹窗，
    /// **不启动**；没有问题直接往下走。检查本身会读 mods 目录，所以放在这里同步跑——
    /// 它比让用户看着没反应的按钮等两秒要好，而且 `call` 本来就是不等返回值的。
    private void startInstance(HMCLGameInstance instance) {
        if (Accounts.getSelectedAccount() == null) {
            toast("请添加账号后再启动实例");
            return;
        }

        String instanceId = instance.getId().toString();
        if (!launchConfirmed.remove(instanceId)) {
            JsonObject check = null;
            try {
                check = LaunchCheckService.check(instance);
            } catch (Throwable e) {
                // 检查自己出错不能挡住启动：它只是提醒，不是守门人
                LOG.warning("Launch check failed, launching anyway", e);
            }
            if (check != null && !check.get("clean").getAsBoolean()) {
                // 和 onState / onSettings 保持同一个契约：参数是一段 **JSON 文本**，
                // 前端自己 JSON.parse。直接 toJson(JsonObject) 会生成对象字面量，
                // 前端拿到的是 object 而不是 string，parse 立刻炸。
                execute("window.__hmcl && window.__hmcl.onLaunchCheck("
                        + JsonUtils.GSON.toJson(check.toString()) + ")");
                return;
            }
        }

        appearanceApi.reapplyOfflineSkin();
        // 主菜单左下角的启动器名只能改客户端（参数改不动，实测），
        // 放在这里是因为这是 UI 启动的必经之路。
        TitleBrand.patchQuietly(instance.getInstanceJarFile());
        LOG.info("[brand] startInstance " + instance.getId() + " jar=" + instance.getInstanceJarFile());
        GameDirectoryManager.setSelectedInstance(instance);
        Instances.launch(instance);
        // 记下启动时刻：退出时用它判断这一局动过哪些存档（只有动过的才备份）
        services.exits.markLaunched(instanceId);
        // 实例设了游戏窗口标题就在窗口出来后改掉。放在 launch 之后：
        // 先让游戏把窗口建出来，这里只负责轮询等待。
        try {
            String windowTitle = InstanceThemeService.windowTitleOf(instance.getId().toString());
            LOG.info("[theme] windowTitle of " + instance.getId() + " = '" + windowTitle + "'");
            if (!windowTitle.isBlank()) {
                // {version} 占位符在这里换：主题是静态配置，游戏版本可能被换掉
                windowTitle = windowTitle.replace("{version}", instance.getVersion().toString());
                WindowTitle.applyAsync(windowTitle);
            }
        } catch (Throwable e) {
            LOG.warning("Failed to apply instance window title", e);
        }
        push();
    }

    public void openFolder(String id) {
        HMCLGameInstance instance = InstanceLookup.find(id);
        if (instance != null) {
            Instances.openFolder(instance);
        }
    }

    /// 用系统默认浏览器打开一个链接（关于页的致谢名单用）。
    ///
    /// <p>页面里不能直接放 `<a href>`：壳把外部导航全拦了（`on_navigation` 只放行本地页面），
    /// 点了没反应还会把页面顶掉。所以链接只带 `data-url`，点击时走这里交给系统。
    public void openUrl(String url) {
        if (url == null) {
            return;
        }
        String target = url.trim();
        if (!(target.startsWith("https://") || target.startsWith("http://"))) {
            LOG.warning("[link] 非 http(s) 链接，已忽略: " + target);
            return;
        }
        try {
            java.awt.Desktop.getDesktop().browse(java.net.URI.create(target));
        } catch (Throwable e) {
            // Desktop 在无 AWT 环境的兜底：Windows 的 ShellExecute
            try {
                new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", target).start();
            } catch (Throwable e2) {
                LOG.warning("[link] 打不开 " + target, e2);
                toast("打不开链接：" + target);
            }
        }
    }

    // ==================== 杂项 ====================

    public void openLink(String url) {
        if (url == null || url.isBlank()) {
            return;
        }
        // 不能走 FXUtils.openLink：它内部用 FXUtils.thread(...) 投递，而壳模式下
        // JavaFX 的 Platform 没启动，任务永远排不上队 —— 点「打开登录页」没反应
        // 就是这么来的。直接用 AWT Desktop，纯 JDK，跟 UI 框架无关。
        try {
            if (java.awt.Desktop.isDesktopSupported()
                    && java.awt.Desktop.getDesktop().isSupported(java.awt.Desktop.Action.BROWSE)) {
                java.awt.Desktop.getDesktop().browse(java.net.URI.create(url));
                return;
            }
        } catch (Throwable e) {
            LOG.warning("Desktop.browse failed, falling back to rundll32: " + e);
        }
        // 兜底：Windows 上直接交给协议处理器
        try {
            new ProcessBuilder("rundll32.exe", "url.dll,FileProtocolHandler", url).start();
        } catch (Throwable e) {
            LOG.warning("Failed to open link: " + url, e);
        }
    }

    public void log(String message) {
        LOG.info("[web] " + message);
    }

    // ==================== 推送 ====================

    void push() {
        execute("window.__hmcl && window.__hmcl.onState("
                + JsonUtils.GSON.toJson(getState()) + ")");
    }

    /// 从任意线程推一段 JS。
    ///
    /// 启动进度、进程退出回调都跑在任务线程和 watch 线程上，不是 FX 线程。
    /// 壳模式走 SSE，写入本身安全；JavaFX 模式必须回 FX 线程，否则
    /// `executeScript` 抛 IllegalStateException、被 `execute` 吞掉 —— 不报错，消息直接没了。
    private void pushJs(String script) {
        if (channel != null) {
            execute(script);
            return;
        }
        try {
            Platform.runLater(() -> execute(script));
        } catch (IllegalStateException e) {
            // Toolkit 没起来（纯 HTTP 模式）：当前线程直接写
            execute(script);
        }
    }

    private void execute(String script) {
        // 换了壳之后没有 WebEngine，Java -> JS 走 channel（Tauri 模式是 SSE 推送）。
        // 上层 40 多处 execute("window.__hmcl.onXxx(...)") 一行不用改。
        WebChannel ch = channel;
        if (ch != null) {
            try {
                ch.eval(script);
            } catch (Exception e) {
                LOG.warning("Failed to push through channel", e);
            }
            return;
        }
        if (engine == null) {
            return;
        }
        try {
            engine.executeScript(script);
        } catch (Exception e) {
            LOG.warning("Failed to push to web view", e);
        }
    }

    // ==================== 图片工具 ====================

    private static boolean isDark() {
        var darkMode = FXUtils.DARK_MODE;
        return darkMode != null && darkMode.get();
    }

    private static String iconDataUrl(HMCLGameInstance instance) {
        try {
            return ImageCodec.toDataUrl(instance.getIconImage(), 64);
        } catch (Exception e) {
            return null;
        }
    }

}
