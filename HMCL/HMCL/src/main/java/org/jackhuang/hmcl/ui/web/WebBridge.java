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
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import javafx.scene.web.WebEngine;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorAccount;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.setting.GameInstanceIconType;
import org.jackhuang.hmcl.setting.GameSettings;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.ui.account.AddAuthlibInjectorServerPane;
import org.jackhuang.hmcl.ui.account.CreateAccountPane;
import org.jackhuang.hmcl.ui.account.MicrosoftAccountLoginPane;
import org.jackhuang.hmcl.ui.instances.Instances;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;
import org.jackhuang.hmcl.util.gson.JsonUtils;
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

    private final WebEngine engine;
    private final WebUIPage page;
    private final AppearanceStore appearance = AppearanceStore.getInstance();

    /// 实例目录占用缓存：id -> bytes
    private final Map<String, Long> instanceSizes = new ConcurrentHashMap<>();
    private final Set<String> pendingSizes = ConcurrentHashMap.newKeySet();

    private volatile String newsJson;
    private volatile boolean newsLoading;

    WebBridge(WebEngine engine, WebUIPage page) {
        this.engine = engine;
        this.page = page;
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
        root.addProperty("theme", isDark() ? "dark" : "light");
        root.addProperty("env", "HMCL " + org.jackhuang.hmcl.Metadata.VERSION
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

        // 版本号优先用探测到的值；探测失败（缺 jar）时退回 manifest id，避免界面显示 unknown
        String gameVersion = instance.getVersion().toString();
        if (gameVersion.isBlank() || "unknown".equalsIgnoreCase(gameVersion) || "0.0".equals(gameVersion)) {
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
        GameDirectoryManager.setSelectedInstance(instance);
        Instances.launch(instance);
        push();
    }

    public void openFolder(String id) {
        HMCLGameInstance instance = findInstance(id);
        if (instance != null) {
            Instances.openFolder(instance);
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
            Controllers.showToast("设置图标失败：" + e.getMessage());
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

    public void loginOffline() {
        Controllers.dialog(new CreateAccountPane(Accounts.FACTORY_OFFLINE));
    }

    public void loginMicrosoft() {
        Controllers.dialog(new MicrosoftAccountLoginPane());
    }

    public void loginAuthlib() {
        Controllers.dialog(new AddAuthlibInjectorServerPane());
    }

    public void selectAccount(String uuid) {
        for (Account account : Accounts.getAccounts()) {
            if (account.getAccountID().toString().equals(uuid)) {
                Accounts.setSelectedAccount(account);
                push();
                return;
            }
        }
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
            } catch (Exception e) {
                LOG.warning("Failed to fetch patch notes", e);
                JsonObject error = new JsonObject();
                error.addProperty("error", e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
                json = JsonUtils.GSON.toJson(error);
            }
            newsJson = json;
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
            item.addProperty("url", contentPath.isEmpty()
                    ? "https://www.minecraft.net/zh-hans/article"
                    : CONTENT_BASE + "/v2/" + contentPath);

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

    private static String optString(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
    }

    // ==================== 外观（皮肤 / 披风 / 鞘翅） ====================

    /// 账号当前纹理缓存，用于「还没选本地文件时」的兜底预览
    private volatile Image accountSkinCache;
    private volatile boolean accountSkinSlim;
    private volatile Image accountCapeCache;
    private final Map<String, Image> serverCapeImages = new ConcurrentHashMap<>();
    private String pendingServerCape;
    private double previewYaw = 180;
    private boolean previewYawTouched;

    public String appearance() {
        Account account = Accounts.getSelectedAccount();
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

        AppearanceStore.State state = appearance.stateOf(accountId);
        JsonObject stateJson = new JsonObject();
        stateJson.addProperty("skin", state.getSkin());
        stateJson.addProperty("cape", state.getCape());
        stateJson.addProperty("model", state.getModel());
        stateJson.addProperty("capeMode", state.getCapeMode());
        root.add("state", stateJson);
        // 空串 = 用户明确选了「不戴披风」但还没应用；null = 没动过
        root.addProperty("pendingServerCape", pendingServerCape);

        root.addProperty("accountSkin", accountSkinCache != null ? imageToDataUrl(accountSkinCache, 96) : null);
        root.addProperty("accountCape", accountCapeCache != null ? imageToDataUrl(accountCapeCache, 96) : null);
        return JsonUtils.GSON.toJson(root);
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
                item.addProperty("preview", imageToDataUrl(appearance.image(kind, asset), 64));
            } catch (Exception e) {
                item.addProperty("preview", (String) null);
            }
            if (kind == AppearanceStore.Kind.CAPE && asset.isHasElytra()) {
                Image elytra = appearance.elytraImage(asset);
                item.addProperty("elytraPreview", elytra != null ? imageToDataUrl(elytra, 64) : (String) null);
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
            AppearanceStore.State state = stateOfSelectedAccount();
            state.skin = asset.getId();
            state.model = asset.getModel();
            appearance.saveState(selectedAccountId(), state);
            pushAppearance();
            refreshPreview();
        } catch (Exception e) {
            LOG.warning("Failed to import skin", e);
            Controllers.showToast("导入皮肤失败：" + e.getMessage());
        }
    }

    /// 选披风文件；多选第二张作为独立鞘翅贴图
    public void importCape() {
        FileChooser chooser = new FileChooser();
        chooser.setTitle("导入披风（可同时选中鞘翅贴图）");
        chooser.getExtensionFilters().add(FXUtils.getImageExtensionFilter());
        List<File> files = chooser.showOpenMultipleDialog(Controllers.getStage());
        if (files == null || files.isEmpty()) {
            return;
        }
        try {
            Path capeFile = files.get(0).toPath();
            Path elytraFile = files.size() > 1 ? files.get(1).toPath() : null;
            AppearanceStore.Asset asset = appearance.importCape(capeFile, elytraFile);
            AppearanceStore.State state = stateOfSelectedAccount();
            state.cape = asset.getId();
            appearance.saveState(selectedAccountId(), state);
            pushAppearance();
            refreshPreview();
        } catch (Exception e) {
            LOG.warning("Failed to import cape", e);
            Controllers.showToast("导入披风失败：" + e.getMessage());
        }
    }

    public void selectSkin(String id) {
        AppearanceStore.State state = stateOfSelectedAccount();
        // 空串来自「账号当前皮肤」那张卡，表示回到服务器下发的皮肤
        state.skin = (id == null || id.isBlank()) ? null : id;
        AppearanceStore.Asset asset = appearance.find(AppearanceStore.Kind.SKIN, state.skin);
        if (asset != null && asset.getModel() != null) {
            state.model = asset.getModel();
        }
        appearance.saveState(selectedAccountId(), state);
        pushAppearance();
        refreshPreview();
    }

    /// 选择披风。传 null 或空串表示「不戴披风」——这是明确的选择，不是"还没选"。
    public void selectCape(String id) {
        AppearanceStore.State state = stateOfSelectedAccount();
        state.cape = (id == null || id.isBlank()) ? null : id;
        // 本地披风和正版服务器披风互斥，选本地就清掉待提交的服务器披风
        pendingServerCape = null;
        appearance.saveState(selectedAccountId(), state);
        pushAppearance();
        refreshPreview();
    }

    public void removeSkin(String id) {
        appearance.remove(AppearanceStore.Kind.SKIN, id);
        AppearanceStore.State state = stateOfSelectedAccount();
        if (id != null && id.equals(state.skin)) {
            state.skin = null;
            appearance.saveState(selectedAccountId(), state);
        }
        pushAppearance();
        refreshPreview();
    }

    public void removeCape(String id) {
        appearance.remove(AppearanceStore.Kind.CAPE, id);
        AppearanceStore.State state = stateOfSelectedAccount();
        if (id != null && id.equals(state.cape)) {
            state.cape = null;
            appearance.saveState(selectedAccountId(), state);
        }
        pushAppearance();
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
        AppearanceStore.State state = stateOfSelectedAccount();
        state.model = "slim".equals(model) ? "slim" : "default";
        appearance.saveState(selectedAccountId(), state);
        pushAppearance();
        refreshPreview();
    }

    public void setCapeMode(String mode) {
        AppearanceStore.State state = stateOfSelectedAccount();
        state.capeMode = "elytra".equals(mode) ? "elytra" : "cape";
        appearance.saveState(selectedAccountId(), state);
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
        }).start();
    }

    /// 正版账号：选中服务器上的某件披风（只改预览，应用时才提交）。
    /// 传空串表示明确不戴披风，应用时会发 DELETE 把当前披风摘掉。
    public void selectServerCape(String capeId) {
        pendingServerCape = capeId == null ? "" : capeId;
        pushAppearance();
        refreshPreview();
    }

    private String selectedAccountId() {
        Account account = Accounts.getSelectedAccount();
        return account != null ? account.getAccountID().toString() : "none";
    }

    private AppearanceStore.State stateOfSelectedAccount() {
        return appearance.stateOf(selectedAccountId());
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
        Image elytra = null;
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
                    elytra = appearance.elytraImage(capeAsset);
                } catch (IOException e) {
                    LOG.warning("Failed to load selected cape", e);
                }
            }
            // 本地没选，才退回账号自带的披风
            if (cape == null) {
                cape = accountCapeCache;
            }
        }

        SkinCanvas canvas = page.getPreviewCanvas();
        canvas.updateSkin(skin, slim, cape, elytra);
        boolean elytraMode = "elytra".equals(state.getCapeMode());
        canvas.setCapeMode(elytraMode ? SkinCanvas.CapeMode.ELYTRA : SkinCanvas.CapeMode.CAPE);

        // 皮肤标签看正面；披风标签转到背面 3/4，否则选了披风也看不见。
        // 没有背饰时一律正面——转过去只会看到后脑勺。
        if (!previewYawTouched) {
            boolean wantBack = cape != null && "cape".equals(appearanceTab);
            previewYaw = wantBack ? (elytraMode ? 318 : 326) : 180;
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

        String dataUrl = page.snapshotPreview();
        if (dataUrl != null) {
            execute("window.__hmcl && window.__hmcl.onPreview(" + JsonUtils.GSON.toJson(dataUrl) + ")");
        }
    }

    /// 账号纹理到手后刷新缓存与预览
    void onAccountTextures(TexturesLoader.LoadedTexture skin, TexturesLoader.LoadedTexture cape) {
        if (skin != null) {
            accountSkinCache = skin.image();
            accountSkinSlim = "slim".equals(skin.metadata().get("model"));
        }
        if (cape != null) {
            accountCapeCache = cape.image();
        }
        refreshPreview();
    }

    /// 应用：离线写本地皮肤路径；正版上传皮肤 + 提交披风；外置认证不支持更换
    public void applyAppearance() {
        Account account = Accounts.getSelectedAccount();
        if (account == null) {
            return;
        }

        AppearanceStore.State state = stateOfSelectedAccount();

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
            Controllers.showToast("已保存到离线账号");
            pushAppearance();
            return;
        }

        if (account instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount microsoftAccount) {
            Task.runAsync(() -> {
                try {
                    AppearanceStore.Asset skinAsset = appearance.find(AppearanceStore.Kind.SKIN, state.getSkin());
                    if (skinAsset != null) {
                        microsoftAccount.uploadSkin("slim".equals(state.getModel()),
                                appearance.fileOf(AppearanceStore.Kind.SKIN, skinAsset.getId()));
                    }
                    if (pendingServerCape != null) {
                        // 空串 = 明确不戴披风，走 DELETE
                        microsoftAccount.setActiveCape(pendingServerCape.isEmpty() ? null : pendingServerCape);
                    }
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            }).whenComplete(Schedulers.javafx(), exception -> {
                if (exception != null) {
                    LOG.warning("Failed to apply appearance", exception);
                    Controllers.showToast("应用失败：" + Accounts.localizeErrorMessage(exception));
                } else {
                    Controllers.showToast("已应用到正版账号");
                    pendingServerCape = null;
                    pushAppearance();
                }
            }).start();
            return;
        }

        Controllers.showToast("外置认证账号请前往对应平台修改外观");
    }

    private void pushAppearance() {
        execute("window.__hmcl && window.__hmcl.onAppearance(" + JsonUtils.GSON.toJson(appearance()) + ")");
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

    private static String avatarDataUrl(Account account) {
        try {
            var binding = TexturesLoader.skinBinding(account);
            var texture = binding.getValue();
            if (texture == null) {
                return null;
            }
            return imageToDataUrl(headImage(texture.image()), 64);
        } catch (Exception e) {
            LOG.warning("Failed to render avatar", e);
            return null;
        }
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
