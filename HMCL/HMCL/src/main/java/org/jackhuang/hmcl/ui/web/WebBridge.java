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
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.ui.account.AddAuthlibInjectorServerPane;
import org.jackhuang.hmcl.ui.account.CreateAccountPane;
import org.jackhuang.hmcl.ui.account.MicrosoftAccountLoginPane;
import org.jackhuang.hmcl.ui.instances.Instances;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
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

    /// 实例目录占用缓存：id -> bytes
    private final Map<String, Long> instanceSizes = new ConcurrentHashMap<>();
    private final Set<String> pendingSizes = ConcurrentHashMap.newKeySet();

    private volatile String newsJson;
    private volatile boolean newsLoading;

    WebBridge(WebEngine engine) {
        this.engine = engine;
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
