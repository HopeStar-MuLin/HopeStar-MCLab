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
import javafx.scene.image.Image;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.web.AppearanceStore.Kind;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 启动器自身的外观偏好：主题色、背景图。
///
/// <p>存在 `data/config/webui.json`（[#uiPrefsFile]），和「实例主题」是两套东西：
/// 那边是某个实例的图标 / 窗口标题，这边只影响启动器界面。
///
/// <p>背景图放在外观库里（{@link AppearanceStore} 的 `backgrounds/`），
/// 和皮肤、披风同一套「导入 → 库存 → 切换」。以前是 `config/background.<ext>`
/// 一个文件，换一张就把上一张覆盖掉，用户没法在几张之间来回切。
@NotNullByDefault
public final class ThemeApi {

    private final BridgeHost host;

    /// 缩略图缓存：资产 id → dataUrl。
    ///
    /// <p>列表里每张图都要转一次 base64，一张 4K 图要几百毫秒；不缓存的话
    /// 每次进设置页都要重新算一遍，界面会明显卡一下。
    private final Map<String, String> thumbs = new ConcurrentHashMap<>();

    ThemeApi(BridgeHost host) {
        this.host = host;
    }

    private static final long MAX_BACKGROUND_BYTES = 12L * 1024 * 1024;

    // ==================== 偏好读写 ====================

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

    private static Path uiPrefsFile() {
        try {
            return org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("webui.json");
        } catch (Exception e) {
            return null;
        }
    }

    private void writePref(String key, String value) {
        Path file = uiPrefsFile();
        if (file == null) {
            return;
        }
        try {
            JsonObject o = uiPrefs();
            o.addProperty(key, value == null ? "" : value);
            Files.createDirectories(file.getParent());
            try (var writer = Files.newBufferedWriter(file)) {
                JsonUtils.GSON.toJson(o, writer);
            }
        } catch (Exception e) {
            LOG.warning("Failed to save webui pref " + key, e);
        }
    }

    // ==================== 对外接口 ====================

    /// 读外观偏好。附带背景图库和当前选中的那张。
    ///
    /// <p>返回里 `background` 是当前背景的**全尺寸** dataUrl（直接给 `background-image` 用），
    /// `backgrounds` 是库里的缩略图列表（给下拉挑选用）。
    public String getAppearancePrefs() {
        migrateLegacyBackgroundFile();

        JsonObject o = uiPrefs();
        String currentId = currentBackgroundId(o);
        o.addProperty("backgroundId", currentId);
        o.addProperty("background", backgroundDataUrl(currentId));
        o.add("backgrounds", backgroundsJson());
        // 老字段：前端还在用它判断「有没有背景」，留着免得旧页面读不到
        o.addProperty("hasBackground", !currentId.isEmpty());
        // 实例主题开关。默认允许 —— 这个功能本来就是给多实例分开配色用的，
        // 默认关掉等于把一个已存在的特性藏起来。存的是字符串（writePref 统一按字符串写）。
        if (!o.has("allowInstanceTheme")) {
            o.addProperty("allowInstanceTheme", "true");
        }
        // 毛玻璃模糊半径（px）。0 = 不模糊。
        if (!o.has("glassBlur")) {
            o.addProperty("glassBlur", "18");
        }
        return JsonUtils.GSON.toJson(o);
    }

    /// 写一个外观偏好项。值一律按字符串存，前端给什么就存什么。
    public void setAppearancePref(String key, String value) {
        if (key == null || key.isBlank()) {
            return;
        }
        // 这两项由文件本身 / 图库决定，不接受前端直接写
        if ("background".equals(key) || "backgroundId".equals(key) || "hasBackground".equals(key)) {
            return;
        }
        writePref(key, value == null ? "" : value);
    }

