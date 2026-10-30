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
import javafx.beans.value.ChangeListener;
import javafx.beans.value.ObservableValue;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import javafx.scene.web.WebEngine;
import javafx.stage.DirectoryChooser;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorAccount;
import org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorServer;
import org.jackhuang.hmcl.auth.CharacterSelector;
import org.jackhuang.hmcl.auth.NoSelectedCharacterException;
import org.jackhuang.hmcl.auth.OperationCancelledException;
import org.jackhuang.hmcl.auth.yggdrasil.GameProfile;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.game.HMCLGameRepositorySnapshot;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.GameDirectory;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.GameInstanceIconType;
import org.jackhuang.hmcl.setting.GameSettings;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.ui.account.AddAuthlibInjectorServerPane;
import org.jackhuang.hmcl.ui.account.CreateAccountPane;
import org.jackhuang.hmcl.ui.account.MicrosoftAccountLoginPane;
import org.jackhuang.hmcl.ui.instances.Instances;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;
import org.jackhuang.hmcl.util.PortablePath;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.i18n.LocalizedText;
import org.jetbrains.annotations.Nullable;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/**
 * 暴露给 WebView 前端的方法集合。
 *
 * <p>约定：JS 侧只做展示，所有状态读取与变更都走这里；返回给 JS 的一律是 JSON 字符串。
 * 方法由 JavaScript 调用，运行在 JavaFX 线程上，耗时操作必须自己转后台。
 */
public final class WebBridge {

    private static final String PATCH_NOTES_URL = "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
    private static final String CONTENT_BASE = "https://launchercontent.mojang.com";
    /// 新闻点击跳这里。contentPath 是给启动器自己解析用的 .json，
    /// 不是给人看的页面，别拿它当链接。
    private static final String MINECRAFT_ARTICLE_BASE = "https://www.minecraft.net/zh-hans/article/";

    private final WebEngine engine;
    private final WebUIPage page;
    private final AppearanceStore appearance = AppearanceStore.getInstance();

    /// 非 JavaFX 宿主（Tauri 壳）时使用；为 null 则回落到 engine.executeScript
    private volatile WebChannel channel;

    /// 壳模式的离屏预览画布；JavaFX 模式为 null（用 WebUIPage 自带的那块）
    private volatile OffscreenPreview offscreen;

    /// 衣柜图渲染器（正 + 背）。三个皮肤就是六次 3D 渲染，按素材 id 缓存住
    private volatile SkinGallery skinGallery;
    private final Map<String, String> skinPreviewCache = new ConcurrentHashMap<>();

    /// 实例目录占用缓存：id -> bytes
    private final Map<String, Long> instanceSizes = new ConcurrentHashMap<>();
    private final Set<String> pendingSizes = ConcurrentHashMap.newKeySet();

    private volatile String newsJson;
    private volatile boolean newsLoading;

    WebBridge(WebEngine engine, WebUIPage page) {
        this.engine = engine;
        this.page = page;
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
        this.offscreen = preview;
    }

    /// 衣柜图渲染器
    void setSkinGallery(SkinGallery gallery) {
        this.skinGallery = gallery;
    }

    /// 皮肤卡缩略图：优先用 3D 衣柜图（正+背），拿不到再退回旧的平面切片
    private String skinPreview(AppearanceStore.Asset asset, Image texture) {
        String key = asset.getId() + "|" + asset.getModel();
        String cached = skinPreviewCache.get(key);
        if (cached != null) {
            return cached;
        }
        boolean slim = "slim".equals(asset.getModel());
        SkinGallery gallery = skinGallery;
        String url = gallery == null ? null : gallery.render(texture, slim);
        if (url == null) {
            url = AppearanceThumbnails.skinFront(texture, slim);
        }
        if (url != null) {
            skinPreviewCache.put(key, url);
        }
        return url;
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

        // 选中账号变了就重挂一次纹理绑定。正版账号的皮肤/披风都是异步到手的，
        // 不挂绑定的话缓存永远是空的（「账号当前皮肤」卡片空白、披风渲染不出来）。
        // 放在这里而不是 push()：页面首次加载走的是 getState，不一定会有 push。
        attachAccountTextures(Accounts.getSelectedAccount());

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
        root.addProperty("defaultAvatar", defaultAvatarDataUrl());
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
        json.addProperty("avatar", avatarDataUrl(account));
        json.addProperty("selected", selected);
        return json;
    }

    private static String displayName(Account account) {
        String name = account.getProfileName();
        return name != null && !name.isBlank() ? name : account.getProfileID().toString();
    }