    /// 导入一张背景图：选文件 → 复制进外观库 → 设为当前 → 返回整个偏好。
    ///
    /// <p>格式按**文件头魔数**判断，不看扩展名——扩展名是用户随手起的，内容才是真的。
    /// SVG 一律拒绝：它是可执行脚本的载体，当背景渲染等于让配置文件里的一段脚本跑起来。
    public String importBackground() {
        try {
            Stage stage = Controllers.getStage();
            FileChooser chooser = new FileChooser();
            chooser.setTitle("选择背景图");
            chooser.getExtensionFilters().add(new FileChooser.ExtensionFilter(
                    "图片", "*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.bmp"));
            File picked = chooser.showOpenDialog(stage);
            if (picked == null || !picked.isFile()) {
                return "";
            }
            if (picked.length() > MAX_BACKGROUND_BYTES) {
                host.toast("这张图超过 12MB，换张小一点的");
                return "";
            }

            byte[] bytes = Files.readAllBytes(picked.toPath());
            String ext = sniffImageExt(bytes);
            if (ext == null) {
                host.toast("这个文件不是常见的图片格式");
                return "";
            }

            // AppearanceStore 是按路径导入的（它要算哈希、读尺寸），先落个临时文件。
            // 临时文件用完就删，库里存的是复制出来的那一份。
            Path tmp = Files.createTempFile("hmcl-bg-", ext);
            try {
                Files.write(tmp, bytes);
                var asset = AppearanceStore.getInstance()
                        .importBackground(tmp, ext, picked.getName());
                thumbs.remove(asset.getId());
                setCurrentBackgroundId(asset.getId());
                host.toast("背景图已导入");
            } finally {
                try {
                    Files.deleteIfExists(tmp);
                } catch (Exception ignored) {
                    // 临时文件删不掉不影响功能，系统重启会清
                }
            }
            return getAppearancePrefs();
        } catch (Exception e) {
            LOG.warning("Failed to import background", e);
            host.toast("导入背景图失败：" + BridgeHost.localize(e));
            return "";
        }
    }

    /// 「透出桌面」这个背景选项的保留 ID。
    ///
    /// 它不指向图库里的任何一张图，而是一个开关：选中时窗口不画背景，
    /// 桌面（包括 Wallpaper Engine 的动态壁纸）就透过透明窗口显示出来。
    /// 之所以做成背景列表里的一项而不是独立开关，是因为「用哪张图」和
    /// 「不画图」在语义上互斥，放同一个单选里最不容易出现两种状态同时生效。
    public static final String DESKTOP_BACKGROUND_ID = "desktop";

    /// 切换到库里已有的某张背景。`id` 为空 = 恢复默认背景，`desktop` = 透出桌面。
    public String setBackground(String id) {
        String target = id == null ? "" : id.trim();
        boolean desktop = DESKTOP_BACKGROUND_ID.equals(target);
        // 虚拟选项不走图库校验，其余仍然必须存在
        if (!target.isEmpty() && !desktop
                && AppearanceStore.getInstance().find(Kind.BACKGROUND, target) == null) {
            return "";
        }
        setCurrentBackgroundId(target);
        if (desktop) {
            return "";
        }
        return backgroundDataUrl(target);
    }

    /// 重命名图库里的一张背景。
    public String renameBackground(String id, String name) {
        if (id == null || id.isBlank() || name == null || name.isBlank()) {
            return getAppearancePrefs();
        }
        AppearanceStore.getInstance().rename(Kind.BACKGROUND, id, name.trim());
        return getAppearancePrefs();
    }

    /// 从图库里删掉一张背景。删的是当前那张时顺带恢复默认。
    public String removeBackground(String id) {
        if (id == null || id.isBlank()) {
            return getAppearancePrefs();
        }
        AppearanceStore.getInstance().remove(Kind.BACKGROUND, id);
        thumbs.remove(id);
        if (id.equals(rawBackgroundId())) {
            setCurrentBackgroundId("");
        }
        return getAppearancePrefs();
    }

    /// 恢复默认背景（不删图，只是取消选中）。
    public void clearBackground() {
        setCurrentBackgroundId("");
    }

    // ==================== 内部实现 ====================

    private static String rawBackgroundId() {
        Path file = uiPrefsFile();
        if (file == null || !Files.isRegularFile(file)) {
            return "";
        }
        try (var reader = Files.newBufferedReader(file)) {
            JsonObject saved = JsonUtils.GSON.fromJson(reader, JsonObject.class);
            if (saved != null && saved.has("backgroundId") && !saved.get("backgroundId").isJsonNull()) {
                return saved.get("backgroundId").getAsString();
            }
        } catch (Exception e) {
            LOG.warning("Failed to read backgroundId", e);
        }
        return "";
    }