    /// 登录渠道文案：离线登录 / 微软登录 / 皮肤站名字（LittleSkin 等）
    private static String channel(Account account) {
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

    private JsonObject instanceJson(HMCLGameInstance instance) {
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
                item.addProperty("preview", imageToDataUrl(type.getIcon(), 64));
            } catch (Exception e) {
                item.addProperty("preview", "");
            }
            array.add(item);
        }
        return array;
    }

    // ==================== 实例操作 ====================

    public void selectInstance(String id) {
        HMCLGameInstance instance = findInstance(id);
        if (instance == null) {
            return;
        }
        GameDirectoryManager.setSelectedInstance(instance);
        push();
    }

    public void launch(String id) {
        HMCLGameInstance instance = findInstance(id);
        if (instance == null) {
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

    /// 真正拉起游戏的唯一入口。
    ///
    /// 没有账号就不让启动：HMCL 拿不到 AuthInfo 会抛异常，界面上只剩一句
    /// 看不懂的堆栈。这里提前拦住并说清楚该怎么办。
    private void startInstance(HMCLGameInstance instance) {
        if (Accounts.getSelectedAccount() == null) {
            toast("请添加账号后再启动实例");
            return;
        }
        reapplyOfflineSkin();
        // 主菜单左下角的启动器名只能改客户端（参数改不动，实测），
        // 放在这里是因为这是 UI 启动的必经之路。
        TitleBrand.patchQuietly(instance.getInstanceJarFile());
        LOG.info("[brand] startInstance " + instance.getId() + " jar=" + instance.getInstanceJarFile());
        GameDirectoryManager.setSelectedInstance(instance);
        Instances.launch(instance);
        push();
    }

    /// 启动前把衣柜里存的皮肤重新套到离线账号上。
    ///
    /// 离线账号的皮肤只存在内存里（），重启启动器就没了；
    /// 而离线皮肤的注入依赖这个字段——没有它，authlib-injector 拿不到纹理，
    /// 游戏就会按玩家名去官方拉皮肤（于是显示成同名正版玩家的皮肤）。
    /// 这里每次启动前从 AppearanceStore 重新读一遍，成本就是读一个 JSON。
    private void reapplyOfflineSkin() {
        Account account = Accounts.getSelectedAccount();
        if (!(account instanceof org.jackhuang.hmcl.auth.offline.OfflineAccount offlineAccount)) {
            return;
        }
        try {
            AppearanceStore.State state = appearance.stateOf(selectedAccountId());
            if (state == null) {
                return;
            }
            AppearanceStore.Asset skinAsset = appearance.find(AppearanceStore.Kind.SKIN, state.getSkin());
            AppearanceStore.Asset capeAsset = appearance.find(AppearanceStore.Kind.CAPE, state.getCape());
            offlineAccount.setSkin(new org.jackhuang.hmcl.auth.offline.Skin(
                    org.jackhuang.hmcl.auth.offline.Skin.Type.LOCAL_FILE,
                    null,
                    "slim".equals(state.getModel()) ? org.jackhuang.hmcl.auth.yggdrasil.TextureModel.SLIM
                            : org.jackhuang.hmcl.auth.yggdrasil.TextureModel.WIDE,
                    skinAsset != null ? appearance.fileOf(AppearanceStore.Kind.SKIN, skinAsset.getId()).toString() : null,
                    capeAsset != null ? appearance.fileOf(AppearanceStore.Kind.CAPE, capeAsset.getId()).toString() : null));
        } catch (Throwable e) {
            LOG.warning("Failed to reapply offline skin", e);
        }
    }

    public void openFolder(String id) {
        HMCLGameInstance instance = findInstance(id);
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

    // ==================== 启动器自身更新 ====================

    /// 已经下载好、等着替换的更新包。
    private volatile Path launcherUpdateArchive;

    /// 当前版本号（设置页「关于」显示用）。
    public String launcherVersion() {
        return UpdateService.currentVersion();
    }

    /// 查 GitHub Releases 上的最新版本，结果通过 onLauncherUpdate 推回前端。
    public void checkLauncherUpdate() {
        Thread worker = new Thread(() -> {
            try {
                pushLauncherUpdate(UpdateService.checkLatest(), null);
            } catch (Throwable e) {
                LOG.warning("检查更新失败", e);
                pushLauncherUpdate(null, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }, "launcher-update-check");
        worker.setDaemon(true);
        worker.start();
    }

    /// 下载更新包。进度通过 onLauncherUpdateProgress 推回，0–100。
    public void downloadLauncherUpdate(String url, long size) {
        Thread worker = new Thread(() -> {
            try {
                Path dir = org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("update");
                Files.createDirectories(dir);
                // 后缀要跟内容一致：applyUpdate 按 .jar 走热更新（只换 jar）、按 .zip 走整包解压
                String suffix = url != null && url.toLowerCase().contains(".jar") ? ".jar" : ".zip";
                Path target = dir.resolve("update-" + System.currentTimeMillis() + suffix);
                UpdateService.download(url, target, size, percent -> pushLauncherUpdateProgress((int) percent));
                launcherUpdateArchive = target;
                pushLauncherUpdateProgress(100);
                pushLauncherUpdateReady(target.toString());
            } catch (Throwable e) {
                LOG.warning("下载更新包失败", e);
                pushLauncherUpdate(null, "下载失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
            }
        }, "launcher-update-download");
        worker.setDaemon(true);
        worker.start();
    }

    /// 装更新：写一个延迟脚本，退出后由它解压覆盖并重新启动。
    public void applyLauncherUpdate() {
        Path archive = launcherUpdateArchive;
        if (archive == null || !Files.isRegularFile(archive)) {
            toast("还没有下载好更新包");
            return;
        }
        // 安装目录就是 exe 所在目录；壳启动 Java 时把工作目录设成了那里
        Path installDir = Path.of(System.getProperty("user.dir"));
        try {
            UpdateService.applyUpdate(archive, installDir);
        } catch (Throwable e) {
            LOG.warning("启动更新脚本失败", e);
            toast("更新失败：" + (e.getMessage() == null ? e.toString() : e.getMessage()));
            return;
        }
        toast("正在退出，马上重启完成更新");
        Thread exit = new Thread(() -> {
            try {
                Thread.sleep(900);
            } catch (InterruptedException ignored) {
            }
            System.exit(0);
        }, "launcher-update-exit");
        exit.setDaemon(false);
        exit.start();
    }

    private void pushLauncherUpdate(@Nullable JsonObject data, @Nullable String error) {
        JsonObject root = new JsonObject();
        root.addProperty("ok", error == null);
        if (error != null) {
            root.addProperty("error", error);
        }
        if (data != null) {
            root.add("data", data);
        }
        execute("window.__hmcl && window.__hmcl.onLauncherUpdate("
                + JsonUtils.GSON.toJson(JsonUtils.GSON.toJson(root)) + ")");
    }

    private void pushLauncherUpdateProgress(int percent) {
        execute("window.__hmcl && window.__hmcl.onLauncherUpdateProgress(" + percent + ")");
    }

    private void pushLauncherUpdateReady(String path) {
        execute("window.__hmcl && window.__hmcl.onLauncherUpdateReady("
                + JsonUtils.GSON.toJson(path) + ")");
    }

    // ==================== 导入已有游戏目录 ====================

    /// 让用户挑一个已有的游戏目录导入。
    ///
    /// 「已有」指 PCL2 / HMCL / 官方启动器 / 整合包解出来的那份 `.minecraft`。
    /// 用户不需要知道该点哪一层：选中 `.minecraft` 的父目录也行，
    /// [`#resolveGameDirectory`] 会自己往下找到带 `versions` 的那一层。
    public void chooseGameDirectory() {
        DirectoryChooser chooser = new DirectoryChooser();
        chooser.setTitle("选择游戏目录");
        // 壳模式没有 JavaFX 窗口，owner 为 null —— JDK 允许无主对话框
        Path chosen = Controllers.showDialog(chooser);
        if (chosen == null) {
            return; // 用户取消
        }
        importGameDirectory(chosen.toString());
    }

    /// 路径已知时直接导入。
    ///
    /// 走完整个流程：收敛目录 → 去重 → 加成游戏目录 → 切过去 → 数版本 → 推状态。
    /// 整个过程都在 FX 线程上（调用方就在 FX 线程），只碰目录列表和设置文件，够快。
    public void importGameDirectory(String rawPath) {
        if (rawPath == null || rawPath.isBlank()) {
            return;
        }

        JsonObject result = new JsonObject();
        try {
            Path dir = resolveGameDirectory(Path.of(rawPath));

            GameDirectory target = findGameDirectory(dir);
            if (target == null) {
                target = new GameDirectory(
                        GameDirectoryManager.newGameDirectoryId(),
                        LocalizedText.plain(suggestDirectoryName(dir)),
                        PortablePath.fromPath(dir));
                // 绝对路径归用户级配置，相对路径归工作区配置（和 GameDirectoryPage 一致）
                if (target.getPath().isAbsolute()) {
                    if (SettingsManager.isUserGameDirectoriesReadOnly()) {
                        SettingsManager.forceOverwriteUserGameDirectories();
                    }
                    GameDirectoryManager.addUserGameDirectory(target);
                } else {
                    if (SettingsManager.isLocalGameDirectoriesReadOnly()) {
                        SettingsManager.forceOverwriteLocalGameDirectories();
                    }
                    GameDirectoryManager.addLocalGameDirectory(target);
                }
                result.addProperty("added", true);
            } else {
                result.addProperty("added", false);
            }

            GameDirectoryManager.setSelectedGameDirectory(target);

            // 版本数直接数目录，不问仓库：仓库是异步加载的，这一刻它一定还没刷完
            int versions = countVersionDirectories(dir);
            result.addProperty("ok", true);
            result.addProperty("path", dir.toString());
            result.addProperty("name", GameDirectoryManager.getGameDirectoryDisplayName(target));
            result.addProperty("versions", versions);

            watchRepositoryLoaded();
            push();
        } catch (Exception e) {
            LOG.warning("Failed to import game directory " + rawPath, e);
            result.addProperty("ok", false);
            result.addProperty("error", e.getMessage() != null ? e.getMessage() : String.valueOf(e));
        }

        execute("window.__hmcl && window.__hmcl.onGameDirectoryImported("
                + JsonUtils.GSON.toJson(result.toString()) + ")");
    }

    /// 把用户选的目录收敛成真正的游戏目录（带 `versions/` 的那一层）。
    private static Path resolveGameDirectory(Path chosen) throws IOException {
        Path dir = chosen.toAbsolutePath().normalize();
        if (!Files.isDirectory(dir)) {
            throw new IOException("目录不存在：" + dir);
        }
        if (Files.isDirectory(dir.resolve("versions"))) {
            return dir;
        }
        // 选的是装着 .minecraft 的那一层（PCL2 便携版就是这个结构）
        if (Files.isDirectory(dir.resolve(".minecraft"))) {
            return dir.resolve(".minecraft");
        }
        // 大小写不一致的 `.Minecraft` 也认
        try (Stream<Path> list = Files.list(dir)) {
            for (Path child : list.toList()) {
                if (Files.isDirectory(child)
                        && ".minecraft".equalsIgnoreCase(child.getFileName().toString())
                        && Files.isDirectory(child.resolve("versions"))) {
                    return child;
                }
            }
        } catch (IOException e) {
            // 没权限列目录，落到下面统一的报错
        }
        throw new IOException("这个目录里没有 versions 文件夹，不像是 Minecraft 游戏目录");
    }

    /// 游戏目录的默认名字。
    ///
    /// 直接拿 `getFileName()` 会得到一堆 `.minecraft`，三个目录在列表里没法区分。
    /// 这种情况退一层用父目录名（`PCL2` / `MCLab` / `HMCL`），正好是用户认得的启动器目录。
    private static String suggestDirectoryName(Path dir) {
        Path fileName = dir.getFileName();
        String name = fileName != null ? fileName.toString() : "";
        Path parent = dir.getParent();
        if ((".minecraft".equalsIgnoreCase(name) || name.isBlank()) && parent != null
                && parent.getFileName() != null) {
            String outer = parent.getFileName().toString();
            if (!outer.isBlank() && !outer.endsWith(":")) {
                return outer;
            }
        }
        return name.isBlank() ? "游戏目录" : name;
    }

    /// 数一下 `versions/` 下有 `<名字>.json` 的目录——和 HMCL 认实例的条件一致。
    private static int countVersionDirectories(Path gameDir) {
        Path versions = gameDir.resolve("versions");
        if (!Files.isDirectory(versions)) {
            return 0;
        }
        try (Stream<Path> list = Files.list(versions)) {
            return (int) list.filter(Files::isDirectory)
                    .filter(d -> Files.isRegularFile(d.resolve(d.getFileName() + ".json")))
                    .count();
        } catch (IOException e) {
            return 0;
        }
    }

    /// 同一个路径已经在列表里就别重复加：重复条目会各开一个仓库，
    /// 实例列表里看着一模一样，用户分不出点哪个。
    @Nullable
    private static GameDirectory findGameDirectory(Path dir) {
        String target = PortablePath.fromPath(dir).getPath();
        for (GameDirectory gameDirectory : GameDirectoryManager.getGameDirectories()) {
            String path = gameDirectory.getPath().getPath();
            if (path.equalsIgnoreCase(target)) {
                return gameDirectory;
            }
            if (!gameDirectory.getPath().isAbsolute()) {
                try {
                    Path resolved = Path.of(path).toAbsolutePath().normalize();
                    if (resolved.toString().equalsIgnoreCase(target)) {
                        return gameDirectory;
                    }
                } catch (Exception ignored) {
                    // 相对路径解析失败就当不匹配
                }
            }
        }
        return null;
    }

    /// 新目录的仓库要加载一遍才有实例。加载完会发布一次快照，这里挂一次性监听，
    /// 收到就再推一次状态——否则用户看到的是空列表，会以为导入失败。
    private void watchRepositoryLoaded() {
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            ChangeListener<HMCLGameRepositorySnapshot> once = new ChangeListener<>() {
                @Override
                public void changed(ObservableValue<? extends HMCLGameRepositorySnapshot> observable,
                                    @Nullable HMCLGameRepositorySnapshot oldValue,
                                    @Nullable HMCLGameRepositorySnapshot newValue) {
                    observable.removeListener(this);
                    Platform.runLater(WebBridge.this::push);
                }
            };
            repository.snapshotProperty().addListener(once);
        } catch (Exception e) {
            LOG.warning("Failed to watch repository loading", e);
        }
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
        HMCLGameInstance instance = findInstance(id);
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
            push();
        } catch (Exception e) {
            LOG.warning("Failed to set instance icon", e);
            toast("设置图标失败：" + e.getMessage());
        }
    }

    public void setBuiltinIcon(String id, String typeName) {
        HMCLGameInstance instance = findInstance(id);
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
            push();
        } catch (Exception e) {
            LOG.warning("Failed to set builtin icon " + typeName, e);
        }
    }

    private static HMCLGameInstance findInstance(String id) {
        if (id == null) {
            return null;
        }
        HMCLGameInstance selected = GameDirectoryManager.getSelectedInstance();
        if (selected != null && selected.getId().toString().equals(id)) {
            return selected;
        }
        try {
            return GameDirectoryManager.getSelectedRepository().getDisplayInstances()
                    .filter(it -> it.getId().toString().equals(id))
                    .findFirst()
                    .orElse(null);
        } catch (Exception e) {
            return null;
        }
    }

    // ==================== 账号操作 ====================

    /// 三条登录路径全部在壳里自绘。
    ///
    /// 为什么不继续用 `Controllers.dialog(new XxxPane())`：壳模式没有 JavaFX 窗口，
    /// 那些弹窗根本不会出现——点了「登录」什么都不会发生，用户只会以为坏了。

    /// 离线登录：只填用户名，不做任何验证。
    public void loginOffline(String username) {
        if (username == null || username.isBlank()) {
            pushLogin("offline", false, "请填写用户名");
            return;
        }
        String name = username.trim();

        Task.runAsync(() -> {
            try {
                Account account = Accounts.FACTORY_OFFLINE.create(
                        new AutoCharacterSelector(), name, "", null, null);
                completeLogin(account);
                pushLogin("offline", true, name);
            } catch (Throwable e) {
                LOG.warning("Offline login failed", e);
                pushLogin("offline", false, localize(e));
            }
        }).start();
    }

    /// 微软正版登录：走设备码（DEVICE）流程。
    ///
    /// 另一条 AUTHORIZATION_CODE 流程要起一个本机回调服务、还要弹浏览器窗口，
    /// 壳里做不了；设备码只要能显示一串码和网址就行，正好适合自绘 UI。
    /// 这个构建能不能用微软正版登录（有没有内置 client_id）。
    ///
    /// <p>发行版在 Mojang 审核通过前不发 client_id，前端据此把入口置灰，
    /// 免得用户点了才看到一句失败提示。
    public boolean isMicrosoftAuthAvailable() {
        String id = Accounts.OAUTH_CALLBACK.getClientId();
        return id != null && !id.isEmpty();
    }

    public void loginMicrosoft() {
        // 快照构建没有内置 OAuth client_id（HMCL 在打包时才注入），
        // 没有它微软那头的设备码请求会直接 400。先在这里拦住，给一句人话，
        // 别把 AADSTS900144 这种原始报错甩给用户。
        if (Accounts.OAUTH_CALLBACK.getClientId() == null
                || Accounts.OAUTH_CALLBACK.getClientId().isEmpty()) {
            pushLogin("microsoft", false,
                    "本版暂未开放微软正版登录，请使用离线登录或外置认证登录");
            return;
        }

        hookMicrosoftDeviceCode();
        // 上一次的轮询线程先踢一脚：用户可能没关弹窗就又点了一次，
        // 那个线程还在 sleep 里等着。它的结果会因为没有序号而被丢弃，
        // 但没必要让它白占一个线程跑满 15 分钟。
        Thread previous = microsoftLoginThread;
        if (previous != null && previous != Thread.currentThread()) {
            previous.interrupt();
        }
        // 标记是单向的，这里必须清掉；否则新的一次登录会在第一个 250ms 分片里就自己终止
        Accounts.OAUTH_CALLBACK.resetCancel();
        final int seq = ++microsoftLoginSeq;
        pushLoginStage("microsoft", "正在申请登录代码…");

        Task.supplyAsync(() -> {
            // 记住跑轮询的线程：用户点取消时 interrupt 它，让它立刻从 sleep 里醒来。
            // 光靠标志位最多要等一个分片（250ms）才生效，而 sleep 被中断是立即的。
            microsoftLoginThread = Thread.currentThread();
            // 走 HMCL 现成的工厂：内部会触发 OAUTH_CALLBACK.onGrantDeviceCode
            return Accounts.FACTORY_MICROSOFT.create(null, null, null, null,
                    org.jackhuang.hmcl.auth.OAuth.GrantFlow.DEVICE);
        }).whenComplete(Schedulers.javafx(), (account, exception) -> {
            // 序号对不上说明这次登录已经被取消、或者用户又重新发起了另一次。
            // 无论结果是成功还是失败都丢掉：界面上早就没有它对应的弹窗了。
            if (seq != microsoftLoginSeq) {
                LOG.info("Microsoft login result ignored (cancelled or superseded)");
                // 被 interrupt 打断的任务会把中断标志留在池化线程上，
                // 不清掉的话下一个复用这个线程的任务会一上来就抛 InterruptedException
                Thread.interrupted();
                return;
            }
            if (exception != null) {
                // 用户自己点的取消：不是故障，别弹红字。
                // 前端在点取消时已经把弹窗收掉了，这里再推一条「登录失败」只会让人以为出错了。
                if (isCancellation(exception)) {
                    LOG.info("Microsoft login cancelled by user");
                    return;
                }
                LOG.warning("Microsoft login failed", exception);
                pushLogin("microsoft", false, localize(exception));
                return;
            }
            try {
                completeLogin((Account) account);
                pushLogin("microsoft", true, account.getProfileName());
            } catch (Exception e) {
                pushLogin("microsoft", false, String.valueOf(e));
            }
        }).start();
    }

    /// 每次登录分配一个序号。取消或重新发起后，旧的那次跑完时序号对不上，
    /// 结果直接丢弃——否则被取消的登录只要在浏览器里授权成功，账号照样会冒出来。
    private volatile int microsoftLoginSeq = 0;

    /// 正在跑设备码轮询的线程，取消时用来 interrupt。
    private volatile Thread microsoftLoginThread = null;

    /// 用户主动取消微软登录。
    ///
    /// 两件事一起做：置标志（让下一片 sleep 退出）+ interrupt（让当前这一片立刻退出）。
    /// 只置标志的话，取消动作要等最多一个分片才生效；只 interrupt 的话，
    /// 如果线程正好卡在 HTTP 请求里，中断不一定会被理会，标志能兜住。
    public void cancelMicrosoftLogin() {
        Accounts.OAUTH_CALLBACK.cancel();
        // 序号 +1 把这次登录「作废」，之后再回来的结果都不会被采纳
        ++microsoftLoginSeq;
        Thread t = microsoftLoginThread;
        if (t != null) {
            t.interrupt();
        }
        LOG.info("Microsoft login cancelled by user");
    }

    /// 判断异常链里是不是「用户取消」。
    private static boolean isCancellation(Throwable throwable) {
        Throwable t = throwable;
        // 上限 8 层：正常异常链不会更深，加个上限是防止某个实现把 cause 指回自己
        for (int i = 0; t != null && i < 8; i++) {
            if (t instanceof OperationCancelledException) {
                return true;
            }
            Throwable cause = t.getCause();
            if (cause == t) {
                break;
            }
            t = cause;
        }
        return false;
    }

    /// 设备码流程的「用户码 / 验证地址」只有注册了监听才拿得到。
    ///
    /// HMCL 是在 `MicrosoftAccountLoginPane` 里注册的，壳模式根本不会创建那个面板，
    /// 于是 `grantDeviceCode` 事件没有订阅者：前端永远停在「正在申请登录代码…」，
    /// 后台却已经进到 15 分钟的轮询里——看起来就是「点了没反应、整个卡住」。
    ///
    /// EventManager 只支持注册、没有反注册，所以这里用一个实例标记保证只装一次。
    private boolean microsoftHookInstalled = false;

    private void hookMicrosoftDeviceCode() {
        if (microsoftHookInstalled) {
            return;
        }
        microsoftHookInstalled = true;
        Accounts.OAUTH_CALLBACK.onGrantDeviceCode.register(event -> {
            JsonObject json = new JsonObject();
            json.addProperty("flow", "microsoft");
            json.addProperty("code", event.getUserCode());
            json.addProperty("url", event.getVerificationUri());
            execute("window.__hmcl && window.__hmcl.onMicrosoftCode("
                    + JsonUtils.GSON.toJson(json.toString()) + ")");
        });
        Accounts.OAUTH_CALLBACK.onLoginCompletedDeviceCode.register(event ->
                pushLoginStage("microsoft", "已授权，正在获取角色信息…"));
    }

    /// 外置认证（authlib-injector / 皮肤站）登录。
    public void loginAuthlib(String serverUrl, String username, String password) {
        if (serverUrl == null || serverUrl.isBlank()) {
            pushLogin("authlib", false, "请先选择一个皮肤站");
            return;
        }
        if (username == null || username.isBlank() || password == null || password.isEmpty()) {
            pushLogin("authlib", false, "请填写邮箱/用户名和密码");
            return;
        }

        AuthlibInjectorServer server = findAuthlibServer(serverUrl);
        if (server == null) {
            pushLogin("authlib", false, "皮肤站不存在，请先在列表里添加：" + serverUrl);
            return;
        }

        pushLoginStage("authlib", "正在向 " + server.getName() + " 验证…");

        String user = username.trim();
        Task.runAsync(() -> {
            try {
                Account account = Accounts.FACTORY_AUTHLIB_INJECTOR.create(
                        new AutoCharacterSelector(), user, password, null, server);
                completeLogin(account);
                pushLogin("authlib", true, account.getProfileName());
            } catch (Throwable e) {
                LOG.warning("Authlib login failed", e);
                pushLogin("authlib", false, localize(e));
            }
        }).start();
    }

    /// 按 URL 在已添加的皮肤站里找（忽略结尾斜杠的差异）。
    @Nullable
    private static AuthlibInjectorServer findAuthlibServer(String url) {
        String target = url.trim();
        while (target.endsWith("/")) {
            target = target.substring(0, target.length() - 1);
        }
        try {
            for (AuthlibInjectorServer server : SettingsManager.getAuthlibInjectorServers()) {
                String current = server.getUrl();
                while (current.endsWith("/")) {
                    current = current.substring(0, current.length() - 1);
                }
                if (current.equalsIgnoreCase(target)) {
                    return server;
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to look up authlib server", e);
        }
        return null;
    }

    /// 把异常翻成能给人看的一句话（带账号相关的本地化文案）。
    private static String localize(Throwable t) {
        if (t instanceof Exception e) {
            try {
                return Accounts.localizeErrorMessage(e);
            } catch (Exception ignored) {
                // 落到下面
            }
        }
        return t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
    }

    /// 探一个 URL，返回「是否成功 / 字节数 / 耗时 / 头部片段」。
    ///
    /// 用来判断哪些站点的接口在当前网络下能直接访问。
    /// 拿不到状态码（HMCL 的 HttpRequest 对非 2xx 直接抛异常），
    /// 所以失败时把异常消息一并带出来，里面含 HTTP 码。
    public String probeUrl(String url) {
        long t0 = System.currentTimeMillis();
        try {
            String body = org.jackhuang.hmcl.util.io.HttpRequest.GET(url)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                    .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
                    .getString();
            String head = body.length() > 160 ? body.substring(0, 160) : body;
            return "OK | " + body.length() + "B | " + (System.currentTimeMillis() - t0) + "ms | "
                    + head.replaceAll("[\r\n]+", " ");
        } catch (Exception e) {
            return "ERR | " + (System.currentTimeMillis() - t0) + "ms | "
                    + e.getClass().getSimpleName() + ": " + e.getMessage();
        }
    }

    /// 前端打开外置认证弹窗时调一次，把列表推回去
    public void requestAuthlibServers() {
        pushAuthlibServers(true, null);
    }

    /// 当前可选的皮肤站列表。LittleSkin 由 HMCL 的 AuthlibInjectorServerList 内置。
    public String authlibServers() {
        JsonArray array = new JsonArray();
        try {
            for (AuthlibInjectorServer server : SettingsManager.getAuthlibInjectorServers()) {
                JsonObject o = new JsonObject();
                o.addProperty("url", server.getUrl());
                o.addProperty("name", server.getName());
                o.addProperty("host", server.getDisplayHostUrl());
                o.addProperty("nonEmailLogin", server.isNonEmailLogin());
                o.addProperty("builtin", server.getUrl().startsWith(
                        org.jackhuang.hmcl.setting.AuthlibInjectorServerList.LITTLE_SKIN_URL));
                array.add(o);
            }
        } catch (Exception e) {
            LOG.warning("Failed to list authlib servers", e);
        }
        return JsonUtils.GSON.toJson(array);
    }

    /// 添加自定义皮肤站。
    ///
    /// 只让用户填 API 根地址——名字和是否支持非邮箱登录都是从
    /// `<url>/authlib-injector` 那串元数据里读出来的，手填容易和实际对不上。
    /// `locateServer` 是同步网络请求，必须在后台线程跑。
    public void addAuthlibServer(String url) {
        if (url == null || url.isBlank()) {
            pushAuthlibServers(false, "请填写皮肤站 API 地址");
            return;
        }
        String target = url.trim();
        Task.runAsync(() -> {
            try {
                AuthlibInjectorServer server = AuthlibInjectorServer.locateServer(target);
                // 同地址不重复加
                for (AuthlibInjectorServer existing : SettingsManager.getAuthlibInjectorServers()) {
                    if (existing.getUrl().equalsIgnoreCase(server.getUrl())) {
                        pushAuthlibServers(true, null);
                        return;
                    }
                }
                if (SettingsManager.isAuthlibInjectorServersReadOnly()) {
                    SettingsManager.forceOverwriteAuthlibInjectorServers();
                }
                SettingsManager.getAuthlibInjectorServers().add(server);
                pushAuthlibServers(true, null);
            } catch (Throwable e) {
                LOG.warning("Failed to add authlib server " + target, e);
                pushAuthlibServers(false, "连不上这个皮肤站，确认地址是 yggdrasil API 根路径");
            }
        }).start();
    }

    /// 移除自定义皮肤站（内置的 LittleSkin 不给删）。
    public void removeAuthlibServer(String url) {
        if (url == null || url.isBlank()) {
            return;
        }
        try {
            if (SettingsManager.isAuthlibInjectorServersReadOnly()) {
                SettingsManager.forceOverwriteAuthlibInjectorServers();
            }
            SettingsManager.getAuthlibInjectorServers().removeIf(
                    s -> s.getUrl().equalsIgnoreCase(url));
        } catch (Exception e) {
            LOG.warning("Failed to remove authlib server " + url, e);
        }
        pushAuthlibServers(true, null);
    }

    /// 账号加入列表 + 选中 + 推状态。三条登录路径共用。
    private void completeLogin(Account account) {
        Platform.runLater(() -> {
            try {
                if (!Accounts.getAccounts().contains(account)) {
                    Accounts.getAccounts().add(account);
                }
                Accounts.setSelectedAccount(account);
                push();
            } catch (Exception e) {
                LOG.warning("Failed to register account", e);
            }
        });
    }

    private void pushLogin(String flow, boolean ok, String message) {
        JsonObject json = new JsonObject();
        json.addProperty("flow", flow);
        json.addProperty("ok", ok);
        json.addProperty("message", message == null ? "" : message);
        execute("window.__hmcl && window.__hmcl.onLoginResult("
                + JsonUtils.GSON.toJson(json.toString()) + ")");
    }

    private void pushLoginStage(String flow, String stage) {
        JsonObject json = new JsonObject();
        json.addProperty("flow", flow);
        json.addProperty("stage", stage);
        execute("window.__hmcl && window.__hmcl.onLoginStage("
                + JsonUtils.GSON.toJson(json.toString()) + ")");
    }

    private void pushAuthlibServers(boolean ok, @Nullable String error) {
        JsonObject json = new JsonObject();
        json.addProperty("ok", ok);
        json.addProperty("error", error);
        json.addProperty("servers", authlibServers());
        execute("window.__hmcl && window.__hmcl.onAuthlibServers("
                + JsonUtils.GSON.toJson(json.toString()) + ")");
    }

    /// 角色选择器：外置认证账号可能有多个角色。
    ///
    /// HMCL 会弹窗让用户选；壳里为了不把登录流程切成两段，先自动取第一个。
    /// 只有一个角色的情况是绝大多数，多角色的少数派可以在启动器外改。
    private static final class AutoCharacterSelector implements CharacterSelector {
        @Override
        public GameProfile select(org.jackhuang.hmcl.auth.yggdrasil.YggdrasilService service,
                                  List<GameProfile> profiles) throws NoSelectedCharacterException {
            if (profiles == null || profiles.isEmpty()) {
                throw new NoSelectedCharacterException();
            }
            if (profiles.size() > 1) {
                LOG.info("Account has " + profiles.size() + " characters, using the first: "
                        + profiles.get(0).getName());
            }
            return profiles.get(0);
        }
    }

    public void selectAccount(String uuid) {
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                // 换了账号，上一个账号的草稿必须丢掉，否则会把 A 的选择带进 B
                appearanceDraft = null;
                Accounts.setSelectedAccount(account);
                push();
                return;
            }
        }
    }

    /// 离线账号改名。
    ///
    /// 离线账号的 UUID 是「OfflinePlayer:<名字>」算出来的，改名字等于换一个人，
    /// 所以这里不是原地改字段，而是「建新的 + 替换旧的」。名字非法时直接拒绝，
    /// 校验规则同 HMCL（`^[A-Za-z0-9_]+$`，≤16 字符）。
    public void renameAccount(String uuid, String newName) {
        String name = newName == null ? "" : newName.trim();
        if (!isValidProfileName(name)) {
            toast("用户名只能用英文字母、数字和下划线，且不超过 16 个字符");
            return;
        }
        Account target = null;
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                target = account;
                break;
            }
        }
        if (target == null) {
            return;
        }
        if (!(target instanceof org.jackhuang.hmcl.auth.offline.OfflineAccount)) {
            toast("只有离线账号支持改名");
            return;
        }
        if (displayName(target).equals(name)) {
            return;
        }

        Account old = target;
        boolean wasSelected = Objects.equals(Accounts.getSelectedAccount(), old);
        Task.runAsync(() -> {
            try {
                Account renamed = Accounts.FACTORY_OFFLINE.create(
                        new AutoCharacterSelector(), name, "", null, null);
                // 外观状态是按 accountID 存的，改名前先把它挪到新 id 上，
                // 否则用户会发现「改个名字皮肤没了」
                appearance.moveState(old.getAccountID().toString(),
                        renamed.getAccountID().toString());

                int index = Accounts.getAccounts().indexOf(old);
                Accounts.getAccounts().remove(old);
                if (index >= 0 && index <= Accounts.getAccounts().size()) {
                    Accounts.getAccounts().add(index, renamed);
                } else {
                    Accounts.getAccounts().add(renamed);
                }
                if (wasSelected) {
                    Accounts.setSelectedAccount(renamed);
                }
                push();
                toast("已改名为 " + name);
            } catch (Throwable e) {
                LOG.warning("Failed to rename account", e);
                toast("改名失败：" + localize(e));
            }
        }).start();
    }

    /// 复制文本到系统剪贴板。
    ///
    /// 不用前端的 navigator.clipboard：WebView2 里 tauri.localhost 属于非安全上下文，
    /// 剪贴板写权限要看权限策略，实测时好时坏。走 Java 侧一次就稳。
    public void copyText(String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        try {
            org.jackhuang.hmcl.ui.FXUtils.copyText(text, "已复制到剪贴板");
        } catch (Exception e) {
            LOG.warning("Failed to copy text", e);
        }
    }

    /// 用户名合法性：和 HMCL 的离线登录校验一致（CreateAccountPane.USERNAME_CHECKER_PATTERN）
    private static boolean isValidProfileName(String name) {
        return name != null && !name.isEmpty() && name.length() <= 16
                && name.matches("^[A-Za-z0-9_]+$");
    }

    public void removeAccount(String uuid) {
        Account target = null;
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                target = account;
                break;
            }
        }
        if (target == null) {
            return;
        }
        Account account = target;
        if (Accounts.canRemoveAccount(account)) {
            Accounts.getAccounts().remove(account);
            push();
        } else {
            Accounts.getAccounts().remove(account);
            push();
        }
    }

    // ==================== 动态（Mojang 官方更新日志） ====================

    public void requestNews() {
        if (newsJson != null) {
            pushNews(newsJson);
            return;
        }
        if (newsLoading) {
            return;
        }
        newsLoading = true;

        Task.runAsync(() -> {
            String json;
            try {
                json = fetchPatchNotes();
                // 只缓存成功结果：失败时不写缓存，下次进主页会重试。
                // 否则国内网络一次超时，这个启动器就永远显示「动态加载失败」。
                newsJson = json;
            } catch (Exception e) {
                LOG.warning("Failed to fetch patch notes", e);
                JsonObject error = new JsonObject();
                error.addProperty("error", e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
                json = JsonUtils.GSON.toJson(error);
            }
            newsLoading = false;
            String payload = json;
            Platform.runLater(() -> pushNews(payload));
        }).start();
    }

    private static String fetchPatchNotes() throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(PATCH_NOTES_URL))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", "HMCL-WebUI")
                .GET()
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new IOException("HTTP " + response.statusCode());
        }
        JsonObject root = JsonUtils.fromNonNullJson(response.body(), JsonObject.class);
        JsonArray entries = root.getAsJsonArray("entries");
        if (entries == null) {
            throw new IOException("empty entries");
        }

        JsonArray items = new JsonArray();
        int count = 0;
        for (var element : entries) {
            if (count++ >= 8) {
                break;
            }
            JsonObject entry = element.getAsJsonObject();
            JsonObject item = new JsonObject();
            item.addProperty("title", optString(entry, "title"));
            item.addProperty("summary", optString(entry, "shortText"));
            item.addProperty("date", optString(entry, "date"));
            String contentPath = optString(entry, "contentPath");

            // 官方 JSON 里没有网页地址，contentPath 指回 launchercontent 的 .json 文件。
            // 直接把它给浏览器，用户看到的就是一屏 JSON——这不是「新闻页面」。
            // 用 id 拼 minecraft.net 的文章地址：快照 id 形如 26-4-snapshot-6，
            // 官网 slug 是 minecraft-26-4-snapshot-6。
            String id = optString(entry, "id");
            String slug = id;
            if (!slug.isEmpty() && !slug.startsWith("minecraft-")) {
                slug = "minecraft-" + slug;
            }
            String articleUrl;
            if (!slug.isEmpty()) {
                articleUrl = MINECRAFT_ARTICLE_BASE + slug;
            } else if (!contentPath.isEmpty()) {
                articleUrl = MINECRAFT_ARTICLE_BASE + contentPath.replaceAll("\\.json$", "");
            } else {
                articleUrl = MINECRAFT_ARTICLE_BASE;
            }
            item.addProperty("url", articleUrl);
            // 正文（HTML）在 `https://launchercontent.mojang.com/v2/` + contentPath
            item.addProperty("contentPath", contentPath);
            item.addProperty("type", optString(entry, "type"));

            JsonObject image = entry.getAsJsonObject("image");
            if (image != null && image.has("url")) {
                item.addProperty("image", CONTENT_BASE + image.get("url").getAsString());
            }
            items.add(item);
        }

        JsonObject result = new JsonObject();
        result.add("items", items);
        return JsonUtils.GSON.toJson(result);
    }

    /// Mojang 的正文都在 `v2/` 下，contentPath 是相对路径（`javaPatchNotes/xxx.json`）。
    private static final String NEWS_CONTENT_BASE = "https://launchercontent.mojang.com/v2/";

    private final Map<String, String> newsDetailCache = new ConcurrentHashMap<>();

    /// 打开一条动态的正文。抓回来的是 HTML 片段，清洗交给前端做（那边有 DOM）。
    public void openNews(String contentPath) {
        if (contentPath == null || contentPath.isBlank()) {
            return;
        }
        String cached = newsDetailCache.get(contentPath);
        if (cached != null) {
            pushNewsDetail(cached, null);
            return;
        }

        pushNewsDetail(null, "loading");
        Task.runAsync(() -> {
            try {
                String json = fetchNewsDetail(contentPath);
                if (newsDetailCache.size() > 30) {
                    newsDetailCache.clear();
                }
                newsDetailCache.put(contentPath, json);
                Platform.runLater(() -> pushNewsDetail(json, null));
            } catch (Exception e) {
                LOG.warning("Failed to fetch news detail " + contentPath, e);
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                Platform.runLater(() -> pushNewsDetail(null, msg));
            }
        }).start();
    }

    private static String fetchNewsDetail(String contentPath) throws Exception {
        String path = contentPath.startsWith("/") ? contentPath.substring(1) : contentPath;
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(NEWS_CONTENT_BASE + path))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", "HMCL-WebUI")
                .GET()
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new IOException("HTTP " + response.statusCode());
        }

        JsonObject root = JsonUtils.fromNonNullJson(response.body(), JsonObject.class);
        String body = optString(root, "body");

        // 正文里的图片是站内相对路径，补成绝对地址，否则在壳里就是一片裂图
        body = body.replace("src=\"/", "src=\"https://launchercontent.mojang.com/");

        JsonObject out = new JsonObject();
        out.addProperty("title", optString(root, "title"));
        out.addProperty("version", optString(root, "version"));
        out.addProperty("type", optString(root, "type"));
        out.addProperty("body", body);
        JsonObject image = root.getAsJsonObject("image");
        if (image != null && image.has("url")) {
            out.addProperty("image", CONTENT_BASE + image.get("url").getAsString());
        }
        return JsonUtils.GSON.toJson(out);
    }

    private void pushNewsDetail(@Nullable String json, @Nullable String error) {
        JsonObject root = new JsonObject();
        if (error != null) {
            root.addProperty("loading", "loading".equals(error));
            root.addProperty("error", "loading".equals(error) ? "" : error);
        }
        if (json != null) {
            root.add("detail", JsonUtils.fromNonNullJson(json, JsonObject.class));
        }
        execute("window.__hmcl && window.__hmcl.onNewsDetail("
                + JsonUtils.GSON.toJson(JsonUtils.GSON.toJson(root)) + ")");
    }

    private static String optString(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
    }

    // ==================== 外观（皮肤 / 披风 / 鞘翅） ====================

    /// 账号当前纹理缓存，用于「还没选本地文件时」的兜底预览
    private volatile Image accountSkinCache;
    private volatile boolean accountSkinSlim;
    private volatile Image accountCapeCache;

    /// 账号纹理绑定必须挂在字段上。
    ///
    /// 这是一切问题的根源：`TexturesLoader.skinBinding()` 返回的是一个惰性 ObservableValue，
    /// 只有**有监听者且对象可达**时才会去拉纹理。以前 onAccountTextures() 定义了却没人调用，
    /// 绑定也是临时变量、方法退出就成了垃圾，于是 accountSkinCache / accountCapeCache
    /// 永远是 null——正版账号的「账号当前皮肤」卡片一片空白，披风也渲染不出来。
    private ObservableValue<TexturesLoader.LoadedTexture> accountSkinBinding;
    private ObservableValue<TexturesLoader.LoadedTexture> accountCapeBinding;
    private String accountTexturesId = "";

    /// 各账号的头像缓存（accountID -> 皮肤原图）。
    /// 账号列表里每个账号都要一张，不能只缓存当前选中的那个。
    private final Map<String, Image> accountHeads = new ConcurrentHashMap<>();
    private final Set<String> accountHeadsLoading = ConcurrentHashMap.newKeySet();
    /// 头像绑定也要持有，否则异步结果回不来
    private final Map<String, ObservableValue<TexturesLoader.LoadedTexture>> headBindings = new ConcurrentHashMap<>();
    private final Map<String, Image> serverCapeImages = new ConcurrentHashMap<>();
    private String pendingServerCape;
    private double previewYaw = 180;
    private boolean previewYawTouched;

    /// 设置快照：启动器 / 下载 / Java / 游戏四段。
    /// 具体字段和写入逻辑都在 {@link SettingsService}。
    public String getSettings() {
        return settings.snapshot();
    }

    /// 打开启动器日志目录（HMCL 设置页「杂项」里那个按钮）
    public void openLogFolder() {
        settings.openLogFolder();
    }

    /// 物理内存快照，前端定时刷新用
    public String memorySnapshot() {
        return settings.memorySnapshot();
    }

    /// 把日志打包导出（HMCL 的「导出日志」）
    public void exportLogs() {
        settings.exportLogs();
    }

    /// 清理下载缓存目录
    public void cleanCache() {
        settings.cleanCache();
    }

    /// 切换下载源。kind: `version`（版本清单）/ `file`（文件下载），
    /// value: `default`（自动）/ `official`（官方）/ `mirror`（BMCLAPI 镜像）。
    ///
    /// 底层是 `DownloadProviders.init()` 里注册的两个监听器，
    /// 改属性会立刻作用到 `HMCLDownloadProvider`，不用重启。
    public void setDownloadSource(String kind, String value) {
        org.jackhuang.hmcl.setting.DownloadSource source = switch (value == null ? "" : value) {
            case "official" -> org.jackhuang.hmcl.setting.DownloadSource.OFFICIAL;
            case "mirror" -> org.jackhuang.hmcl.setting.DownloadSource.MIRROR;
            default -> org.jackhuang.hmcl.setting.DownloadSource.DEFAULT;
        };

        try {
            var settings = org.jackhuang.hmcl.setting.SettingsManager.settings();
            if ("file".equals(kind)) {
                settings.fileDownloadSourceProperty().set(source);
            } else {
                settings.versionListSourceProperty().set(source);
            }
            pushSettings();
        } catch (Exception e) {
            LOG.warning("Failed to set download source", e);
        }
    }

    /// 下载并发。`auto` 为 true 时用 HMCL 的默认值（不写死一个数）。
    public void setDownloadThreads(String mode, String count) {
        try {
            var settings = org.jackhuang.hmcl.setting.SettingsManager.settings();
            boolean auto = !"manual".equals(mode);
            settings.autoDownloadThreadsProperty().set(auto);
            if (!auto) {
                int parsed;
                try {
                    parsed = Integer.parseInt(count == null ? "" : count.trim());
                } catch (NumberFormatException e) {
                    parsed = 64;
                }
                settings.downloadThreadsProperty().set(Math.max(1, Math.min(256, parsed)));
            }
            pushSettings();
        } catch (Exception e) {
            LOG.warning("Failed to set download threads", e);
        }
    }

    /// 把最新设置推给前端（onSettings）。改完设置要让界面回填真实值，
    /// 尤其是被夹到合法范围的那些。
    private void pushSettings() {
        String json = settings.snapshot();
        executeJs("window.__hmcl && window.__hmcl.onSettings("
                + JsonUtils.GSON.toJson(json) + ")");
    }

    /// 写一个启动器级设置。key 见 SettingsService.setLauncher。
    public void setLauncherSetting(String key, String value) {
        settings.setLauncher(key, value);
    }

    /// 写一个游戏级设置（全局预设）。key 见 SettingsService.setGame。
    public void setGameSetting(String key, String value) {
        settings.setGame(key, value);
    }

    /// 新建实例默认用哪种版本隔离策略。
    ///
    /// @return {@code "ALWAYS"} / {@code "MODDED"} / {@code "NEVER"}
    public String getIsolationType() {
        try {
            org.jackhuang.hmcl.setting.GameSettings.Preset preset = org.jackhuang.hmcl.setting.GameDirectoryManager
                    .getSelectedRepository().getParentGameSettings(null);
            org.jackhuang.hmcl.setting.DefaultIsolationType type = preset.defaultIsolationTypeProperty().getValue();
            return (type == null ? org.jackhuang.hmcl.setting.DefaultIsolationType.ALWAYS : type).name();
        } catch (Throwable e) {
            LOG.warning("Failed to read isolation type", e);
            return "ALWAYS";
        }
    }

    /// 改新建实例的默认隔离策略。
    ///
    /// <p>隔离 = 把 `versions/<id>/` 当成独立的 .minecraft（各自的 mods、saves、配置）。
    /// 带加载器的实例基本都要开，不然模组会串到所有版本里。
    public void setIsolationType(String name) {
        try {
            org.jackhuang.hmcl.setting.DefaultIsolationType type = org.jackhuang.hmcl.setting.DefaultIsolationType
                    .valueOf(name);
            org.jackhuang.hmcl.setting.GameSettings.Preset preset = org.jackhuang.hmcl.setting.GameDirectoryManager
                    .getSelectedRepository().getParentGameSettings(null);
            preset.defaultIsolationTypeProperty().setValue(type);
            org.jackhuang.hmcl.setting.SettingsManager.savePendingChanges();
            toast(switch (type) {
                case ALWAYS -> "新实例一律隔离";
                case MODDED -> "只有带加载器的实例才隔离";
                case NEVER -> "新实例都不隔离";
            });
        } catch (Throwable e) {
            LOG.warning("Failed to set isolation type", e);
            toast("切换隔离策略失败：" + e.getMessage());
        }
    }

    /// 前端进设置页时调一次，把 Java 列表推过来。
    public void requestJavaList() {
        settings.requestJavaList();
    }

    /// 重新扫描本机 Java。
    public void refreshJava() {
        settings.refreshJava();
    }

    /// 添加一个 Java 可执行文件（<java-home>/bin/java.exe 或 javaw.exe）。
    public void addJava(String binary) {
        settings.addJava(binary);
    }

    /// 用 Windows 原生的「打开文件」对话框挑一个 java 可执行文件，选完直接加进列表。
    ///
    /// <p>壳模式下 JavaFX 根本没有 Stage，`Controllers.showOpenDialog` 一定返回 null，
    /// 所以借 `System.Windows.Forms.OpenFileDialog` —— 系统原生对话框，
    /// 不依赖任何 UI 框架，模态也跑在它自己的进程里，不会卡住界面。
    public void pickJavaFile() {
        String path = showWindowsOpenDialog("选择 Java 可执行文件",
                "Java 可执行文件|javaw.exe;java.exe|所有文件|*.*");
        if (path == null || path.isBlank()) {
            return;
        }
        addJava(path);
        LOG.info("[java] picked from dialog: " + path);
        toast("已添加：" + path);
    }

    /// 弹一个 Windows 原生打开文件对话框，返回选中路径（取消返回 null）。
    @Nullable
    private String showWindowsOpenDialog(String title, String filter) {
        String script = "Add-Type -AssemblyName System.Windows.Forms;"
                + "$d = New-Object System.Windows.Forms.OpenFileDialog;"
                + "$d.Title = '" + title.replace("'", "''") + "';"
                + "$d.Filter = '" + filter.replace("'", "''") + "';"
                + "$d.CheckFileExists = $true;"
                + "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
                + " { [Console]::Out.Write($d.FileName) }";
        try {
            ProcessBuilder pb = new ProcessBuilder("powershell", "-NoProfile", "-STA", "-Command", script);
            Process proc = pb.start();
            byte[] out = proc.getInputStream().readAllBytes();
            proc.waitFor(300, java.util.concurrent.TimeUnit.SECONDS);
            String text = new String(out, java.nio.charset.Charset.defaultCharset());
            text = text.replace("\uFEFF", "").trim();
            return text.isEmpty() ? null : text;
        } catch (Throwable e) {
            LOG.warning("[java] file dialog failed", e);
            toast("打不开文件选择器：" + e.getMessage());
            return null;
        }
    }

    /// 移除 / 禁用列表里的 Java。
    public void removeJava(String binary) {
        settings.removeJava(binary);
    }

    /// 在资源管理器里定位一个 Java。
    public void revealJava(String binary) {
        try {
            java.nio.file.Path path = java.nio.file.Path.of(binary.trim());
            java.nio.file.Path target = path;
            java.nio.file.Path parent = path.getParent();
            // bin/java.exe → 退到 java home，跟 HMCL 的行为一致
            if (parent != null && parent.getFileName() != null
                    && "bin".equalsIgnoreCase(parent.getFileName().toString())
                    && java.nio.file.Files.exists(parent.resolveSibling("release"))) {
                target = parent.getParent();
            }
            org.jackhuang.hmcl.ui.FXUtils.showFileInExplorer(target);
        } catch (Exception e) {
            LOG.warning("Failed to reveal java " + binary, e);
        }
    }

    /// 前端进外观页时调一次，让后端把最新数据推过来。
    ///
    /// 存在的理由：壳模式下 `appearance()` 没法同步返回（HTTP 是异步的），
    /// 而前面那套「启动时预取缓存」的招式只能应付首页，导入/切换皮肤之后
    /// 缓存就过期了——界面会一直显示启动那一刻的皮肤库。
    public void requestAppearance() {
        pushAppearance();
    }

    public String appearance() {
        Account account = Accounts.getSelectedAccount();
        // 同理：外观页可能是刷新后直接进来的，不在这里挂一次就永远没有纹理
        attachAccountTextures(account);
        // 必须和 refreshPreview 用同一个 key（selectedAccountId 在无账号时返回 "none"），
        // 否则读到的是一份空状态：界面显示「无披风」但预览里其实戴着披风。
        String accountId = selectedAccountId();
        String kind = accountKind(account);

        JsonObject root = new JsonObject();
        root.addProperty("kind", kind);
        root.addProperty("accountName", account != null ? displayName(account) : "");
        root.addProperty("readOnly", "authlib".equals(kind));
        root.add("skins", assetsJson(AppearanceStore.Kind.SKIN));
        root.add("capes", assetsJson(AppearanceStore.Kind.CAPE));

        AppearanceStore.State state = effectiveState();
        JsonObject stateJson = new JsonObject();
        // 没选过本地皮肤时：
        //   - 账号有自己的纹理（正版 / 外置认证）→ 报 null，让前端标「账号当前皮肤」为选中，
        //     3D 用 accountSkinRaw。以前这里一律填 builtin-steve，结果是正版账号
        //     明明穿着自己的皮肤，界面上却显示「内置 Steve」被选中，预览也贴成了 Steve。
        //   - 完全没有纹理（未登录）→ 才退回内置 Steve，至少有个正常的小人。
        String skinId = state.getSkin();
        String model = state.getModel();
        boolean hasAccountSkin = accountSkinCache != null;
        if (skinId == null || skinId.isBlank()) {
            if (hasAccountSkin) {
                skinId = null;
                // 模型跟着账号纹理走：正版皮肤的 slim 标记写在纹理的 metadata 里
                model = effectiveModel(state);
            } else {
                skinId = "builtin-steve";
                model = "default";
            }
        }
        stateJson.addProperty("skin", skinId);
        stateJson.addProperty("cape", state.getCape());
        stateJson.addProperty("model", model);
        root.add("state", stateJson);
        // 有未保存的修改：前端拿它把「应用」按钮点亮
        root.addProperty("dirty", appearanceDirty());
        // 空串 = 用户明确选了「不戴披风」但还没应用；null = 没动过
        root.addProperty("pendingServerCape", pendingServerCape);

        // 和皮肤库里导入的皮肤用同一个渲染器（SkinGallery 的正面+背面两张 3D 图），
        // 以前这里用的是 AppearanceThumbnails 拼的 2D 剪影，放在一排 3D 图里
        // 一眼就能看出「这张卡片长得不一样」。
        root.addProperty("accountSkin", accountSkinPreview("slim".equals(model)));
        // 原图，给前端 skinview3d 用（上面那张是拼好的小图，只能看不能贴）
        root.addProperty("accountSkinRaw", accountSkinCache != null
                ? imageToDataUrlExact(accountSkinCache) : null);
        root.addProperty("accountCape", accountCapeCache != null
                ? AppearanceThumbnails.capeFront(accountCapeCache) : null);
        // 原图。壳模式的 3D 是前端 skinview3d 画的，要的是展开图不是拼好的缩略图;
        // 正版账号的披风不在本地资产列表里，没有这一项就完全渲染不出来。
        root.addProperty("accountCapeRaw", accountCapeCache != null
                ? imageToDataUrlExact(accountCapeCache) : null);
        return JsonUtils.GSON.toJson(root);
    }

    /// 把一张纹理写成临时 PNG，用来给「只换模型」的上传用。
    /// 调用方负责删文件——上传是异步的，删早了会传空。
    private static java.nio.file.@Nullable Path writeTempPng(Image image) {
        byte[] png = AccountTextureCache.encodePng(image);
        if (png == null) {
            return null;
        }
        try {
            java.nio.file.Path file = java.nio.file.Files.createTempFile("hopestar-skin-", ".png");
            java.nio.file.Files.write(file, png);
            return file;
        } catch (Exception e) {
            LOG.warning("Failed to write temp skin", e);
            return null;
        }
    }

    /// 账号当前皮肤的卡片图。用和导入皮肤同一个 3D 渲染器，
    /// 按「图像对象 + 模型」缓存——同一张皮肤重复渲染一次要 ~100ms，
    /// 而 appearance() 每次 push 都会调它。
    private String accountSkinPreviewCacheKey;
    private String accountSkinPreviewCacheValue;

    /// 上一段渲染用的是哪张图。用 identity 判断：纹理换了就是另一个对象，
    /// 内容相同的缓存图不会重复渲染。
    private Image accountSkinPreviewSource;

    private String accountSkinPreview(boolean slim) {
        Image image = accountSkinCache;
        if (image == null) {
            return null;
        }
        // 用「界面当前显示的模型」而不是服务器上的标记来渲染：
        // 用户点了纤体但还没应用时，卡片也该跟着变细，不然卡片和右边 3D 对不上
        String key = System.identityHashCode(image) + "|" + slim;
        if (key.equals(accountSkinPreviewCacheKey) && accountSkinPreviewSource == image) {
            return accountSkinPreviewCacheValue;
        }
        SkinGallery gallery = skinGallery;
        String url = gallery == null ? null : gallery.render(image, slim);
        if (url == null) {
            url = AppearanceThumbnails.skinFront(image, slim);
        }
        accountSkinPreviewCacheKey = key;
        accountSkinPreviewSource = image;
        accountSkinPreviewCacheValue = url;
        return url;
    }

    /// 界面当前该显示哪个模型。
    ///
    /// 关键点：正版账号没选本地皮肤时，「模型」的真相在服务器的纹理里
    /// （slim 标记），不在本地 state 里。以前一律用 state.model，
    /// 于是服务器上的纤体皮肤在启动器里显示成宽体，而且点「纤体」还判不出 dirty
    /// （因为 state.model 本来就是 default，点了没变化）。
    private String effectiveModel(AppearanceStore.State state) {
        String id = state.getSkin();
        boolean hasLocalSkin = id != null && !id.isBlank();
        // 用户手动点过宽体/纤体就以他的为准——不然点完「纤体」，
        // 下一次 push 又会按服务器上的旧标记把界面弹回宽体
        if (!hasLocalSkin && accountSkinCache != null && !Boolean.TRUE.equals(state.getModelTouched())) {
            return accountSkinSlim ? "slim" : "default";
        }
        return state.getModel();
    }

    private JsonArray assetsJson(AppearanceStore.Kind kind) {
        JsonArray array = new JsonArray();
        for (AppearanceStore.Asset asset : appearance.list(kind)) {
            JsonObject item = new JsonObject();
            item.addProperty("id", asset.getId());
            item.addProperty("name", asset.getName());
            item.addProperty("model", asset.getModel());
            item.addProperty("hasElytra", asset.isHasElytra());
            item.addProperty("builtin", asset.isBuiltin());
            try {
                Image texture = appearance.image(kind, asset);
                // 皮肤拼成站立小人、披风取正面那一块，跟官方账号管理页的列表一致；
                // 直接把 64×64 展开图当缩略图只会是一团看不懂的色块
                item.addProperty("preview", kind == AppearanceStore.Kind.SKIN
                        ? skinPreview(asset, texture)
                        : AppearanceThumbnails.capeFront(texture));
                // 原图（64×64 / 64×32 展开图）。前端 skinview3d 要的是这个，
                // 不是上面那张拼好的小人——3D 模型自己会按 UV 去切。
                item.addProperty("raw", imageToDataUrlExact(texture));
            } catch (Exception e) {
                item.addProperty("preview", (String) null);
            }
            array.add(item);
        }
        return array;
    }

    private static String accountKind(Account account) {
        if (account == null) {
            return "none";
        }
        if (account instanceof org.jackhuang.hmcl.auth.offline.OfflineAccount) {
            return "offline";
        }
        if (account instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount) {
            return "microsoft";
        }
        if (account instanceof AuthlibInjectorAccount) {
            return "authlib";
        }
        return "other";
    }

    /// 兼容旧调用：现在预览以图片形式交给页面，位置完全由 CSS 决定
    public void setPreviewRect(double x, double y, double width, double height) {
        Platform.runLater(this::refreshPreview);
    }

    public void hidePreview() {
        // 图片跟随页面，不需要额外隐藏
    }

    /// 外观页的待机摆动靠「定期重绘一张预览图」实现。
    ///
    /// 预览本身是一张 PNG（不是实时画布），所以摆动必须靠定时重新截图才看得见。
    /// 500ms 一次（2fps）配 0.18Hz 的慢速摆动已经足够顺，再快就只是在烧 CPU。
    /// 只有外观页在屏幕上时才启动，切走立刻停。
    private javafx.animation.Timeline idleRepaint;

    public void setPreviewActive(boolean active) {
        Platform.runLater(() -> {
            if (!active) {
                if (idleRepaint != null) {
                    idleRepaint.stop();
                }
                return;
            }
            if (idleRepaint == null) {
                idleRepaint = new javafx.animation.Timeline(
                        new javafx.animation.KeyFrame(javafx.util.Duration.millis(500),
                                event -> refreshPreview()));
                idleRepaint.setCycleCount(javafx.animation.Animation.INDEFINITE);
            }
            if (idleRepaint.getStatus() != javafx.animation.Animation.Status.RUNNING) {
                idleRepaint.play();
            }
        });
    }

    /// 当前外观页停留的标签页。皮肤页看正面，披风页自动转到背面 3/4，
    /// 否则打开披风列表却看不到背上的东西。
    private String appearanceTab = "skin";

    public void setAppearanceTab(String tab) {
        appearanceTab = "cape".equals(tab) ? "cape" : "skin";
        // 换标签页时把用户手动转过的角度清掉，回到该标签页的推荐视角
        previewYawTouched = false;
        Platform.runLater(this::refreshPreview);
    }

    /// 拖动预览旋转视角（水平）
    public void rotatePreview(double deltaX, double deltaY) {
        previewYawTouched = true;
        previewYaw = ((previewYaw + deltaX * 0.45) % 360 + 360) % 360;
        refreshPreview();
    }

    public void importSkin() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("导入皮肤");
        chooser.getExtensionFilters().add(FXUtils.getImageExtensionFilter());
        Path file = Controllers.showOpenDialog(chooser);
        if (file == null) {
            return;
        }
        try {
            AppearanceStore.Asset asset = appearance.importSkin(file);
            AppearanceStore.State state = draft();
            state.skin = asset.getId();
            adoptModelIfUnset(state, asset);
            pushAppearance();
            refreshPreview();
        } catch (Exception e) {
            LOG.warning("Failed to import skin", e);
            toast("导入皮肤失败：" + e.getMessage());
        }
    }

    /// 选披风文件
    public void importCape() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("导入披风");
        chooser.getExtensionFilters().add(FXUtils.getImageExtensionFilter());
        Path file = Controllers.showOpenDialog(chooser);
        if (file == null) {
            return;
        }
        try {
            AppearanceStore.Asset asset = appearance.importCape(file, null);
            // 导入只是「加进列表并预览」，还没应用
            AppearanceStore.State state = draft();
            state.cape = asset.getId();
            pushAppearance();
            refreshPreview();
        } catch (Exception e) {
            LOG.warning("Failed to import cape", e);
            toast("导入披风失败：" + e.getMessage());
        }
    }

    // ==================== 导入（壳模式，走页面里的 file input） ====================

    /// 前端 `<input type="file">` 读出来的 dataUrl 直接导入皮肤。
    ///
    /// 为什么不用 `importSkin()`：那条路走 `Controllers.showOpenDialog`，
    /// 需要一个可见的 JavaFX 窗口。壳模式下 JavaFX 不出窗口，FileChooser 弹不出来，
    /// 点了就毫无反应——就是用户报的那个 bug。
    /// 判断一张纹理到底是皮肤还是披风。
    ///
    /// <p>尺寸是最可靠的信号：皮肤标准是 64x64（1.8+）或 64x32（1.7），
    /// 披风标准是 64x32 或 22x17 —— 也就是说 64x32 两边都占，只能看内容。
    /// 披风的实际绘制区只有左上角 22x17，剩下全是透明；老皮肤是整张图都有东西。
    /// 所以用「左上 22x17 的不透明率」和「整图不透明率」两个数一起判断。
    ///
    /// @return {@code "skin"} / {@code "cape"} / {@code "unknown"}
    public static String classifyTexture(java.nio.file.Path file) {
        try {
            java.awt.image.BufferedImage img = javax.imageio.ImageIO.read(file.toFile());
            if (img == null) {
                return "unknown";
            }
            int w = img.getWidth();
            int h = img.getHeight();
            if (w == 22 && h == 17) {
                // 某些皮肤站导出的「裸披风」，就是裁掉留白后的 22x17
                return "cape";
            }
            // 2:1 的画布（64x32 / 128x64 / 256x128 …）既可能是披风，也可能是
            // 2013 年前那种老皮肤。区别很直接：披风只画左上一块（本体 22x17），
            // 可选再加一块鞘翅，整张图大半是空的；皮肤主体几乎铺满整张。
            //
            // 以前这里要求「披风区 22x17 覆盖率 > 0.9」才算披风 —— 那个条件
            // 没有披风能满足：真正的披风只在 (1,1)-(10,16) 画内容，覆盖率约 43%。
            // 结果是标准 64x32 披风一律被当成皮肤导入（实测导入纯色披风时踩到）。
            if (h > 0 && w == h * 2) {
                double all = opaqueRatio(img, 0, 0, w, h);
                if (all < 0.5) {
                    return "cape";
                }
                if (h == 32) {
                    return "skin";
                }
            }
            if (w == 64 && h == 64) {
                return "skin";
            }
            return "unknown";
        } catch (Throwable e) {
            return "unknown";
        }
    }

    private static double opaqueRatio(java.awt.image.BufferedImage img, int x, int y, int w, int h) {
        int total = 0;
        int opaque = 0;
        int maxX = Math.min(x + w, img.getWidth());
        int maxY = Math.min(y + h, img.getHeight());
        for (int j = y; j < maxY; j++) {
            for (int i = x; i < maxX; i++) {
                total++;
                if (((img.getRGB(i, j) >>> 24) & 0xFF) > 8) {
                    opaque++;
                }
            }
        }
        return total == 0 ? 0 : (double) opaque / total;
    }

    /// 皮肤/披风导入的统一入口。
    ///
    /// <p>之前两个按钮各自把图当成本标签页的类型导入，用户忘了切标签就会
    /// 「皮肤导成披风、披风导成皮肤」。现在先看内容再决定落到哪边，
    /// 类型和用户当前标签不一致时用 toast 说明一句。
    private void importTextureData(String dataUrl, String fileName, String preferred) {
        java.nio.file.Path temp = null;
        try {
            temp = writeDataUrl(dataUrl, preferred);
            if (temp == null) {
                toast("没有读到图片数据");
                return;
            }
            String kind = classifyTexture(temp);
            if ("unknown".equals(kind)) {
                // 认不出尺寸（比如远超 2 倍的高清图）就按调用方所在的标签页处理
                kind = preferred;
            }
            String name = cleanName(fileName);

            if ("cape".equals(kind)) {
                AppearanceStore.Asset asset = appearance.importCape(temp, null, name);
                AppearanceStore.State state = stateOfSelectedAccount();
                state.cape = asset.getId();
                appearance.saveState(selectedAccountId(), state);
                pushAppearance();
                refreshPreview();
                toast("cape".equals(preferred)
                        ? "已导入披风「" + asset.name + "」"
                        : "这张图是披风，已按披风导入「" + asset.name + "」");
            } else {
                AppearanceStore.Asset asset = appearance.importSkin(temp, name);
                AppearanceStore.State state = draft();
                state.skin = asset.getId();
                adoptModelIfUnset(state, asset);
                pushAppearance();
                refreshPreview();
                toast("skin".equals(preferred)
                        ? "已导入皮肤「" + asset.name + "」"
                        : "这张图是皮肤，已按皮肤导入「" + asset.name + "」");
            }
        } catch (Exception e) {
            LOG.warning("Failed to import texture", e);
            toast("导入失败：" + e.getMessage());
        } finally {
            if (temp != null) {
                try {
                    java.nio.file.Files.deleteIfExists(temp);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    public void importSkinData(String dataUrl, String fileName) {
        importTextureData(dataUrl, fileName, "skin");
    }

    private void importSkinDataLegacy(String dataUrl, String fileName) {
        Path temp = null;
        try {
            temp = writeDataUrl(dataUrl, "skin");
            if (temp == null) {
                toast("没有读到图片数据");
                return;
            }
            AppearanceStore.Asset asset = appearance.importSkin(temp, cleanName(fileName));
            AppearanceStore.State state = draft();
            state.skin = asset.getId();
            adoptModelIfUnset(state, asset);
            pushAppearance();
            refreshPreview();
            toast("已导入皮肤「" + asset.name + "」");
        } catch (Exception e) {
            LOG.warning("Failed to import skin data", e);
            toast("导入皮肤失败：" + e.getMessage());
        } finally {
            deleteQuietly(temp);
        }
    }

    /// 同上，披风
    public void importCapeData(String dataUrl, String fileName) {
        importTextureData(dataUrl, fileName, "cape");
    }

    private void importCapeDataLegacy(String dataUrl, String fileName) {
        Path temp = null;
        try {
            temp = writeDataUrl(dataUrl, "cape");
            if (temp == null) {
                toast("没有读到图片数据");
                return;
            }
            AppearanceStore.Asset asset = appearance.importCape(temp, null, cleanName(fileName));
            AppearanceStore.State state = stateOfSelectedAccount();
            state.cape = asset.getId();
            appearance.saveState(selectedAccountId(), state);
            pushAppearance();
            refreshPreview();
            toast("已导入披风「" + asset.name + "」");
        } catch (Exception e) {
            LOG.warning("Failed to import cape data", e);
            toast("导入披风失败：" + e.getMessage());
        } finally {
            deleteQuietly(temp);
        }
    }

    /// 前端传的是 `my_skin.png`，去掉扩展名当显示名
    private static @Nullable String cleanName(String fileName) {
        if (fileName == null || fileName.isBlank()) {
            return null;
        }
        String name = fileName.trim();
        int dot = name.lastIndexOf('.');
        if (dot > 0) {
            name = name.substring(0, dot);
        }
        return name.isBlank() ? null : name;
    }

    /// dataUrl -> 临时 png。AppearanceStore 的导入接口收的是 Path，
    /// 为了不改它（那头还负责校验尺寸、算 sha1、去重），这里落一次盘。
    private static @Nullable Path writeDataUrl(String dataUrl, String prefix) throws IOException {
        if (dataUrl == null) {
            return null;
        }
        int comma = dataUrl.indexOf(',');
        if (comma < 0 || comma == dataUrl.length() - 1) {
            return null;
        }
        byte[] bytes = Base64.getDecoder().decode(dataUrl.substring(comma + 1));
        Path temp = Files.createTempFile("hmcl-import-" + prefix + "-", ".png");
        Files.write(temp, bytes);
        return temp;
    }

    private static void deleteQuietly(@Nullable Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
        }
    }

    public void selectSkin(String id) {
        // 只改草稿，不落盘。「看一眼就算选定」是这个页面之前最大的问题。
        AppearanceStore.State state = draft();
        // 空串来自「账号当前皮肤」那张卡，表示回到服务器下发的皮肤
        state.skin = (id == null || id.isBlank()) ? null : id;
        AppearanceStore.Asset asset = appearance.find(AppearanceStore.Kind.SKIN, state.skin);
        if (asset != null && asset.getModel() != null) {
            adoptModelIfUnset(state, asset);
        }
        // 头像要跟着预览走，但账号本身还没改——push 里头像取的是已保存的皮肤，
        // 所以这里只刷外观，不动账号状态
        pushAppearance();
        refreshPreview();
    }

    /// 选择披风。传 null 或空串表示「不戴披风」——这是明确的选择，不是"还没选"。
    public void selectCape(String id) {
        AppearanceStore.State state = draft();
        state.cape = (id == null || id.isBlank()) ? null : id;
        // 本地披风和正版服务器披风互斥，选本地就清掉待提交的服务器披风
        pendingServerCape = null;
        pushAppearance();
        refreshPreview();
    }

    public void removeSkin(String id) {
        appearance.remove(AppearanceStore.Kind.SKIN, id);
        // 已保存的和草稿里的指向都要清：只清一边的话，草稿会指向一个已经不存在的资源
        AppearanceStore.State saved = stateOfSelectedAccount();
        if (id != null && id.equals(saved.getSkin())) {
            saved.skin = null;
            appearance.saveState(selectedAccountId(), saved);
        }
        if (appearanceDraft != null && id != null && id.equals(appearanceDraft.getSkin())) {
            appearanceDraft.skin = null;
        }
        pushAppearance();
        // 账号头像取自当前皮肤，不重新推一次状态要等下一次状态变更才刷新
        push();
        refreshPreview();
    }

    public void removeCape(String id) {
        appearance.remove(AppearanceStore.Kind.CAPE, id);
        AppearanceStore.State saved = stateOfSelectedAccount();
        if (id != null && id.equals(saved.getCape())) {
            saved.cape = null;
            appearance.saveState(selectedAccountId(), saved);
        }
        if (appearanceDraft != null && id != null && id.equals(appearanceDraft.getCape())) {
            appearanceDraft.cape = null;
        }
        pushAppearance();
        // 账号头像取自当前皮肤，不重新推一次状态要等下一次状态变更才刷新
        push();
        refreshPreview();
    }

    public void renameSkin(String id, String name) {
        appearance.rename(AppearanceStore.Kind.SKIN, id, name);
        pushAppearance();
    }

    public void renameCape(String id, String name) {
        appearance.rename(AppearanceStore.Kind.CAPE, id, name);
        pushAppearance();
    }

    public void setSkinModel(String model) {
        AppearanceStore.State state = draft();
        state.model = "slim".equals(model) ? "slim" : "default";
        // 打上「用户手动选的」，之后换皮肤不再被皮肤自带值覆盖。
        // 这一位是「换了皮肤还保持纤体」的关键：没有它，每次 selectSkin 都会
        // 把皮肤自带的宽体推荐值盖回来。
        state.modelTouched = true;
        pushAppearance();
        refreshPreview();
    }

    /// 拉取正版账号拥有的披风列表（异步推给前端）
    public void requestServerCapes() {
        if (!(Accounts.getSelectedAccount() instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount microsoftAccount)) {
            return;
        }
        Task.runAsync(() -> {
            JsonArray array = new JsonArray();
            try {
                for (var cape : microsoftAccount.getCapes()) {
                    JsonObject item = new JsonObject();
                    item.addProperty("id", cape.id);
                    item.addProperty("name", cape.alias != null ? cape.alias : cape.id);
                    item.addProperty("url", cape.url);
                    item.addProperty("active", cape.isActive());
                    array.add(item);
                    if (cape.url != null) {
                        TexturesLoader.loadRemoteTexture(cape.url)
                                .thenAccept(image -> {
                                    if (image != null) {
                                        serverCapeImages.put(cape.id, image);
                                        // 卡片上的平面缩略图是异步到手的，单独推一条增量，
                                        // 免得为了张图把整个列表重建一遍
                                        String preview = AppearanceThumbnails.capeFront(image);
                                        // 同时给展开图：缩略图只能贴在卡上，3D 渲染要的是原始纹理
                                        String raw = imageToDataUrlExact(image);
                                        if (preview != null) {
                                            Platform.runLater(() -> execute(
                                                    "window.__hmcl && window.__hmcl.onCapePreview("
                                                            + JsonUtils.GSON.toJson(cape.id) + ","
                                                            + JsonUtils.GSON.toJson(preview) + ","
                                                            + JsonUtils.GSON.toJson(raw) + ")"));
                                        }
                                        Platform.runLater(this::refreshPreview);
                                    }
                                });
                    }
                }
            } catch (Exception e) {
                LOG.warning("Failed to fetch server capes", e);
            }
            String json = JsonUtils.GSON.toJson(array);
            Platform.runLater(() -> execute("window.__hmcl && window.__hmcl.onServerCapes(" + JsonUtils.GSON.toJson(json) + ")"));

            // 一件都没装备（比如用户在官网摘掉了披风）：本地缓存和 3D 里的那件要跟着消失，
            // 否则「我已经摘了，启动器还给我穿戴着」。
            boolean anyActive = false;
            for (var item : array) {
                if (item.getAsJsonObject().has("active") && item.getAsJsonObject().get("active").getAsBoolean()) {
                    anyActive = true;
                    break;
                }
            }
            if (!anyActive) {
                Platform.runLater(() -> {
                    if (accountCapeCache != null && pendingServerCape == null) {
                        accountCapeCache = null;
                        AccountTextureCache.getInstance().storeCape(accountTexturesId, null);
                        pushAppearance();
                        push();
                        refreshPreview();
                    }
                });
            }
        }).start();
    }

    /// 正版账号：选中服务器上的某件披风（只改预览，应用时才提交）。
    /// 传空串表示明确不戴披风，应用时会发 DELETE 把当前披风摘掉。
    public void selectServerCape(String capeId) {
        pendingServerCape = capeId == null ? "" : capeId;
        pushAppearance();
        // 账号头像取自当前皮肤，不重新推一次状态要等下一次状态变更才刷新
        push();
        refreshPreview();
    }

    private String selectedAccountId() {
        Account account = Accounts.getSelectedAccount();
        return account != null ? account.getAccountID().toString() : "none";
    }

    /// 皮肤自带的推荐模型（Steve 是宽体、Alex 是纤体）。
    ///
    /// **只在用户还没手动选过宽体/纤体时才采纳**。一旦 `state.model` 有值，
    /// 就代表那是用户自己的选择，换皮肤、重新导入都不该把它改回去——
    /// 之前这里无条件赋值，症状是「切到纤体，换个皮肤再切回来又变宽体」。
    private static void adoptModelIfUnset(AppearanceStore.State state, AppearanceStore.Asset asset) {
        // 只有用户**没手动选过**才跟着皮肤走；选过就一直用他选的那个
        if (Boolean.TRUE.equals(state.getModelTouched())) {
            return;
        }
        if (asset != null && asset.getModel() != null) {
            state.model = asset.getModel();
        }
    }

    private AppearanceStore.State stateOfSelectedAccount() {
        return appearance.stateOf(selectedAccountId());
    }

    // ---------------- 外观：选择与保存分离 ----------------
    //
    // 「选皮肤 / 换宽体纤体 / 换披风」这些动作只改内存里的一份草稿，不落盘；
    // 只有点「应用到账号」才把草稿写进 state 文件并提交给账号。
    //
    // 这么改的直接原因：以前选皮肤就写盘，等于「看一眼就算选定」，
    // 而且写盘时会把皮肤自带的宽体/纤体推荐值盖到 state.model 上，
    // 用户手动改成纤体之后一换皮肤又变回宽体。

    /// 草稿。第一次访问时从已保存状态拷一份出来，之后所有选择动作都只改它。
    private @Nullable AppearanceStore.State appearanceDraft = null;

    private AppearanceStore.State draft() {
        if (appearanceDraft == null) {
            AppearanceStore.State saved = stateOfSelectedAccount();
            AppearanceStore.State copy = new AppearanceStore.State(
                    saved.getSkin(), saved.getCape(), saved.getModel());
            copy.modelTouched = saved.getModelTouched();
            appearanceDraft = copy;
        }
        return appearanceDraft;
    }

    /// 当前界面应该显示的状态：有草稿用草稿，没有就是已保存的。
    private AppearanceStore.State effectiveState() {
        return appearanceDraft != null ? appearanceDraft : stateOfSelectedAccount();
    }

    /// 丢掉未保存的修改。
    ///
    /// 页面重新加载（F5 / 切到别的页面再回来）时调一次：草稿只该活在
    /// 这一次界面会话里，刷新之后还留着上一个人的选择会很莫名其妙。
    public void discardAppearanceDraft() {
        if (appearanceDraft == null) {
            return;
        }
        appearanceDraft = null;
        pushAppearance();
    }

    /// 草稿和已保存的是否不一样。前端拿它提示「有未保存的修改」。
    private boolean appearanceDirty() {
        // 正版披风的「选择」只记在 pendingServerCape 上，不进 state。
        // 不把它算进来的话，在披风列表里点了一件之后「应用到账号」仍然是灰的——
        // 用户明明选了却没法提交，这就是之前披风更换体验最差的地方。
        if (pendingServerCape != null) {
            return true;
        }
        AppearanceStore.State d = appearanceDraft;
        if (d == null) {
            return false;
        }
        AppearanceStore.State s = stateOfSelectedAccount();
        // 模型要按「有效模型」比：正版账号没选本地皮肤时，draft 和 saved 的
        // state.model 都是 default，但界面上显示的是服务器那边的 slim。
        // 直接比字段的话，点「纤体」判不出变化，「应用」按钮一直是灰的。
        return !java.util.Objects.equals(d.getSkin(), s.getSkin())
                || !java.util.Objects.equals(d.getCape(), s.getCape())
                || !java.util.Objects.equals(effectiveModel(d), effectiveModel(s));
    }

    /// 依据「本地选择 → 账号当前纹理 → 默认皮肤」刷新 3D 预览
    void refreshPreview() {
        AppearanceStore.State state = stateOfSelectedAccount();

        Image skin = null;
        boolean slim = false;

        AppearanceStore.Asset skinAsset = appearance.find(AppearanceStore.Kind.SKIN, state.getSkin());
        if (skinAsset != null) {
            try {
                skin = appearance.image(AppearanceStore.Kind.SKIN, skinAsset);
                slim = "slim".equals(state.getModel()) || "slim".equals(skinAsset.getModel());
            } catch (IOException e) {
                LOG.warning("Failed to load selected skin", e);
            }
        }
        if (skin == null) {
            skin = accountSkinCache;
            slim = accountSkinSlim;
        }
        if (skin == null) {
            skin = TexturesLoader.getDefaultSkinImage();
        }

        Image cape = null;
        boolean capeDecided = false;

        // 正版账号：用户点过服务器披风列表之后，pendingServerCape 就是最终决定
        // （空串 = 明确不戴），这时不再回退到本地披风或账号当前披风
        if (pendingServerCape != null) {
            capeDecided = true;
            if (!pendingServerCape.isEmpty()) {
                cape = serverCapeImages.get(pendingServerCape);
            }
        }

        if (!capeDecided) {
            AppearanceStore.Asset capeAsset = appearance.find(AppearanceStore.Kind.CAPE, state.getCape());
            if (capeAsset != null) {
                try {
                    cape = appearance.image(AppearanceStore.Kind.CAPE, capeAsset);
                } catch (IOException e) {
                    LOG.warning("Failed to load selected cape", e);
                }
            }
            // 本地没选，才退回账号自带的披风
            if (cape == null) {
                cape = accountCapeCache;
            }
        }

        // 壳模式没有 WebUIPage，预览用离屏画布；两者都没有才放弃
        SkinCanvas canvas = page != null
                ? page.getPreviewCanvas()
                : (offscreen != null ? offscreen.canvas() : null);
        if (canvas == null) {
            return;
        }
        // 只预览披风。鞘翅的形态取决于飞行姿态和贴图 alpha，启动器里还原不准，
        // 与其给一个似是而非的样子，不如交给游戏自己渲染。
        canvas.updateSkin(skin, slim, cape);

        // 皮肤标签看正面；披风标签转到背面 3/4，否则选了披风也看不见。
        // 没有披风时一律正面——转过去只会看到后脑勺。
        if (!previewYawTouched) {
            boolean wantBack = cape != null && "cape".equals(appearanceTab);
            previewYaw = wantBack ? 326 : 180;
        }
        // 标定用：-Dhmcl.web.yaw=210 强制指定视角，方便一次性出多角度对照图
        String forcedYaw = System.getProperty("hmcl.web.yaw");
        if (forcedYaw != null && !forcedYaw.isBlank()) {
            try {
                previewYaw = Double.parseDouble(forcedYaw.trim());
            } catch (NumberFormatException ignored) {
            }
        }
        canvas.setYaw(previewYaw);
        canvas.setSwayEnabled(true);

        String dataUrl = page != null
                ? page.snapshotPreview()
                : (offscreen != null ? offscreen.snapshot() : null);
        if (dataUrl != null) {
            execute("window.__hmcl && window.__hmcl.onPreview(" + JsonUtils.GSON.toJson(dataUrl) + ")");
        }
    }

    /// 给「当前选中账号」挂上皮肤 / 披风纹理绑定。
    ///
    /// 正版账号的皮肤和披风都写在 textures 属性里，要等 profile 拉到之后才有值；
    /// 绑定是异步的，所以这里只负责挂上监听，结果回来时再刷新界面。
    /// 账号没变就直接返回，push() 会频繁调用，重复挂监听会把回调叠成好几份。
    private void attachAccountTextures(@Nullable Account account) {
        String id = account == null ? "none" : account.getAccountID().toString();
        if (id.equals(accountTexturesId)) {
            return;
        }
        accountTexturesId = id;
        // 换账号先清空上一份，否则新账号会先闪一下旧账号的皮肤
        accountSkinCache = null;
        accountCapeCache = null;
        accountSkinSlim = false;
        accountSkinBinding = null;
        accountCapeBinding = null;

        if (account == null) {
            return;
        }

        // 先读本地缓存。Mojang 那边要走 profile → textures → PNG 两次往返，
        // 这段时间里界面已经有东西可显示，头像不会退回兜底皮肤。
        AccountTextureCache.Cached cached = AccountTextureCache.getInstance().load(id);
        if (cached != null && cached.skin() != null) {
            accountSkinCache = cached.skin();
            accountSkinSlim = cached.slim();
            accountCapeCache = cached.cape();
        }

        try {
            ObservableValue<TexturesLoader.LoadedTexture> skin = TexturesLoader.skinBinding(account);
            skin.addListener((obs, before, after) -> {
                if (after == null || after.image() == null) {
                    return;
                }
                // 监听可能在加载线程上触发，缓存写入放到 FX 线程做，
                // 顺便保证 onAccountTextures 里的 push 不会跨线程
                Platform.runLater(() -> {
                    if (!id.equals(accountTexturesId)) {
                        return; // 期间已经换账号了，这份结果作废
                    }
                    onAccountTextures(after, null);
                });
            });
            accountSkinBinding = skin;

            ObservableValue<TexturesLoader.LoadedTexture> cape = TexturesLoader.capeBinding(account);
            cape.addListener((obs, before, after) -> {
                if (after == null || after.image() == null) {
                    return;
                }
                Platform.runLater(() -> {
                    if (!id.equals(accountTexturesId)) {
                        return;
                    }
                    onAccountTextures(null, after);
                });
            });
            accountCapeBinding = cape;

            // 绑定可能在挂监听之前就已经算好了（profile 有缓存时是同步的），
            // 这种情况下不会再触发 change，要主动取一次
            var cachedSkin = skin.getValue();
            var cachedCape = cape.getValue();
            if (cachedSkin != null || cachedCape != null) {
                onAccountTextures(cachedSkin, cachedCape);
            }
        } catch (Exception e) {
            LOG.warning("Failed to bind account textures", e);
        }
    }

    /// 作废并重挂账号纹理。
    ///
    /// 换完皮肤/披风之后必须走一遍：Mojang 那边有缓存，不 invalidate 的话
    /// profile 里还是旧纹理，界面看起来就像「点了应用没反应」。
    /// 延时重挂是因为皮肤上传后要几秒才传播，立刻拉往往拿到旧的。
    private void invalidateAccountTextures(long delayMillis) {
        Runnable rebind = () -> {
            Account account = Accounts.getSelectedAccount();
            if (account != null) {
                try {
                    account.clearCache();
                } catch (Exception e) {
                    LOG.warning("Failed to clear account texture cache", e);
                }
            }
            accountTexturesId = "";
            accountSkinCache = null;
            accountCapeCache = null;
            attachAccountTextures(account);
            pushAppearance();
            push();
            refreshPreview();
            // 披风列表的 active 位来自 /minecraft/profile，和 textures 是两份数据，
            // 换了披风之后要单独重拉一次，否则「已装备」标记还停在旧的那件上
            requestServerCapes();
        };

        if (delayMillis <= 0) {
            rebind.run();
            return;
        }
        javafx.animation.PauseTransition pause =
                new javafx.animation.PauseTransition(javafx.util.Duration.millis(delayMillis));
        pause.setOnFinished(event -> rebind.run());
        pause.play();
    }

    /// 账号纹理到手后刷新缓存与预览
    void onAccountTextures(TexturesLoader.LoadedTexture skin, TexturesLoader.LoadedTexture cape) {
        boolean changed = false;
        String accountId = accountTexturesId;
        AccountTextureCache cache = AccountTextureCache.getInstance();

        if (skin != null && skin.image() != null) {
            boolean hadBefore = accountSkinCache != null;
            accountSkinCache = skin.image();
            accountSkinSlim = "slim".equals(skin.metadata().get("model"));
            // 写缓存时按 MD5 比对：内容和磁盘上一模一样就什么都不做（静默忽略），
            // 不一样才重写——这一步同时覆盖了「首次登录」和「用户换了皮肤」。
            // 返回值是「真的变了」，没变就别推界面，免得每次启动都闪一次重绘。
            boolean stored = cache.storeSkin(accountId, accountSkinCache, accountSkinSlim);
            changed = changed || stored || !hadBefore;
        }
        if (cape != null && cape.image() != null) {
            boolean hadBefore = accountCapeCache != null;
            accountCapeCache = cape.image();
            boolean stored = cache.storeCape(accountId, accountCapeCache);
            changed = changed || stored || !hadBefore;
        }
        if (!changed) {
            return;
        }
        // 「账号当前皮肤 / 披风」两张卡的缩略图都在 appearance() 里，
        // 只刷 3D 预览的话卡片仍然是空的
        pushAppearance();
        push();
        refreshPreview();
    }

    /// 应用：离线写本地皮肤路径；正版上传皮肤 + 提交披风；外置认证不支持更换
    public void applyAppearance() {
        Account account = Accounts.getSelectedAccount();
        if (account == null) {
            return;
        }

        // 这里才把草稿写进 state 文件——「保存」是唯一的落盘时机。
        // 写完立刻清掉草稿，这样界面上「未保存」的提示会跟着消失。
        AppearanceStore.State state = effectiveState();
        appearance.saveState(selectedAccountId(), state);
        appearanceDraft = null;

        if (account instanceof org.jackhuang.hmcl.auth.offline.OfflineAccount offlineAccount) {
            AppearanceStore.Asset skinAsset = appearance.find(AppearanceStore.Kind.SKIN, state.getSkin());
            AppearanceStore.Asset capeAsset = appearance.find(AppearanceStore.Kind.CAPE, state.getCape());
            offlineAccount.setSkin(new org.jackhuang.hmcl.auth.offline.Skin(
                    org.jackhuang.hmcl.auth.offline.Skin.Type.LOCAL_FILE,
                    null,
                    "slim".equals(state.getModel()) ? org.jackhuang.hmcl.auth.yggdrasil.TextureModel.SLIM
                            : org.jackhuang.hmcl.auth.yggdrasil.TextureModel.WIDE,
                    skinAsset != null ? appearance.fileOf(AppearanceStore.Kind.SKIN, skinAsset.getId()).toString() : null,
                    capeAsset != null ? appearance.fileOf(AppearanceStore.Kind.CAPE, capeAsset.getId()).toString() : null));
            toast("已保存到离线账号");
            pushAppearance();
            push();
            return;
        }

        if (account instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount microsoftAccount) {
            AppearanceStore.Asset skinAsset = appearance.find(AppearanceStore.Kind.SKIN, state.getSkin());

            // 要上传哪个模型：
            //   用户手动选过 → 就按他选的
            //   没选过但挑了本地皮肤 → 跟这张皮肤自带的推荐值
            //   没选过也没挑皮肤 → 保持服务器上原来的（不传）
            String chosenModel;
            if (Boolean.TRUE.equals(state.getModelTouched())) {
                chosenModel = state.getModel();
            } else if (skinAsset != null) {
                chosenModel = skinAsset.getModel();
            } else {
                chosenModel = effectiveModel(state);
            }
            boolean slim = "slim".equals(chosenModel);

            // 皮肤来源只有两处：本地资产，或者「账号当前皮肤」（此时只换了模型）。
            // 后者必须把当前纹理原样上传一遍——微软那边没有「只改模型」的接口，
            // 官网的宽体/纤体切换也是重新上传同一张皮肤、带不同的 model 位。
            final java.nio.file.Path uploadPath;
            final boolean modelOnly;
            if (skinAsset != null) {
                uploadPath = appearance.fileOf(AppearanceStore.Kind.SKIN, skinAsset.getId());
                modelOnly = false;
            } else if (accountSkinCache != null && slim != accountSkinSlim) {
                uploadPath = writeTempPng(accountSkinCache);
                modelOnly = true;
            } else {
                uploadPath = null;
                modelOnly = false;
            }

            Task.runAsync(() -> {
                try {
                    if (uploadPath != null) {
                        microsoftAccount.uploadSkin(slim, uploadPath);
                    }
                    if (pendingServerCape != null) {
                        // 空串 = 明确不戴披风，走 DELETE
                        microsoftAccount.setActiveCape(pendingServerCape.isEmpty() ? null : pendingServerCape);
                    }
                } catch (Exception e) {
                    throw new RuntimeException(e);
                } finally {
                    if (modelOnly && uploadPath != null) {
                        try {
                            java.nio.file.Files.deleteIfExists(uploadPath);
                        } catch (Exception ignored) {
                        }
                    }
                }
            }).whenComplete(Schedulers.javafx(), exception -> {
                if (exception != null) {
                    LOG.warning("Failed to apply appearance", exception);
                    toast("应用失败：" + Accounts.localizeErrorMessage(exception));
                } else {
                    toast("已应用到正版账号");
                    pendingServerCape = null;
                    // 模型变了就地更新，否则 Mojang 那边还在传播的这几秒里，
                    // 界面会从纤体弹回宽体再跳回来
                    if (uploadPath != null) {
                        accountSkinSlim = slim;
                        AccountTextureCache.getInstance().updateSlim(accountTexturesId, slim);
                    }
                    // 立刻重挂一次：披风的「已装备」标记要跟着变
                    invalidateAccountTextures(0);
                    // 再等 3 秒重挂一次：皮肤上传后 Mojang 那边要几秒才传播，
                    // 立刻拉拿到的往往还是旧皮肤，用户会以为没生效
                    invalidateAccountTextures(3000);
                }
            }).start();
            return;
        }

        toast("外置认证账号请前往对应平台修改外观");
    }

    private void pushAppearance() {
        execute("window.__hmcl && window.__hmcl.onAppearance(" + JsonUtils.GSON.toJson(appearance()) + ")");
    }

    // ==================== 下载 ====================

    private final DownloadService download = new DownloadService(this::executeJs);

    /// 模组 / 资源包 / 光影 / 整合包 / 世界的搜索与下载（Modrinth）
    private final AddonService addons = new AddonService(this::executeJs);
    private final SettingsService settings = new SettingsService(this::executeJs);

    private void executeJs(String script) {
        execute(script);
    }

    /// 前端进下载页时调用，force=true 表示下拉刷新
    public void requestVersions(boolean force) {
        download.requestVersions(force);
    }

    /// 安装指定版本（原版）
    public void installVersion(String versionId) {
        download.installVersion(versionId);
    }

    /// 带自定义实例名的安装（安装弹窗里的「游戏实例名称」输入框）
    public void installVersionNamed(String versionId, String instanceName) {
        download.installVersion(versionId, instanceName);
    }

    // ==================== 实例里已装的内容 ====================

    /// 截图列表：文件名、大小、时间、360px 缩略图（data URL）。
    public String instanceScreenshots(String instanceId) {
        HMCLGameInstance instance = findInstance(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        return ScreenshotService.list(instance);
    }

    /// 截图操作。action: `open` / `copy` / `rename` / `delete`。
    public String screenshotAction(String instanceId, String action, String file, String arg) {
        HMCLGameInstance instance = findInstance(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        if (file == null || file.isBlank() || file.contains("..") || file.contains("/") || file.contains("\\")) {
            return "{\"error\":\"文件名不合法\"}";
        }
        java.nio.file.Path path = instance.getRunDirectory().resolve("screenshots").resolve(file);
        if (!java.nio.file.Files.isRegularFile(path)) {
            return "{\"error\":\"文件不存在：" + file + "\"}";
        }
        return switch (action == null ? "" : action) {
            case "open" -> ScreenshotService.open(path);
            case "copy" -> ScreenshotService.copy(path);
            case "rename" -> ScreenshotService.rename(path, arg);
            case "delete" -> ScreenshotService.delete(path);
            default -> "{\"error\":\"未知的操作：" + action + "\"}";
        };
    }

    /// 把最近一次游戏崩溃翻成人话：原因、建议、可疑模组、原文摘要。
    public String crashReportAnalysis(String instanceId) {
        return CrashService.analyze(instanceId);
    }

    /// 扫实例的 mods：返回每个模组的元数据、缺失的前置、重复安装的 id。
    ///
    /// <p>启动前就能看出来「少装了什么」比崩了再翻日志省事得多。
    public String instanceModScan(String instanceId) {
        return ModScanService.scan(instanceId);
    }

    /// 选一个本地整合包并直接安装。
    ///
    /// <p>比走 `/api/upload` 少一次拷贝：那个是「前端读文件 → POST 到本地 HTTP → 后端落盘」，
    /// 一个 300 MB 的整合包等于白写两遍磁盘。这里拿到路径就直接交给安装链路。
    ///
    /// <p>对话框用的是「浏览 Java」那套系统实现：壳模式下没有 JavaFX Stage，
    /// FileChooser 弹不出来。
    public void pickModpackFile() {
        String path = showWindowsOpenDialog("选择整合包",
                "整合包|*.zip;*.mrpack;*.mcbbs|所有文件|*.*");
        if (path == null || path.isBlank()) {
            return;
        }
        addons.installLocalFile("modpack", java.nio.file.Path.of(path), null, null, false);
    }

    /// 按路径装整合包。留给「拖进来一个文件」和命令行调用。
    public void installModpackPath(String path) {
        if (path == null || path.isBlank()) {
            return;
        }
        addons.installLocalFile("modpack", java.nio.file.Path.of(path), null, null, false);
    }

    /// 取消一个正在跑的下载/安装任务（前端任务行上的 ✕）。
    public void cancelDownload(String taskId) {
        download.cancelTask(taskId);
    }

    /// 世界（存档）列表：名称、版本、最后游玩、图标、备份数。
    public String instanceWorlds(String instanceId) {
        HMCLGameInstance instance = findInstance(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        return WorldService.list(instance);
    }

    /// 世界操作。action: `open` / `backup` / `rename` / `delete`；file 是 saves 下的目录名。
    public String worldAction(String instanceId, String action, String file, String arg) {
        HMCLGameInstance instance = findInstance(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        if (file == null || file.isBlank() || file.contains("..") || file.contains("/") || file.contains("\\")) {
            return "{\"error\":\"存档目录名不合法\"}";
        }
        java.nio.file.Path dir = instance.getSavesDirectory().resolve(file);
        if (!java.nio.file.Files.isDirectory(dir)) {
            return "{\"error\":\"存档不存在：" + file + "\"}";
        }
        org.jackhuang.hmcl.game.World world;
        try {
            world = new org.jackhuang.hmcl.game.World(dir);
        } catch (Exception e) {
            return "{\"error\":\"读取存档失败：" + e.getMessage() + "\"}";
        }
        return switch (action == null ? "" : action) {
            case "open" -> {
                WorldService.open(world);
                yield "{\"ok\":true}";
            }
            case "backup" -> WorldService.backup(instance, world);
            case "rename" -> WorldService.rename(world, arg);
            case "delete" -> WorldService.delete(world);
            default -> "{\"error\":\"未知的操作：" + action + "\"}";
        };
    }

    /// 列出实例某个目录下的内容。kind: `mod` / `resourcepack` / `shader`。
    ///
    /// 不解析 jar 里的元数据——这里只要「有哪些文件、开没开、多大」，
    /// 文件系统层面就够了。`.disabled` 后缀是 HMCL 的禁用约定。
    public String instanceAddons(String instanceId, String kind) {
        JsonObject root = new JsonObject();
        JsonArray items = new JsonArray();

        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null) {
                root.addProperty("error", "找不到实例或目录");
            } else {
                root.addProperty("directory", dir.toString());
                if (Files.isDirectory(dir)) {
                    boolean isWorld = "world".equals(kind);
                    try (var list = Files.list(dir)) {
                        // 世界是目录（每个存档一个），其余是文件
                        List<Path> files = list
                                .filter(isWorld ? Files::isDirectory : Files::isRegularFile)
                                .sorted()
                                .toList();
                        for (Path file : files) {
                            String fileName = file.getFileName().toString();
                            boolean disabled = fileName.endsWith(".disabled");
                            JsonObject o = new JsonObject();
                            o.addProperty("fileName", fileName);
                            o.addProperty("name", disabled
                                    ? fileName.substring(0, fileName.length() - ".disabled".length())
                                    : fileName);
                            o.addProperty("disabled", disabled);
                            // 存档目录递归求和太慢（几百 MB 几千个文件会卡住界面），
                            // 只报 level.dat 的大小，够用户判断是不是空存档
                            Path sizeTarget = isWorld ? file.resolve("level.dat") : file;
                            try {
                                o.addProperty("size", Files.isRegularFile(sizeTarget) ? Files.size(sizeTarget) : 0);
                            } catch (IOException e) {
                                o.addProperty("size", 0);
                            }
                            items.add(o);
                        }
                    }
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to list addons of " + instanceId, e);
            root.addProperty("error", String.valueOf(e.getMessage()));
        }

        root.add("items", items);
        return JsonUtils.GSON.toJson(root);
    }

    /// 启用 / 禁用。禁用就是加 `.disabled` 后缀，和 HMCL 一致——
    /// 游戏只加载后缀为 `.jar` 的文件，改名后自然不生效。
    public void setAddonEnabled(String instanceId, String kind, String fileName, boolean enabled) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                return;
            }
            // 只取文件名，防止前端传进来 `../..` 之类
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            Path current = dir.resolve(leaf);
            if (!Files.isRegularFile(current)) {
                return;
            }

            String plain = leaf.endsWith(".disabled")
                    ? leaf.substring(0, leaf.length() - ".disabled".length())
                    : leaf;
            Path target = dir.resolve(enabled ? plain : plain + ".disabled");
            if (!current.equals(target)) {
                Files.move(current, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            pushAddons(instanceId, kind);
        } catch (Exception e) {
            LOG.warning("Failed to toggle addon " + fileName, e);
        }
    }

    public void removeAddon(String instanceId, String kind, String fileName) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                return;
            }
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            Path target = dir.resolve(leaf);
            if ("world".equals(kind) && Files.isDirectory(target)) {
                // 存档是目录，得整个删掉
                try (var walk = Files.walk(target)) {
                    List<Path> all = walk.sorted(Comparator.reverseOrder()).toList();
                    for (Path p : all) {
                        Files.deleteIfExists(p);
                    }
                }
            } else {
                Files.deleteIfExists(target);
            }
            pushAddons(instanceId, kind);
        } catch (Exception e) {
            LOG.warning("Failed to delete addon " + fileName, e);
        }
    }

    private void pushAddons(String instanceId, String kind) {
        String json = instanceAddons(instanceId, kind);
        executeJs("window.__hmcl && window.__hmcl.onInstanceAddons("
                + JsonUtils.GSON.toJson(json) + ")");
    }

    @Nullable
    private static Path addonDir(String instanceId, String kind) {
        if (instanceId == null || instanceId.isBlank()) {
            return null;
        }
        String sub = switch (kind == null ? "" : kind) {
            case "resourcepack" -> "resourcepacks";
            case "shader" -> "shaderpacks";
            // 世界是 saves/ 下的一堆目录，不是文件——列表和删除都要单独处理
            case "world" -> "saves";
            // 蓝图与截图同样是查看为主：蓝图是 .schematic/.litematic 文件，
            // 截图是 .png。两者都不参与加载，没有启用/禁用
            case "schematic" -> "schematics";
            case "screenshot" -> "screenshots";
            default -> "mods";
        };
        try {
            var repository = GameDirectoryManager.getSelectedRepository();
            if (repository == null) {
                return null;
            }
            var instance = repository.findInstance(new org.jackhuang.hmcl.game.GameInstanceID(instanceId));
            if (instance == null) {
                return null;
            }
            return instance.getRunDirectory().resolve(sub).toAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    // ==================== 内容下载（模组 / 资源包 / 光影 / 整合包 / 世界） ====================

    /// 搜索。type: mod / modpack / resourcepack / shader / world
    /// gameVersion 为空表示不按游戏版本过滤，loader 为空表示不按加载器过滤，
    /// category 是逗号分隔的类别 slug（Modrinth `/v2/tag/category` 里的 name），
    /// reqId 由前端生成，只用于丢弃迟到的响应。
    public void addonSearch(String type, String gameVersion, String query, String page, String sort,
                            String loader, String category, String reqId) {
        int p = 0;
        try {
            p = page == null || page.isBlank() ? 0 : Integer.parseInt(page.trim());
        } catch (NumberFormatException ignored) {
        }
        addons.search(type, gameVersion, query, p, sort, loader, category, reqId);
    }

    /// 某个类型可用的类别标签（分类 / 特性 / 分辨率 / 性能影响…），按接口的 header 分组
    public void addonCategories(String type) {
        addons.categories(type);
    }

    /// 某个项目的全部可用版本（已按游戏版本 + 加载器筛过，新的在前）
    public void addonVersions(String type, String slug, String gameVersion, String loader) {
        addons.versions(type, slug, gameVersion, loader);
    }

    /// 下载到实例的 mods / resourcepacks / shaderpacks。instanceId 为空时用当前选中实例。
    /// fileName 非空则改名保存；directory 非空则存到这里（用户没选实例时挑的目录）。
    public void addonInstall(String type, String slug, String versionId, String instanceId,
                             String fileName, String directory) {
        addons.install(type, slug, versionId, instanceId, fileName, directory);
    }

    /// 这个类型默认存到哪儿（确认弹窗里显示给用户看）
    public String addonTargetDirectory(String type, String instanceId) {
        return addons.defaultTargetDirectory(type, instanceId);
    }

    /// 弹目录选择框，返回选中路径；取消返回空串。
    /// 没选实例时下载要让用户自己挑位置，这个就是那个「浏览…」按钮。
    public String chooseDirectory(String title) {
        DirectoryChooser chooser = new DirectoryChooser();
        chooser.setTitle(title == null || title.isBlank() ? "选择保存位置" : title);
        Path chosen = Controllers.showDialog(chooser);
        return chosen == null ? "" : chosen.toAbsolutePath().toString();
    }

    /// 在线整合包安装
    public void installModpackRemote(String slug, String versionId, String iconUrl, String instanceName) {
        addons.installModpackRemote(slug, versionId, iconUrl, instanceName);
    }

    /// 本地文件导入（/api/upload 把它落到临时目录之后调这里）。
    /// kind: modpack / world / resourcepack / shader
    public void importLocal(String kind, String path, String instanceId, String instanceName) {
        if (path == null || path.isBlank()) {
            return;
        }
        // 上传路径：path 指向 HTTP 服务落的临时文件，装完必须删
        addons.installLocalFile(kind, java.nio.file.Path.of(path),
                instanceId == null || instanceId.isBlank() ? null : instanceId,
                instanceName == null || instanceName.isBlank() ? null : instanceName, true);
    }

    /// 拉某个游戏版本可用的加载器版本（fabric / quilt / forge / neoforge）
    public void requestLoaderVersions(String gameVersion, String loaderType) {
        download.requestLoaderVersions(gameVersion, loaderType);
    }

    /// 问一遍各加载器在这个游戏版本下能不能装。
    /// 前端据此把不能装的卡片置灰，省掉「点开→拉清单→说没有」那一趟。
    public void requestInstallerSupport(String gameVersion) {
        download.requestInstallerSupport(gameVersion);
    }

    /// 安装「游戏 + 加载器」到新实例
    public void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        download.installLoader(gameVersion, loaderType, loaderVersion);
    }

    public void installLoaderNamed(String gameVersion, String loaderType, String loaderVersion, String instanceName) {
        download.installLoader(gameVersion, loaderType, loaderVersion, instanceName);
    }

    /// 某个实例上已经装了哪些组件。给安装弹窗的「已有实例」模式用：
    /// 装了哪个就显示哪个的版本号，旁边配 ✕（卸载）和 ↻（重装）。
    public String instanceInstallers(String instanceId) {
        JsonObject root = new JsonObject();
        JsonArray items = new JsonArray();

        try {
            var repository = GameDirectoryManager.getSelectedRepository();
            // 用 findInstance：实例不存在时返回 null，不抛异常
            var instance = repository.findInstance(new org.jackhuang.hmcl.game.GameInstanceID(instanceId));
            if (instance == null) {
                root.addProperty("error", "找不到实例 " + instanceId);
            } else {
                // 用 getManifest（未解析的原始 manifest）：resolved 那份会把 patches
                // 展开成 libraries，反而查不到「装了哪个加载器的哪个版本」
                var manifest = instance.getManifest();
                // 主版本单独报一次，前端用它确认实例跟弹窗的游戏版本对不对得上
                var game = manifest.findPatch(org.jackhuang.hmcl.game.GameComponentType.GAME);
                if (game != null && game.version() != null) {
                    root.addProperty("gameVersion", game.version());
                }
                for (org.jackhuang.hmcl.game.GameComponentType type
                        : org.jackhuang.hmcl.game.GameComponentType.values()) {
                    if (type == org.jackhuang.hmcl.game.GameComponentType.GAME) {
                        continue;
                    }
                    var patch = manifest.findPatch(type);
                    if (patch == null || patch.version() == null) {
                        continue;
                    }
                    JsonObject o = new JsonObject();
                    o.addProperty("id", type.getPatchId());
                    o.addProperty("version", patch.version());
                    items.add(o);
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to read installers of " + instanceId, e);
            root.addProperty("error", String.valueOf(e.getMessage()));
        }

        root.add("installed", items);
        return JsonUtils.GSON.toJson(root);
    }

    // ==================== 实例管理页 ====================

    /// 单个实例的完整信息：基础字段 + 路径 + 生效中的游戏设置 + 各类内容数量。
    public String instanceDetail(String instanceId) {
        JsonObject root = new JsonObject();
        HMCLGameInstance instance = findInstance(instanceId);
        if (instance == null) {
            root.addProperty("error", "找不到这个实例");
            return JsonUtils.GSON.toJson(root);
        }

        JsonObject base = instanceJson(instance);
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
    public void instanceSetting(String instanceId, String key, String value) {
        HMCLGameInstance instance = findInstance(instanceId);
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
                case "runningDirectory" -> settings.runningDirectoryProperty().setValue(nullToEmpty(value));
                case "processPriority" -> settings.processPriorityProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.game.ProcessPriority.class,
                                org.jackhuang.hmcl.game.ProcessPriority.NORMAL));
                case "launcherVisibility" -> settings.launcherVisibilityProperty().setValue(
                        enumOf(value, org.jackhuang.hmcl.setting.LauncherVisibility.class,
                                org.jackhuang.hmcl.setting.LauncherVisibility.HIDE));
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
        Platform.runLater(() -> execute("window.__hmcl && window.__hmcl.onInstanceDetail("
                + JsonUtils.GSON.toJson(json) + ")"));
    }

    private static int countAddons(String instanceId, String kind) {
        Path dir = addonDir(instanceId, kind);
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
        download.installLoader(gameVersion, loaderType, loaderVersion, instanceName, addonsSpec);
    }

    /// 列出一个附属组件当前游戏版本下可选的版本（Fabric API / QSL / Fugue / Scalar Legacy）。
    ///
    /// <p>前端点开附属卡片的版本弹窗时调；结果通过 `onAddonVersions` 推回。
    public void requestAddonVersions(String addonId, String gameVersion) {
        download.requestAddonVersions(addonId, gameVersion);
    }

    /// 把加载器装进已有实例（HMCL 的「安装到现有实例」）。
    /// instanceId 为空时退回新建，前端不用分两条路径。
    public void installLoaderTo(String instanceId, String gameVersion, String loaderType, String loaderVersion) {
        if (instanceId == null || instanceId.isBlank()) {
            download.installLoader(gameVersion, loaderType, loaderVersion);
            return;
        }
        download.installLoaderTo(instanceId, gameVersion, loaderType, loaderVersion);
    }



    // ==================== 外观偏好（主题色 / 背景图） ====================
    //
    // 这些值不属于 HMCL 的 LauncherSettings（那是上游的 schema，塞进去会被覆盖），
    // 单独存 <hmcl.dir>/config/webui.json。背景图文件放 config/ 下，
    // 由这里读成 data URL 给前端——WebView2 里 tauri.localhost 加载 file:// 会被
    // CORS 拦掉，走 data URL 最稳。

    private static final long MAX_BACKGROUND_BYTES = 12L * 1024 * 1024;

    private JsonObject uiPrefs() {
        JsonObject o = new JsonObject();
        Path file = uiPrefsFile();
        if (file != null && Files.isRegularFile(file)) {
            try (var reader = Files.newBufferedReader(file)) {
                JsonObject saved = JsonUtils.GSON.fromJson(reader, JsonObject.class);
                if (saved != null) {
                    saved.entrySet().forEach(e -> o.add(e.getKey(), e.getValue()));
                }
            } catch (Exception e) {
                LOG.warning("Failed to read webui prefs", e);
            }
        }
        return o;
    }

    @Nullable
    private static Path uiPrefsFile() {
        try {
            return org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("webui.json");
        } catch (Exception e) {
            return null;
        }
    }

    /// 读外观偏好。附带当前背景图的 data URL（没有就是空串）。
    public String getAppearancePrefs() {
        JsonObject o = uiPrefs();
        o.addProperty("background", backgroundDataUrl());
        return JsonUtils.GSON.toJson(o);
    }

    /// 写一个外观偏好项。值一律按字符串存，前端给什么就存什么。
    public void setAppearancePref(String key, String value) {
        if (key == null || key.isBlank()) {
            return;
        }
        Path file = uiPrefsFile();
        if (file == null) {
            return;
        }
        try {
            JsonObject o = uiPrefs();
            // background 是只读的（由文件本身决定），不接受前端直接写
            if ("background".equals(key)) {
                return;
            }
            o.addProperty(key, value == null ? "" : value);
            Files.createDirectories(file.getParent());
            try (var writer = Files.newBufferedWriter(file)) {
                JsonUtils.GSON.toJson(o, writer);
            }
        } catch (Exception e) {
            LOG.warning("Failed to save webui pref " + key, e);
        }
    }

    /// 选一张图当背景。
    ///
    /// 格式按**文件头魔数**判断，不看扩展名——扩展名是用户随手起的，
    /// 内容才是真的。SVG 一律拒绝：它是可执行脚本的载体，当背景渲染等于
    /// 让配置文件里的一段脚本跑起来。
    public String chooseBackground() {
        try {
            Stage stage = stage();
            FileChooser chooser = new FileChooser();
            chooser.setTitle("选择背景图");
            chooser.getExtensionFilters().add(new FileChooser.ExtensionFilter(
                    "图片", "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.bmp"));
            File picked = chooser.showOpenDialog(stage);
            if (picked == null || !picked.isFile()) {
                return "";
            }
            if (picked.length() > MAX_BACKGROUND_BYTES) {
                toast("这张图超过 12MB，换张小一点的");
                return "";
            }
            byte[] bytes = Files.readAllBytes(picked.toPath());
            String ext = sniffImageExt(bytes);
            if (ext == null) {
                toast("这个文件不是常见的图片格式");
                return "";
            }

            // 先删旧的再写新的：留下两张不同扩展名的图会让「当前背景是哪张」变得含糊
            clearBackgroundFiles();
            Path target = org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("background" + ext);
            Files.createDirectories(target.getParent());
            Files.write(target, bytes);
            String dataUrl = "data:" + mimeOf(ext) + ";base64,"
                    + java.util.Base64.getEncoder().encodeToString(bytes);
            toast("背景图已更新");
            return dataUrl;
        } catch (Exception e) {
            LOG.warning("Failed to set background", e);
            toast("设置背景图失败：" + localize(e));
            return "";
        }
    }

    public void clearBackground() {
        try {
            clearBackgroundFiles();
            toast("已恢复默认背景");
        } catch (Exception e) {
            LOG.warning("Failed to clear background", e);
        }
    }

    private static void clearBackgroundFiles() throws IOException {
        for (String ext : List.of(".png", ".jpg", ".webp", ".gif", ".bmp")) {
            Files.deleteIfExists(org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("background" + ext));
        }
    }

    /// 读当前背景图的 data URL；没有就返回空串。
    private static String backgroundDataUrl() {
        for (String ext : List.of(".png", ".jpg", ".webp", ".gif", ".bmp")) {
            try {
                Path file = org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("background" + ext);
                if (!Files.isRegularFile(file)) {
                    continue;
                }
                byte[] bytes = Files.readAllBytes(file);
                return "data:" + mimeOf(ext) + ";base64,"
                        + java.util.Base64.getEncoder().encodeToString(bytes);
            } catch (Exception ignored) {
            }
        }
        return "";
    }

    /// 按文件头判断图片类型，返回扩展名；认不出返回 null。
    private static @Nullable String sniffImageExt(byte[] b) {
        if (b.length < 12) {
            return null;
        }
        if ((b[0] & 0xFF) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
            return ".png";
        }
        if ((b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xD8) {
            return ".jpg";
        }
        if (b[0] == 'G' && b[1] == 'I' && b[2] == 'F') {
            return ".gif";
        }
        if (b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P') {
            return ".webp";
        }
        if (b[0] == 'B' && b[1] == 'M') {
            return ".bmp";
        }
        return null;
    }

    private static String mimeOf(String ext) {
        return switch (ext) {
            case ".png" -> "image/png";
            case ".gif" -> "image/gif";
            case ".webp" -> "image/webp";
            case ".bmp" -> "image/bmp";
            default -> "image/jpeg";
        };
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
        HMCLGameInstance instance = findInstance(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            toast("找不到这个实例");
            return;
        }
        if (target.equals(id)) {
            return;
        }
        // 校验规则与 HMCL 一致：id 就是目录名
        if (!HMCLGameRepository.isValidInstanceId(target)) {
            toast("名称里不能包含 \\ / : * ? 双引号 尖括号 竖线");
            return;
        }
        if (repository.instanceIdConflicts(target)) {
            toast("已经有同名实例了");
            return;
        }

        GameInstanceID oldId = instance.getId();
        GameInstanceID newId = new GameInstanceID(target);
        Task.supplyAsync(Schedulers.io(), () -> repository.renameInstance(oldId, newId))
                .thenAcceptAsync(Schedulers.javafx(), renamed -> {
                    if (!Boolean.TRUE.equals(renamed)) {
                        toast("改名失败：目标名称不可用");
                        return;
                    }
                    // 选中项跟着走，否则重进实例页会扑空
                    repository.refreshAsync()
                            .thenRunAsync(Schedulers.javafx(), () -> {
                                if (repository.hasInstance(newId)) {
                                    repository.setSelectedInstance(repository.getInstance(newId));
                                }
                                push();
                                // 前端正停在旧 id 的实例页上，不告诉它新 id 的话
                                // 页面会一直显示一个已经不存在的实例
                                JsonObject json = new JsonObject();
                                json.addProperty("from", oldId.toString());
                                json.addProperty("to", newId.toString());
                                execute("window.__hmcl && window.__hmcl.onInstanceRenamed("
                                        + JsonUtils.GSON.toJson(json.toString()) + ")");
                                toast("已改名为 " + target);
                            }).start();
                }).start();
    }

    /// 复制实例。`copySaves` 对应 HMCL 里「是否一并复制存档」那个勾选。
    public void instanceDuplicate(String id, String newName, boolean copySaves) {
        if (id == null || newName == null) {
            return;
        }
        String target = newName.trim();
        HMCLGameInstance instance = findInstance(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            toast("找不到这个实例");
            return;
        }
        if (!HMCLGameRepository.isValidInstanceId(target)) {
            toast("名称里不能包含 \\ / : * ? 双引号 尖括号 竖线");
            return;
        }
        if (repository.instanceIdConflicts(target)) {
            toast("已经有同名实例了");
            return;
        }

        GameInstanceID srcId = instance.getId();
        GameInstanceID dstId = new GameInstanceID(target);
        Task.runAsync(Schedulers.io(), () -> repository.duplicateInstance(srcId, dstId, copySaves))
                .whenComplete(Schedulers.javafx(), exception -> {
                    if (exception != null) {
                        LOG.warning("Failed to duplicate instance", exception);
                        toast("复制失败：" + localize(exception));
                        return;
                    }
                    repository.refreshAsync()
                            .thenRunAsync(Schedulers.javafx(), () -> {
                                toast("已复制为 " + target);
                                push();
                            }).start();
                }).start();
    }

    /// 删除实例。独立运行目录（不在 versions/<id> 下）的情况和 HMCL 一样整体删掉。
    public void instanceDelete(String id) {
        HMCLGameInstance instance = findInstance(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            toast("找不到这个实例");
            return;
        }
        GameInstanceID instanceId = instance.getId();
        Task.supplyAsync(Schedulers.io(), () -> repository.removeInstanceFromDisk(instanceId))
                .whenComplete(Schedulers.javafx(), (deleted, exception) -> {
                    if (exception != null || !Boolean.TRUE.equals(deleted)) {
                        LOG.warning("Failed to delete instance", exception);
                        toast("删除失败");
                        return;
                    }
                    repository.refreshAsync()
                            .thenRunAsync(Schedulers.javafx(), () -> {
                                toast("已删除 " + instanceId);
                                push();
                            }).start();
                }).start();
    }

    /// 清理垃圾文件（HMCL 的 instance.manage.clean）。
    ///
    /// 仓库层的 clean() 只删实例目录下的日志、崩溃转储这类东西，不动游戏内容，
    /// 所以不需要二次确认。
    public void instanceClean(String id) {
        HMCLGameInstance instance = findInstance(id);
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
                toast("清理失败：" + localize(exception));
            } else {
                toast("已清理垃圾文件");
            }
        }).start();
    }

    /// 清除资源文件（assets + 实例下的 resources）。
    ///
    /// 注意 assets 是**整个游戏目录共享**的，不是实例私有：删了之后这个目录下
    /// 所有实例下次启动都要重新下载。前端确认框里必须写清楚。
    public void instanceClearAssets(String id) {
        HMCLGameInstance instance = findInstance(id);
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
                toast(exception == null ? "已清除资源文件" : ("清除失败：" + localize(exception)))).start();
    }

    /// 清除库文件。同样是整个游戏目录共享的 libraries/。
    public void instanceClearLibraries(String id) {
        HMCLGameInstance instance = findInstance(id);
        HMCLGameRepository repository = repositoryOf(instance);
        if (instance == null || repository == null) {
            return;
        }
        Path libraries = repository.getBaseDirectory().resolve("libraries");
        Task.runAsync(Schedulers.io(), () -> {
            org.jackhuang.hmcl.util.io.FileUtils.deleteDirectoryQuietly(libraries);
        }).whenComplete(Schedulers.javafx(), exception ->
                toast(exception == null ? "已清除库文件" : ("清除失败：" + localize(exception)))).start();
    }

    /// 重新下载资源索引（HMCL 的 instance.manage.redownload_assets_index）。
    ///
    /// 用于 assets 索引损坏、贴图全白的情况。HMCL 会开一个任务窗口显示进度，
    /// 壳模式没有那个窗口，这里就后台跑、结束时 toast 一句。
    public void instanceRedownloadAssets(String id) {
        HMCLGameInstance instance = findInstance(id);
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
                    Platform.runLater(() -> toast(success ? "资源索引已重新下载" : "资源下载中断"));
                }
            });
            executor.start();
        } catch (Exception e) {
            LOG.warning("Failed to redownload assets", e);
            toast("重新下载失败：" + localize(e));
        }
    }

    /// 实例运行目录下某个子文件夹的绝对路径。探索菜单用它判断目录是否存在。
    public String instanceSubfolder(String id, String sub) {
        HMCLGameInstance instance = findInstance(id);
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
        HMCLGameInstance instance = findInstance(id);
        if (instance == null) {
            return;
        }
        // 测试启动也是启动，没账号一样起不来
        if (Accounts.getSelectedAccount() == null) {
            toast("请添加账号后再启动实例");
            return;
        }
        // 测试启动走的是另一条链路（Instances.testGame），不经过 startInstance，
        // 补丁必须在这里也挂一次，否则「测试启动」看到的还是旧客户端。
        // 保留 HMCL 原生显示，不再改客户端
        Instances.testGame(instance);
    }

    /// 打开实例运行目录下的某个子目录（探索菜单）。
    public void instanceOpenSubfolder(String id, String sub) {
        HMCLGameInstance instance = findInstance(id);
        if (instance == null) {
            return;
        }
        try {
            String leaf = sub == null || sub.isBlank() ? "" : Path.of(sub).getFileName().toString();
            Path dir = instance.getRunDirectory().resolve(leaf);
            if (!Files.isDirectory(dir)) {
                toast("这个文件夹还不存在");
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


    // ==================== 百宝箱 ====================
    //
    // 对照 PCL 的 PageTools：自定义下载器 + 清理。
    // 清理那一块 PCL 实际做的是「删缓存 / 日志 / 崩溃报告 / natives」，
    // 而不是真的去释放物理内存（Java 进程也做不到 EmptyWorkingSet），
    // 所以这里照着它的行为做，文案也如实写「清理垃圾文件」。

    /// 选一个目录给下载器用。返回路径字符串，前端拿来回填输入框。
    public String chooseDownloadFolder() {
        try {
            Stage stage = stage();
            DirectoryChooser chooser = new DirectoryChooser();
            chooser.setTitle("选择下载保存位置");
            File dir = chooser.showDialog(stage);
            return dir == null ? "" : dir.getAbsolutePath();
        } catch (Exception e) {
            LOG.warning("Failed to choose download folder", e);
            return "";
        }
    }

    /// 打开任意目录（百宝箱的「打开保存位置」用）。
    public void openPath(String path) {
        try {
            if (path == null || path.isBlank()) {
                openPath(org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("downloads").toString());
                return;
            }
            Path dir = Path.of(path);
            if (!Files.isDirectory(dir)) {
                Files.createDirectories(dir);
            }
            FXUtils.openFolder(dir);
        } catch (Exception e) {
            LOG.warning("Failed to open path " + path, e);
        }
    }

    /// 自定义下载（PCL 的 Tools.Test.CustomDownload）。
    ///
    /// 支持 Range 的站点会被切成 N 段并发拉，不支持的退回单线程——
    /// 盲目开多线程对不支持的站点没有任何帮助，只会把同一个文件重复下 N 遍。
    public void toolboxDownload(String url, String dir, String fileName, int threads) {
        if (url == null || url.isBlank()) {
            return;
        }
        String target = (dir == null || dir.isBlank())
                ? org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("downloads").toString()
                : dir;
        final int n = Math.max(1, Math.min(16, threads));

        Task.runAsync(Schedulers.io(), () -> {
            downloadTo(url.trim(), Path.of(target), fileName, n);
        }).whenComplete(Schedulers.javafx(), exception -> {
            if (exception != null) {
                LOG.warning("Toolbox download failed", exception);
                pushToolboxProgress(0, 0, "", true, localize(exception));
            }
        }).start();
    }

    private void downloadTo(String url, Path dir, String fileName, int threads) throws Exception {
        Files.createDirectories(dir);

        String name = fileName == null ? "" : fileName.trim();
        if (name.isEmpty()) {
            // 从 URL 末段猜一个；猜不出就用时间戳，总比报错强
            String path = URI.create(url).getPath();
            name = (path == null || path.isBlank() || path.endsWith("/"))
                    ? ("download-" + System.currentTimeMillis())
                    : path.substring(path.lastIndexOf('/') + 1);
        }
        // 只取文件名，挡住 `../` 这种路径穿越
        name = Path.of(name).getFileName().toString();
        Path target = dir.resolve(name);
        Path part = dir.resolve(name + ".part");

        var client = java.net.http.HttpClient.newBuilder()
                .followRedirects(java.net.http.HttpClient.Redirect.NORMAL)
                .connectTimeout(java.time.Duration.ofSeconds(20))
                .build();

        long total = -1;
        boolean ranged = false;
        try {
            var head = client.send(java.net.http.HttpRequest.newBuilder(URI.create(url))
                    .method("HEAD", java.net.http.HttpRequest.BodyPublishers.noBody())
                    .timeout(java.time.Duration.ofSeconds(20)).build(),
                    java.net.http.HttpResponse.BodyHandlers.discarding());
            String len = head.headers().firstValue("content-length").orElse("-1");
            total = Long.parseLong(len.trim());
            String accept = head.headers().firstValue("accept-ranges").orElse("");
            ranged = accept.toLowerCase().contains("bytes") && total > 4L * 1024 * 1024;
        } catch (Exception e) {
            // HEAD 被拒（很多站直接 405）就当不支持分段，下面走单线程
            LOG.info("HEAD failed, fallback to single connection: " + e);
        }

        int workers = ranged ? threads : 1;
        if (workers <= 1 || total <= 0) {
            downloadSingle(client, url, part, total);
        } else {
            downloadRanged(client, url, part, total, workers);
        }

        // 全部下完再改名，中途失败不会留下一个看起来完整的文件
        Files.move(part, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        // 完成时用落盘后的真实大小，不用 total：HEAD 拿不到 content-length 的站点
        // （很多 CDN 会拒 HEAD，直接 405）total 是 -1，照它显示会变成「0 B」。
        long size = Files.size(target);
        pushToolboxProgress(size, size, name, true, "");
    }

    private void downloadSingle(java.net.http.HttpClient client, String url, Path part, long total)
            throws Exception {
        var request = java.net.http.HttpRequest.newBuilder(URI.create(url))
                .timeout(java.time.Duration.ofMinutes(10)).build();
        var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
        long written = 0;
        long lastPush = 0;
        try (var in = response.body();
             var out = Files.newOutputStream(part)) {
            byte[] buf = new byte[64 * 1024];
            int read;
            while ((read = in.read(buf)) > 0) {
                out.write(buf, 0, read);
                written += read;
                long now = System.currentTimeMillis();
                // 每 200ms 推一次：每个 buffer 都推会把 HTTP 桥打满
                if (now - lastPush > 200) {
                    lastPush = now;
                    pushToolboxProgress(written, total, "", false, "");
                }
            }
        }
        pushToolboxProgress(written, total, "", false, "");
    }

    private void downloadRanged(java.net.http.HttpClient client, String url, Path part,
                                long total, int workers) throws Exception {
        // 先按最终大小建文件：每个线程用 FileChannel 往自己的区间里写，
        // 互不干扰，也不需要先下载完再拼接
        try (var channel = java.nio.channels.FileChannel.open(part,
                java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.WRITE)) {
            channel.truncate(0);
            channel.write(java.nio.ByteBuffer.allocate(1), total - 1);
        }

        java.util.concurrent.atomic.AtomicLong done = new java.util.concurrent.atomic.AtomicLong();
        java.util.concurrent.atomic.AtomicReference<Exception> failure =
                new java.util.concurrent.atomic.AtomicReference<>();

        java.util.concurrent.ExecutorService pool =
                java.util.concurrent.Executors.newFixedThreadPool(workers);
        long chunk = total / workers;
        for (int i = 0; i < workers; i++) {
            long start = i * chunk;
            long end = (i == workers - 1) ? total - 1 : (start + chunk - 1);
            pool.submit(() -> {
                try {
                    var request = java.net.http.HttpRequest.newBuilder(URI.create(url))
                            .header("Range", "bytes=" + start + "-" + end)
                            .timeout(java.time.Duration.ofMinutes(10)).build();
                    var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofInputStream());
                    try (var in = response.body();
                         var channel = java.nio.channels.FileChannel.open(part,
                                 java.nio.file.StandardOpenOption.WRITE)) {
                        byte[] buf = new byte[64 * 1024];
                        long pos = start;
                        int read;
                        while ((read = in.read(buf)) > 0) {
                            channel.write(java.nio.ByteBuffer.wrap(buf, 0, read), pos);
                            pos += read;
                            done.addAndGet(read);
                        }
                    }
                } catch (Exception e) {
                    failure.compareAndSet(null, e);
                }
            });
        }

        pool.shutdown();
        long lastPush = 0;
        while (!pool.awaitTermination(180, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            long now = System.currentTimeMillis();
            if (now - lastPush > 200) {
                lastPush = now;
                pushToolboxProgress(done.get(), total, "", false, "");
            }
        }
        pushToolboxProgress(done.get(), total, "", false, "");
        if (failure.get() != null) {
            throw failure.get();
        }
    }

    private void pushToolboxProgress(long done, long total, String fileName, boolean finished, String error) {
        JsonObject json = new JsonObject();
        json.addProperty("done", done);
        json.addProperty("total", total);
        if (fileName != null && !fileName.isBlank()) {
            json.addProperty("fileName", fileName);
        }
        json.addProperty("finished", finished);
        if (error != null && !error.isBlank()) {
            json.addProperty("error", error);
        }
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> execute("window.__hmcl && window.__hmcl.onToolboxProgress("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    /// 清理垃圾文件（PCL 的 Tools.Test.Clean）。
    ///
    /// 只清这些：各游戏目录的 logs / crash-reports / natives，以及启动器的 cache。
    /// 不动 libraries、assets、versions——那些删了要重下几百 MB，
    /// 属于「修复」不是「清理」。
    public void cleanupJunk() {
        Task.supplyAsync(Schedulers.io(), () -> {
            long freed = 0;
            int count = 0;
            java.util.List<Path> roots = new java.util.ArrayList<>();

            try {
                var repository = GameDirectoryManager.getSelectedRepository();
                if (repository != null) {
                    Path base = repository.getBaseDirectory();
                    roots.add(base.resolve("logs"));
                    roots.add(base.resolve("crash-reports"));
                    roots.add(base.resolve("natives"));
                    // 每个实例自己的 logs 与 natives
                    try (var dirs = Files.list(base.resolve("versions"))) {
                        for (Path dir : dirs.toList()) {
                            roots.add(dir.resolve("logs"));
                            roots.add(dir.resolve("crash-reports"));
                            roots.add(dir.resolve("natives"));
                        }
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            }

            try {
                String common = SettingsManager.settings().getResolvedCommonDirectory();
                if (common != null && !common.isBlank()) {
                    roots.add(Path.of(common, "cache"));
                }
            } catch (Exception ignored) {
            }

            for (Path dir : roots) {
                if (!Files.isDirectory(dir)) {
                    continue;
                }
                try (var walk = Files.walk(dir)) {
                    for (Path p : walk.sorted(java.util.Comparator.reverseOrder()).toList()) {
                        try {
                            if (Files.isRegularFile(p)) {
                                freed += Files.size(p);
                                Files.delete(p);
                                count++;
                            } else if (!p.equals(dir)) {
                                Files.delete(p);
                            }
                        } catch (Exception ignored) {
                        }
                    }
                } catch (Exception ignored) {
                }
            }

            JsonObject result = new JsonObject();
            result.addProperty("count", count);
            result.addProperty("freed", freed);
            return result.toString();
        }).whenComplete(Schedulers.javafx(), (result, exception) -> {
            if (exception != null) {
                LOG.warning("Failed to clean junk", exception);
                toast("清理失败：" + localize(exception));
                return;
            }
            String text = JsonUtils.GSON.toJson(result);
            execute("window.__hmcl && window.__hmcl.onCleanupResult(" + text + ")");
            toast("清理完成");
        }).start();
    }

    // ==================== 窗口（自绘标题栏） ====================

    private double dragMouseX;
    private double dragMouseY;
    private double dragStageX;
    private double dragStageY;

    private double resizeMouseX;
    private double resizeMouseY;
    private double resizeWidth;
    private double resizeHeight;
    private String resizeEdge = "";

    private static @Nullable Stage stage() {
        return Controllers.getStage();
    }

    public void minimize() {
        Stage stage = stage();
        if (stage != null) {
            stage.setIconified(true);
        }
    }

    public void toggleMaximize() {
        Stage stage = stage();
        if (stage != null) {
            stage.setMaximized(!stage.isMaximized());
        }
    }

    public void close() {
        Platform.exit();
    }

    /// 记录拖拽起点。参数是屏幕坐标（JS 的 e.screenX / e.screenY）
    public void dragStart(double screenX, double screenY) {
        Stage stage = stage();
        if (stage == null) {
            return;
        }
        dragMouseX = screenX;
        dragMouseY = screenY;
        dragStageX = stage.getX();
        dragStageY = stage.getY();
    }

    public void dragMove(double screenX, double screenY) {
        Stage stage = stage();
        if (stage == null || stage.isMaximized() || stage.isFullScreen()) {
            return;
        }
        stage.setX(dragStageX + (screenX - dragMouseX));
        stage.setY(dragStageY + (screenY - dragMouseY));
    }

    /// edge 取值：n / s / e / w / ne / nw / se / sw
    public void resizeStart(double screenX, double screenY, String edge) {
        Stage stage = stage();
        if (stage == null) {
            return;
        }
        dragStageX = stage.getX();
        dragStageY = stage.getY();
        resizeMouseX = screenX;
        resizeMouseY = screenY;
        resizeWidth = stage.getWidth();
        resizeHeight = stage.getHeight();
        resizeEdge = edge != null ? edge : "";
    }

    public void resizeMove(double screenX, double screenY) {
        Stage stage = stage();
        if (stage == null || stage.isMaximized() || resizeEdge.isEmpty()) {
            return;
        }

        double dx = screenX - resizeMouseX;
        double dy = screenY - resizeMouseY;
        double minWidth = stage.getMinWidth() > 0 ? stage.getMinWidth() : 960;
        double minHeight = stage.getMinHeight() > 0 ? stage.getMinHeight() : 640;

        if (resizeEdge.contains("e")) {
            stage.setWidth(Math.max(minWidth, resizeWidth + dx));
        }
        if (resizeEdge.contains("s")) {
            stage.setHeight(Math.max(minHeight, resizeHeight + dy));
        }
        if (resizeEdge.contains("w")) {
            double width = Math.max(minWidth, resizeWidth - dx);
            stage.setX(dragStageX + (resizeWidth - width));
            stage.setWidth(width);
        }
        if (resizeEdge.contains("n")) {
            double height = Math.max(minHeight, resizeHeight - dy);
            stage.setY(dragStageY + (resizeHeight - height));
            stage.setHeight(height);
        }
    }

    // ==================== 杂项 ====================

    public void openLink(String url) {
        if (url != null && !url.isBlank()) {
            FXUtils.openLink(url);
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

    private void pushNews(String json) {
        execute("window.__hmcl && window.__hmcl.onNews(" + JsonUtils.GSON.toJson(json) + ")");
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
            return imageToDataUrl(instance.getIconImage(), 64);
        } catch (Exception e) {
            return null;
        }
    }

    /// 头像。优先用「外观」页里选中的那张皮肤——用户在衣柜里换了皮肤，
    /// 左下角账号卡和账号列表的头像要跟着变，否则一身新皮配一张旧脸。
    /// 没选（或读不到）才回退到账号自带的纹理。
    /// 没有账号时的头像：内置的 Steve 皮肤。
    ///
    /// 以前这里返回 null，前端退回一个紫色渐变色块——未登录时账号页和左下角
    /// 各挂着一块突兀的紫色方块。现在统一用 Steve 的头，视觉上就是「一个默认皮肤」。
    private String defaultAvatarDataUrl() {
        try {
            return imageToDataUrl(headImage(TexturesLoader.getDefaultSkinImage()), 64);
        } catch (Exception e) {
            LOG.warning("Failed to render default avatar", e);
            return null;
        }
    }

    private String avatarDataUrl(Account account) {
        // 必须按「这个账号自己」的外观状态取，不能用当前选中的账号——
        // 否则账号列表里所有头像都会变成当前账号的皮肤（切一次账号串一次）。
        String id = account.getAccountID().toString();
        Image fromAppearance = appearanceSkin(id);
        if (fromAppearance != null) {
            return imageToDataUrl(headImage(fromAppearance), 64);
        }

        // 当前账号的纹理绑定已经挂着了，直接用它的结果
        String selectedId = selectedAccountId();
        if (id.equals(selectedId) && accountSkinCache != null) {
            return imageToDataUrl(headImage(accountSkinCache), 64);
        }

        Image cached = accountHeads.get(id);
        if (cached == null) {
            // 内存没有就看磁盘。这一步是同步的，但只是读一张 64×64 的 PNG，
            // 换来的是「首帧就是真实头像」——不然列表里会先闪一下兜底皮肤。
            AccountTextureCache.Cached disk = AccountTextureCache.getInstance().load(id);
            if (disk != null && disk.skin() != null) {
                cached = disk.skin();
                accountHeads.put(id, cached);
            }
        }
        if (cached != null) {
            return imageToDataUrl(headImage(cached), 64);
        }

        // 磁盘也没有，才去拉网络。以前这里每次调用都新建一个绑定、取一次 getValue()：
        // 拿到的是「还没加载完」的兜底皮肤，而且每渲染一次界面就重下一遍纹理。
        loadAccountHead(account);
        return null;
    }

    /// 异步加载某个账号的头像纹理，到货后存缓存并重推一次界面。
    private void loadAccountHead(Account account) {
        String id = account.getAccountID().toString();
        if (!accountHeadsLoading.add(id)) {
            return; // 已经在拉了
        }
        try {
            ObservableValue<TexturesLoader.LoadedTexture> binding = TexturesLoader.skinBinding(account);
            TexturesLoader.LoadedTexture immediate = binding.getValue();
            if (immediate != null && immediate.image() != null) {
                accountHeads.put(id, immediate.image());
                accountHeadsLoading.remove(id);
                return;
            }
            binding.addListener((obs, before, after) -> {
                accountHeadsLoading.remove(id);
                if (after == null || after.image() == null) {
                    return;
                }
                accountHeads.put(id, after.image());
                // 顺手补进磁盘缓存：下次启动这个账号的头像就不用等网络了
                AccountTextureCache.getInstance().storeSkin(
                        id, after.image(), "slim".equals(after.metadata().get("model")));
                Platform.runLater(this::push);
            });
            // 绑定不放字段会被 GC，异步加载结果就回不来了
            headBindings.put(id, binding);
        } catch (Exception e) {
            accountHeadsLoading.remove(id);
            LOG.warning("Failed to load account head for " + id, e);
        }
    }

    /// 账号当前选中的外观皮肤（没有就返回 null）
    private @Nullable Image appearanceSkin(String accountId) {
        try {
            String id = appearance.stateOf(accountId).getSkin();
            if (id == null || id.isBlank()) {
                return null;
            }
            for (AppearanceStore.Asset asset : appearance.list(AppearanceStore.Kind.SKIN)) {
                if (id.equals(asset.getId())) {
                    return appearance.image(AppearanceStore.Kind.SKIN, asset);
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to read appearance skin", e);
        }
        return null;
    }

    /// 从 64×64 皮肤里截 8×8 的脸部（含帽子层叠加）
    private static Image headImage(Image skin) {
        int unit = Math.max(1, (int) skin.getWidth() / 64);
        int size = 8 * unit;
        WritableImage out = new WritableImage(size, size);
        PixelReader reader = skin.getPixelReader();
        if (reader == null) {
            return out;
        }
        for (int y = 0; y < size; y++) {
            for (int x = 0; x < size; x++) {
                int face = reader.getArgb(8 * unit + x, 8 * unit + y);
                int hat = unit * 40 + 8 <= skin.getWidth()
                        ? reader.getArgb(40 * unit + x, 8 * unit + y)
                        : 0;
                int alpha = (hat >>> 24) & 0xFF;
                out.getPixelWriter().setArgb(x, y, alpha > 0 ? hat : face);
            }
        }
        return out;
    }

    /// 原样编码，不缩放也不改比例。预览图是竖版（340×425），走 `imageToDataUrl`
    /// 会被压成正方形（那个方法是给 64×64 图标用的）。
    static String imageToDataUrlExact(Image image) {
        Objects.requireNonNull(image);
        int width = Math.max(1, (int) image.getWidth());
        int height = Math.max(1, (int) image.getHeight());

        BufferedImage buffered = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        if (reader != null) {
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    buffered.setRGB(x, y, reader.getArgb(x, y));
                }
            }
        }

        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(buffered, "png", out);
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (IOException e) {
            LOG.warning("Failed to encode image", e);
            return null;
        }
    }

    static String imageToDataUrl(Image image, int size) {
        Objects.requireNonNull(image);
        int width = Math.max(1, (int) image.getWidth());
        int height = Math.max(1, (int) image.getHeight());

        BufferedImage buffered = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        if (reader != null) {
            for (int y = 0; y < size; y++) {
                int sy = Math.min(height - 1, y * height / size);
                for (int x = 0; x < size; x++) {
                    int sx = Math.min(width - 1, x * width / size);
                    buffered.setRGB(x, y, reader.getArgb(sx, sy));
                }
            }
        }

        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(buffered, "png", out);
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (IOException e) {
            LOG.warning("Failed to encode image", e);
            return null;
        }
    }
}