    /// 当前选中的背景 id。文件已经不在了就当作没选——否则界面上会是一片空白，
    /// 用户还以为背景加载失败了。
    private static String currentBackgroundId(JsonObject prefs) {
        String id = (prefs.has("backgroundId") && !prefs.get("backgroundId").isJsonNull())
                ? prefs.get("backgroundId").getAsString()
                : "";
        if (id.isEmpty()) {
            return "";
        }
        // 「透出桌面」是虚拟选项，图库里当然找不到它 —— 这里要放行，
        // 否则选了它下次启动会被当成「无效 id」重置回默认背景，
        // 用户看到的就是「选了透图，重启又变回壁纸」。
        if (DESKTOP_BACKGROUND_ID.equals(id)) {
            return id;
        }
        return AppearanceStore.getInstance().find(Kind.BACKGROUND, id) != null ? id : "";
    }

    private void setCurrentBackgroundId(String id) {
        writePref("backgroundId", id == null ? "" : id);
    }

    private static String backgroundDataUrl(String id) {
        if (id == null || id.isBlank()) {
            return "";
        }
        AppearanceStore store = AppearanceStore.getInstance();
        var asset = store.find(Kind.BACKGROUND, id);
        if (asset == null) {
            return "";
        }
        try {
            byte[] bytes = Files.readAllBytes(store.fileOf(Kind.BACKGROUND, id));
            String ext = (asset.format == null || asset.format.isBlank()) ? "png" : asset.format;
            return "data:" + mimeOf("." + ext) + ";base64," + Base64.getEncoder().encodeToString(bytes);
        } catch (Exception e) {
            LOG.warning("Failed to read background " + id, e);
            return "";
        }
    }

    private JsonArray backgroundsJson() {
        JsonArray array = new JsonArray();
        for (var asset : AppearanceStore.getInstance().list(Kind.BACKGROUND)) {
            JsonObject o = new JsonObject();
            o.addProperty("id", asset.getId());
            o.addProperty("name", asset.getName());
            o.addProperty("thumb", thumbOf(asset));
            array.add(o);
        }
        return array;
    }

    private String thumbOf(AppearanceStore.Asset asset) {
        String cached = thumbs.get(asset.getId());
        if (cached != null) {
            return cached;
        }
        try {
            Image image = AppearanceStore.getInstance().image(Kind.BACKGROUND, asset);
            if (image == null) {
                return "";
            }
            // 320×180：16:9 一屏能摆四五个，够看清是哪张图
            String url = ImageCodec.toDataUrlFit(image, 320, 180);
            if (url != null) {
                thumbs.put(asset.getId(), url);
                return url;
            }
        } catch (Exception e) {
            LOG.warning("Failed to build thumbnail for " + asset.getId(), e);
        }
        return "";
    }

    /// 老版本的背景图是 `config/background.<ext>` 一个文件。
    ///
    /// <p>现在改成图库里的多张，这里做一次性搬迁：导入、设为当前、删旧文件。
    /// 不搬的话老用户升级之后背景会「凭空消失」——文件还在，但没人读了。
    private void migrateLegacyBackgroundFile() {
        try {
            Path config = org.jackhuang.hmcl.Metadata.HMCL_LOCAL_HOME.resolve("config");
            if (!Files.isDirectory(config)) {
                return;
            }
            for (String ext : List.of(".png", ".jpg", ".webp", ".gif", ".bmp")) {
                Path old = config.resolve("background" + ext);
                if (!Files.isRegularFile(old)) {
                    continue;
                }
                if (rawBackgroundId().isEmpty()) {
                    var asset = AppearanceStore.getInstance().importBackground(old, ext, "旧背景图");
                    setCurrentBackgroundId(asset.getId());
                }
                Files.deleteIfExists(old);
                break;
            }
        } catch (Exception e) {
            LOG.warning("Failed to migrate legacy background file", e);
        }
    }

    /// 按文件头判断图片类型，返回扩展名（带点）；认不出返回 null。
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
}
