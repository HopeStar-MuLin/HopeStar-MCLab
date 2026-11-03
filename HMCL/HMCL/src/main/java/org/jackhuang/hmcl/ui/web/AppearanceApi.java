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
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import javafx.application.Platform;
import javafx.beans.value.ObservableValue;
import javafx.scene.image.Image;
import javafx.stage.FileChooser;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.authlibinjector.AuthlibInjectorAccount;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.task.Schedulers;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 外观：皮肤衣柜、披风（含正版账号的披风）、3D 预览、头像。
///
/// <p>从 {@link WebBridge} 拆出来的最大一块，1600 多行。它自成一套状态——
/// 草稿、纹理绑定、预览视角、缩略图缓存——和实例 / 下载那些没有交集，只有
/// 「推 JS / 弹提示」和 `WebUIPage` 的预览画布要外部给。
///
/// <p>正版账号的皮肤披风是异步到手的，所以这里挂了一堆 `ObservableValue` 绑定；
/// 绑定不放字段会被 GC，异步结果就回不来，改动时注意别把字段收进局部变量。
@NotNullByDefault
public final class AppearanceApi {

    private final BridgeHost host;

    private final AppearanceStore appearance = AppearanceStore.getInstance();

    /// 预览画布 / 相机 / 缩略图都在这里，它不知道账号和素材状态
    private final SkinPreview preview;

    /// 头像（账号卡 / 账号列表）
    private final AvatarApi avatars;

    AppearanceApi(BridgeHost host, @Nullable WebUIPage page) {
        this.host = host;
        this.preview = new SkinPreview(host, page, this::refreshPreview);
        this.avatars = new AvatarApi(host, this::selectedAccountId, () -> accountSkinCache);
    }

    /// 壳模式下提供离屏预览画布（JavaFX 模式传 null）
    void setOffscreenPreview(@Nullable OffscreenPreview preview) {
        this.preview.setOffscreenPreview(preview);
    }

    /// 衣柜图渲染器
    void setSkinGallery(@Nullable SkinGallery gallery) {
        this.preview.setSkinGallery(gallery);
    }

    /// 头像查询（账号列表用）
    AvatarApi avatars() {
        return avatars;
    }

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

    /// 用户点了「刷新」：这一次不吃 24 小时缓存，一定要问服务器
    private volatile boolean forceTextureRefresh;
    /// 正在刷新，防连点
    private volatile boolean textureRefreshing;

    /// 各账号的头像缓存（accountID -> 皮肤原图）。
    /// 账号列表里每个账号都要一张，不能只缓存当前选中的那个。
    private final Map<String, Image> accountHeads = new ConcurrentHashMap<>();
    private final Set<String> accountHeadsLoading = ConcurrentHashMap.newKeySet();
    /// 头像绑定也要持有，否则异步结果回不来
    private final Map<String, ObservableValue<TexturesLoader.LoadedTexture>> headBindings = new ConcurrentHashMap<>();
    private final Map<String, Image> serverCapeImages = new ConcurrentHashMap<>();

    /// 本次运行里已经静默拉过服务器纹理的账号。
    ///
    /// 用户要的是「首次登录缓存、之后每次启动静默拉一次」。所以不再按 24 小时
    /// 节流，而是每轮运行每个账号拉一次：切账号再切回来不重复请求，
    /// 重启又会重新对一次 —— 官网换了皮肤，下次开启动器就能看到。
    private final Set<String> texturesPulledThisRun = ConcurrentHashMap.newKeySet();

    /// 各账号上次拉到的披风列表（accountID -> JSON 原文）。
    ///
    /// 前端切标签、切账号都会调 requestServerCapes，每调一次就打一次
    /// /minecraft/profile 太浪费；手里有这份就直接推回去，只有「刷新」才重拉。
    /// 按账号分开存：A → B → A 导来导去的时候不用把 A 的列表再要一遍。
    private final Map<String, String> serverCapesJson = new ConcurrentHashMap<>();
    /// 正在拉披风列表的账号，防并发重复请求
    private final Set<String> serverCapesPulling = ConcurrentHashMap.newKeySet();

    private String pendingServerCape;

    // ==================== 状态快照 ====================

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
        // 带上账号 id：前端靠它判断「换人了」，好把上一个账号的
        // 服务器披风列表丢掉。不带的话从 A 切到 B 会先闪一下 A 的披风。
        Account currentAccount = Accounts.getSelectedAccount();
        root.addProperty("accountId", currentAccount == null ? "" : currentAccount.getAccountID().toString());
        root.addProperty("accountName", account != null ? WebBridge.displayName(account) : "");
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
                ? ImageCodec.toDataUrlExact(accountSkinCache) : null);
        root.addProperty("accountCape", accountCapeCache != null
                ? AppearanceThumbnails.capeFront(accountCapeCache) : null);
        // 原图。壳模式的 3D 是前端 skinview3d 画的，要的是展开图不是拼好的缩略图;
        // 正版账号的披风不在本地资产列表里，没有这一项就完全渲染不出来。
        root.addProperty("accountCapeRaw", accountCapeCache != null
                ? ImageCodec.toDataUrlExact(accountCapeCache) : null);
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
        String url = preview.skinFront(image, slim);
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
                        ? preview.thumbnail(asset, texture)
                        : AppearanceThumbnails.capeFront(texture));
                // 原图（64×64 / 64×32 展开图）。前端 skinview3d 要的是这个，
                // 不是上面那张拼好的小人——3D 模型自己会按 UV 去切。
                item.addProperty("raw", ImageCodec.toDataUrlExact(texture));
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

    // ==================== 预览画布 ====================

    /// 兼容旧调用：现在预览以图片形式交给页面，位置完全由 CSS 决定
    public void setPreviewRect(double x, double y, double width, double height) {
        preview.requestRepaint();
    }

    public void hidePreview() {
        // 图片跟随页面，不需要额外隐藏
    }

    /// 外观页的待机摆动靠「定期重绘一张预览图」实现，定时器在 SkinPreview 里。
    public void setPreviewActive(boolean active) {
        preview.setPreviewActive(active);
    }

    /// 当前外观页停留的标签页。皮肤页看正面，披风页自动转到背面 3/4。
    public void setAppearanceTab(String tab) {
        preview.setTab(tab);
        refreshPreview();
    }

    /// 复位预览机位：让 refreshPreview 重新按当前标签页算默认角度。
    public void resetPreviewCamera() {
        preview.resetPreviewCamera();
        refreshPreview();
    }

    public void rotatePreview(double deltaX, double deltaY) {
        preview.rotatePreview(deltaX, deltaY);
        refreshPreview();
    }

    // ==================== 导入素材 ====================

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
            host.toast("导入皮肤失败：" + e.getMessage());
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
            host.toast("导入披风失败：" + e.getMessage());
        }
    }

    // —— 壳模式的 dataUrl 导入（页面里 <input type="file"> 读出来的） ——

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
    /// 导入图片。先按尺寸认出是皮肤还是披风，再查库里有没有同一张图。
    ///
    /// <p>「已经导入过」和「刚导进来」必须给不同的话：`importSkin` / `importCape`
    /// 内部本来就按内容哈希去重，但它们只返回那个已存在的资产，调用方分不出是新的
    /// 还是旧的，于是界面上一律说「已导入」—— 用户重复选同一个文件时，会以为自己
    /// 又多了一张。
    private void importTextureData(String dataUrl, String fileName, String preferred) {
        java.nio.file.Path temp = null;
        try {
            temp = writeDataUrl(dataUrl, preferred);
            if (temp == null) {
                host.toast("没有读到图片数据");
                return;
            }
            String kind = classifyTexture(temp);
            if ("unknown".equals(kind)) {
                // 认不出尺寸（比如远超 2 倍的高清图）就按调用方所在的标签页处理
                kind = preferred;
            }
            boolean isCape = "cape".equals(kind);
            AppearanceStore.Kind storeKind = isCape
                    ? AppearanceStore.Kind.CAPE : AppearanceStore.Kind.SKIN;
            String name = cleanName(fileName);
            // 提示语里用原始文件名（带扩展名）：用户刚选完文件，认的是这个名字
            String shown = fileName == null || fileName.isBlank() ? null : fileName.trim();

            // 库里已经有同一张图（按内容哈希）：不重复入库，直接切过去
            AppearanceStore.Asset existing = appearance.findExisting(storeKind, temp);
            if (existing != null) {
                if (isCape) {
                    AppearanceStore.State state = stateOfSelectedAccount();
                    state.cape = existing.getId();
                    appearance.saveState(selectedAccountId(), state);
                } else {
                    AppearanceStore.State state = draft();
                    state.skin = existing.getId();
                    adoptModelIfUnset(state, existing);
                }
                pushAppearance();
                refreshPreview();
                host.toast("这张图已经在库里了：「" + existing.name + "」，已直接切换");
                return;
            }

            if (isCape) {
                AppearanceStore.Asset asset = appearance.importCape(temp, null, name);
                AppearanceStore.State state = stateOfSelectedAccount();
                state.cape = asset.getId();
                appearance.saveState(selectedAccountId(), state);
                pushAppearance();
                refreshPreview();
                host.toast("当前导入图片已识别为 披风「"
                        + (shown != null ? shown : asset.name) + "」");
            } else {
                AppearanceStore.Asset asset = appearance.importSkin(temp, name);
                AppearanceStore.State state = draft();
                state.skin = asset.getId();
                adoptModelIfUnset(state, asset);
                pushAppearance();
                refreshPreview();
                host.toast("当前导入图片已识别为 皮肤「"
                        + (shown != null ? shown : asset.name) + "」");
            }
        } catch (Exception e) {
            LOG.warning("Failed to import texture", e);
            host.toast("导入失败：" + e.getMessage());
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
                host.toast("没有读到图片数据");
                return;
            }
            AppearanceStore.Asset asset = appearance.importSkin(temp, cleanName(fileName));
            AppearanceStore.State state = draft();
            state.skin = asset.getId();
            adoptModelIfUnset(state, asset);
            pushAppearance();
            refreshPreview();
            host.toast("已导入皮肤「" + asset.name + "」");
        } catch (Exception e) {
            LOG.warning("Failed to import skin data", e);
            host.toast("导入皮肤失败：" + e.getMessage());
        } finally {
            deleteQuietly(temp);
        }
    }

    /// 同上，披风
    public void importCapeData(String dataUrl, String fileName) {
        importTextureData(dataUrl, fileName, "cape");
    }

    /// 22x17 的裸披风补成标准 64x32。
    ///
    /// 有些皮肤站导出的披风是裁掉留白的 22x17：入库没问题，但 skinview3d 是按
    /// 64x32 的 UV 采样的，直接丢进去贴图会错位（看着像披风上印了乱码）。
    /// 这里补一张 64x32 的画布把原图贴到左上角 —— 那正好是披风 UV 的原点。
    ///
    /// @return 归一化后的临时文件；本来就是标准尺寸时返回 `null`（调用方直接用原图）
    private static @Nullable Path normalizeCape(Path file) {
        try {
            java.awt.image.BufferedImage img = javax.imageio.ImageIO.read(file.toFile());
            if (img == null || img.getWidth() != 22 || img.getHeight() != 17) {
                return null;
            }
            java.awt.image.BufferedImage canvas =
                    new java.awt.image.BufferedImage(64, 32, java.awt.image.BufferedImage.TYPE_INT_ARGB);
            java.awt.Graphics2D g = canvas.createGraphics();
            g.drawImage(img, 0, 0, null);
            g.dispose();
            Path temp = Files.createTempFile("hmcl-cape-", ".png");
            javax.imageio.ImageIO.write(canvas, "png", temp.toFile());
            return temp;
        } catch (Throwable e) {
            LOG.warning("Cannot normalize cape " + file, e);
            return null;
        }
    }

    /// 把一张图写进库（皮肤或披风），调用方负责清理自己的临时文件。
    // ==================== 拖拽批量导入 ====================

    /// 拖拽进来的多个文件批量导入。
    ///
    /// 前端给的是**文件路径**（Tauri 的 drag-drop 事件带路径，不是 File 对象），
    /// 所以这里直接读盘，不用像文件选择器那样绕 dataUrl。
    ///
    /// 每张图先按内容判定是皮肤还是披风再入库，认不出的跳过 —— 用户拖一个文件夹进来
    /// 也可能夹着 readme，不该整批失败。只拖了一张时顺手选中它，多张只入库，
    /// 让用户自己挑（自动选中最后一张会让人以为只导入了那一张）。
    ///
    /// @return `{"ok":true,"skins":2,"capes":1,"existing":0,"skipped":1}`
    public String importTextures(String pathsJson) {
        JsonArray paths;
        try {
            paths = JsonParser.parseString(pathsJson).getAsJsonArray();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"文件列表格式不对\"}";
        }
        if (paths.isEmpty()) {
            return "{\"ok\":false,\"error\":\"没有收到文件\"}";
        }

        boolean single = paths.size() == 1;
        int skins = 0;
        int capes = 0;
        int existing = 0;
        int skipped = 0;

        for (JsonElement element : paths) {
            String raw = element.getAsString();
            if (raw == null || raw.isBlank()) {
                skipped++;
                continue;
            }
            Path file;
            try {
                file = Path.of(raw);
            } catch (RuntimeException e) {
                skipped++;
                continue;
            }
            if (!Files.isRegularFile(file)) {
                skipped++;
                continue;
            }
            String kind = classifyTexture(file);
            if ("unknown".equals(kind)) {
                skipped++;
                continue;
            }
            try {
                if ("cape".equals(kind)) {
                    boolean isNew = appearance.findExisting(AppearanceStore.Kind.CAPE, file) == null;
                    Path normalized = normalizeCape(file);
                    Path capeSource = normalized != null ? normalized : file;
                    AppearanceStore.Asset asset;
                    try {
                        asset = appearance.importCape(capeSource, null, stripExtension(file.getFileName().toString()));
                    } finally {
                        if (normalized != null) {
                            try { Files.deleteIfExists(normalized); } catch (Throwable ignored) { }
                        }
                    }
                    if (isNew) {
                        capes++;
                    } else {
                        existing++;
                    }
                    if (single) {
                        AppearanceStore.State state = stateOfSelectedAccount();
                        state.cape = asset.getId();
                        appearance.saveState(selectedAccountId(), state);
                    }
                } else {
                    boolean isNew = appearance.findExisting(AppearanceStore.Kind.SKIN, file) == null;
                    AppearanceStore.Asset asset = appearance.importSkin(file, stripExtension(file.getFileName().toString()));
                    if (isNew) {
                        skins++;
                    } else {
                        existing++;
                    }
                    if (single) {
                        AppearanceStore.State state = draft();
                        state.skin = asset.getId();
                        adoptModelIfUnset(state, asset);
                    }
                }
            } catch (Exception e) {
                LOG.warning("Failed to import dropped texture " + file, e);
                skipped++;
            }
        }

        pushAppearance();
        refreshPreview();

        JsonObject result = new JsonObject();
        result.addProperty("ok", true);
        result.addProperty("skins", skins);
        result.addProperty("capes", capes);
        result.addProperty("existing", existing);
        result.addProperty("skipped", skipped);
        return result.toString();
    }

    /// 去掉扩展名。文件名做显示名时带 `.png` 很吵，列表里一列全是后缀。
    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    // ==================== 导出 ====================

    /// 把库里的皮肤 / 披风原始纹理导出到下载目录。
    ///
    /// 不做重编码：导出的就是当初导入的那份字节，来回导几次也不会越压越小。
    ///
    /// 不走 `FileChooser`：壳模式下 JavaFX 不出窗口，保存对话框根本弹不出来
    /// （导入那边为此改成了前端读 dataUrl）。所以固定落到系统下载目录，
    /// 文件名带资产名，重名自动加序号，导出完用 toast 把完整路径报给用户。
    public void exportTexture(String kind, String id) {
        if (id == null || id.isBlank()) {
            host.toast("这张是账号在服务器上的纹理，本地没有文件可导出");
            return;
        }
        boolean cape = "cape".equalsIgnoreCase(kind);
        AppearanceStore.Kind storeKind = cape ? AppearanceStore.Kind.CAPE : AppearanceStore.Kind.SKIN;
        AppearanceStore.Asset asset = appearance.find(storeKind, id);
        if (asset == null) {
            host.toast("找不到这张纹理，刷新一下再试");
            return;
        }
        Path source = appearance.fileOf(storeKind, id);
        if (!Files.isRegularFile(source)) {
            host.toast("纹理文件不见了：" + source.getFileName());
            return;
        }
        try {
            Path dir = downloadDir();
            Files.createDirectories(dir);
            String base = safeFileName(asset.name);
            if (base.isBlank()) {
                base = cape ? "cape" : "skin";
            }
            Path target = uniqueTarget(dir, base, ".png");
            Files.copy(source, target);
            host.toast("已导出到 " + target);
            LOG.info("[appearance] exported " + source + " -> " + target);
        } catch (Exception e) {
            LOG.warning("Failed to export texture", e);
            host.toast("导出失败：" + e.getMessage());
        }
    }

    /// 导出前端手里的纹理（正版账号的服务器皮肤 / 披风）。
    ///
    /// 这类图本地没有落盘：它是登录时从 Mojang 拉下来、以 dataUrl 形式挂在页面上的。
    /// 所以先落临时文件再复制到下载目录，走和 {@link #exportTexture} 一样的落点。
    public void exportTextureData(String dataUrl, String fileName) {
        Path temp = null;
        try {
            temp = writeDataUrl(dataUrl, "export");
            if (temp == null) {
                host.toast("没有读到图片数据");
                return;
            }
            Path dir = downloadDir();
            Files.createDirectories(dir);
            String base = safeFileName(fileName);
            if (base.isBlank()) {
                base = "minecraft-texture";
            }
            Path target = uniqueTarget(dir, base, ".png");
            Files.copy(temp, target);
            host.toast("已导出到 " + target);
            LOG.info("[appearance] exported account texture -> " + target);
        } catch (Exception e) {
            LOG.warning("Failed to export texture data", e);
            host.toast("导出失败：" + e.getMessage());
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    /// 导出正版账号在服务器上的一件披风。
    ///
    /// 这类图不在本地资产库里：它是登录后从 Mojang 的 textures 域名拉下来的，
    /// 界面上那张是拼好的正面缩略图（几十像素高），拿去当「纹理」导出没意义。
    /// 已加载过的直接用内存里那份原图（在列表里滚过就一定有了），
    /// 没加载过就按账号里的 url 拉一次。
    public void exportServerCape(String capeId) {
        if (capeId == null || capeId.isBlank()) {
            host.toast("没有指定要导出哪件披风");
            return;
        }

        Image cached = serverCapeImages.get(capeId);
        if (cached != null) {
            writeTextureImage(cached, capeId);
            return;
        }

        Account selected = Accounts.getSelectedAccount();
        if (!(selected instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount account)) {
            host.toast("只有正版账号才有服务器披风");
            return;
        }

        Task.runAsync(() -> {
            try {
                for (var cape : account.getCapes()) {
                    if (!capeId.equals(cape.id)) {
                        continue;
                    }
                    Image image = new Image(cape.url, false);
                    if (image.isError()) {
                        throw new IOException("下载披风失败");
                    }
                    serverCapeImages.put(cape.id, image);
                    writeTextureImage(image, cape.alias != null ? cape.alias : cape.id);
                    return;
                }
                host.toast("账号里没有这件披风，点「刷新账号披风」再试");
            } catch (Exception e) {
                LOG.warning("Failed to export server cape " + capeId, e);
                host.toast("导出失败：" + e.getMessage());
            }
        });
    }

    /// 把一张内存里的图写成 PNG 落到下载目录。
    private void writeTextureImage(Image image, String name) {
        try {
            String dataUrl = ImageCodec.toDataUrlExact(image);
            if (dataUrl == null) {
                host.toast("这张图读不出来");
                return;
            }
            Path dir = downloadDir();
            Files.createDirectories(dir);
            String base = safeFileName(name);
            if (base.isBlank()) {
                base = "cape";
            }
            Path target = uniqueTarget(dir, base, ".png");
            Files.write(target, Base64.getDecoder().decode(dataUrl.substring(dataUrl.indexOf(',') + 1)));
            host.toast("已导出到 " + target);
            LOG.info("[appearance] exported server texture -> " + target);
        } catch (Exception e) {
            LOG.warning("Failed to write texture image", e);
            host.toast("导出失败：" + e.getMessage());
        }
    }

    /// 系统的下载目录。取不到就退回家目录 —— 总比写到工作目录里让用户找不着强。
    private static Path downloadDir() {
        String home = System.getProperty("user.home", "");
        if (!home.isBlank()) {
            Path downloads = Path.of(home, "Downloads");
            if (Files.isDirectory(downloads)) {
                return downloads;
            }
        }
        return Path.of(home.isBlank() ? "." : home);
    }

    /// 文件名里不能出现的字符换成下划线。资产名是用户起的，什么都可能有。
    private static String safeFileName(String name) {
        if (name == null) {
            return "";
        }
        return name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    /// 重名就加 -1、-2 …，不覆盖用户已有的文件。
    private static Path uniqueTarget(Path dir, String base, String ext) {
        Path target = dir.resolve(base + ext);
        int n = 1;
        while (Files.exists(target)) {
            target = dir.resolve(base + "-" + n + ext);
            n++;
        }
        return target;
    }

    private void importCapeDataLegacy(String dataUrl, String fileName) {
        Path temp = null;
        try {
            temp = writeDataUrl(dataUrl, "cape");
            if (temp == null) {
                host.toast("没有读到图片数据");
                return;
            }
            AppearanceStore.Asset asset = appearance.importCape(temp, null, cleanName(fileName));
            AppearanceStore.State state = stateOfSelectedAccount();
            state.cape = asset.getId();
            appearance.saveState(selectedAccountId(), state);
            pushAppearance();
            refreshPreview();
            host.toast("已导入披风「" + asset.name + "」");
        } catch (Exception e) {
            LOG.warning("Failed to import cape data", e);
            host.toast("导入披风失败：" + e.getMessage());
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

    // ==================== 素材的选择 / 改名 / 删除 ====================

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
        host.pushState();
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
        host.pushState();
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

    // ==================== 正版账号的披风（服务端下发） ====================

    /// 拉取正版账号拥有的披风列表（异步推给前端）。
    ///
    /// <p>启动时就会调一次：3D 预览要穿当前那件、披风页要列全，不能等用户
    /// 点进「披风」标签才发请求。
    public void requestServerCapes() {
        requestServerCapes(false);
    }

    /// 缓存命中时补推披风缩略图。
    ///
    /// `serverCapesJson` 刻意不存图：每张 raw 都是几十 KB 的 data URL，
    /// 塞进 JSON 等于每次切标签都多传几百 KB。代价就是命中缓存时得从
    /// `serverCapeImages` 现生成一遍补上去，纯内存操作，不打网络。
    private void pushCachedCapePreviews(String cachedJson) {
        try {
            JsonArray array = JsonUtils.GSON.fromJson(cachedJson, JsonArray.class);
            if (array == null) { return; }
            for (JsonElement element : array) {
                if (!element.isJsonObject()) { continue; }
                JsonObject cape = element.getAsJsonObject();
                if (!cape.has("id")) { continue; }
                String id = cape.get("id").getAsString();
                Image image = serverCapeImages.get(id);
                if (image == null) { continue; }
                String preview = AppearanceThumbnails.capeFront(image);
                if (preview == null) { continue; }
                String raw = ImageCodec.toDataUrlExact(image);
                Platform.runLater(() -> host.execute(
                        "window.__hmcl && window.__hmcl.onCapePreview("
                                + JsonUtils.GSON.toJson(id) + ","
                                + JsonUtils.GSON.toJson(preview) + ","
                                + JsonUtils.GSON.toJson(raw) + ")"));
            }
        } catch (Exception e) {
            // 补图失败不影响列表本身，用户可以点「刷新」重来
            LOG.warning("Failed to replay cached cape previews", e);
        }
    }

    /// @param force true 表示「刷新」：忽略手里那份，重新问服务器
    private void requestServerCapes(boolean force) {
        Account selected = Accounts.getSelectedAccount();
        if (!(selected instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount microsoftAccount)) {
            return;
        }
        String accountId = selected.getAccountID().toString();

        // 这个账号的列表已经在手里：直接推回去，不打网络。
        // 切标签、切账号都会走到这里，每次都请求一次 /minecraft/profile 纯属浪费。
        String cachedJson = serverCapesJson.get(accountId);
        if (!force && cachedJson != null) {
            Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onServerCapes("
                    + JsonUtils.GSON.toJson(cachedJson) + ")"));
            // 列表缓存里只有 id / name / url / active，没有图。
            // 内存里还留着纹理的话顺手补推一遍，否则前端拿到的是一排没有
            // preview 的卡片 —— 界面上就是整片紫块，而且永远不会自己好。
            pushCachedCapePreviews(cachedJson);
            return;
        }
        if (!serverCapesPulling.add(accountId)) {
            return;   // 上一轮还在路上，别叠
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

                    // 这张图已经在内存里就别再拉一遍。切标签、点刷新都会走到这里，
                    // 每张披风都重新读盘 + 解码一遍纯属浪费 —— 6 张图能白等半秒。
                    Image known = serverCapeImages.get(cape.id);
                    if (known != null) {
                        String preview = AppearanceThumbnails.capeFront(known);
                        String raw = ImageCodec.toDataUrlExact(known);
                        if (preview != null) {
                            Platform.runLater(() -> host.execute(
                                    "window.__hmcl && window.__hmcl.onCapePreview("
                                            + JsonUtils.GSON.toJson(cape.id) + ","
                                            + JsonUtils.GSON.toJson(preview) + ","
                                            + JsonUtils.GSON.toJson(raw) + ")"));
                        }
                        continue;
                    }

                    if (cape.url != null) {
                        TexturesLoader.loadRemoteTexture(cape.url)
                                .thenAccept(image -> {
                                    if (image != null) {
                                        serverCapeImages.put(cape.id, image);
                                        // 这件正好是账号当前穿的：顺手把账号纹理缓存也更新掉。
                                        // TexturesLoader 那边有 24 小时节流，用户在官网换了披风，
                                        // 它还会拿旧的那件（症状：装备紫心却显示 Aurora）。
                                        if (cape.isActive()) {
                                            accountCapeCache = image;
                                            Platform.runLater(() -> {
                                                pushAppearance();
                                                refreshPreview();
                                            });
                                        }
                                        // 卡片上的平面缩略图是异步到手的，单独推一条增量，
                                        // 免得为了张图把整个列表重建一遍
                                        String preview = AppearanceThumbnails.capeFront(image);
                                        // 同时给展开图：缩略图只能贴在卡上，3D 渲染要的是原始纹理
                                        String raw = ImageCodec.toDataUrlExact(image);
                                        if (preview != null) {
                                            Platform.runLater(() -> host.execute(
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
                // 拉失败不缓存：下次进披风页或切标签会再试一次，
                // 总比把空列表记成「这个账号没披风」强
                serverCapesPulling.remove(accountId);
                return;
            }
            String json = JsonUtils.GSON.toJson(array);
            LOG.info("[appearance] 拉到 " + array.size() + " 件披风（账号 " + accountId + "）");
            // 存一份：前端再来要（切标签 / 切账号回来）直接给这个，不再打网络
            serverCapesJson.put(accountId, json);
            serverCapesPulling.remove(accountId);
            Platform.runLater(() -> host.execute("window.__hmcl && window.__hmcl.onServerCapes(" + JsonUtils.GSON.toJson(json) + ")"));

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
                        host.pushState();
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
        // 预览图先从列表内存里取：那张图前端已经拿去做缩略图了，
        // 等下一轮 push 再换会出现「点了切换，模型上什么都没有」的空窗
        Image picked = serverCapeImages.get(pendingServerCape);
        if (picked != null) {
            accountCapeCache = picked;
        }
        pushAppearance();
        // 账号头像取自当前皮肤，不重新推一次状态要等下一次状态变更才刷新
        host.pushState();
        refreshPreview();
    }

    // ==================== 账号状态与草稿 ====================

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

        // 画布、相机、截图都在 SkinPreview 里；这里只管「画什么」
        preview.paint(skin, slim, cape);
    }

    // ==================== 纹理绑定 ====================

    /// 给「当前选中账号」挂上皮肤 / 披风纹理绑定。
    ///
    /// 正版账号的皮肤和披风都写在 textures 属性里，要等 profile 拉到之后才有值；
    /// 绑定是异步的，所以这里只负责挂上监听，结果回来时再刷新界面。
    /// 账号没变就直接返回，push() 会频繁调用，重复挂监听会把回调叠成好几份。
    void attachAccountTextures(@Nullable Account account) {
        attachAccountTextures(account, false);
    }

    /// @param keepCache 刷新时用：保留手上这张图继续显示，新图到了再换。
    ///                  不保留的话刷新期间头像会退回默认皮肤，看着像「登录掉了」。
    void attachAccountTextures(@Nullable Account account, boolean keepCache) {
        String id = account == null ? "none" : account.getAccountID().toString();
        if (!keepCache && id.equals(accountTexturesId)) {
            return;
        }
        accountTexturesId = id;
        if (!keepCache) {
            // 换账号先清空上一份，否则新账号会先闪一下旧账号的皮肤
            accountSkinCache = null;
            accountCapeCache = null;
            accountSkinSlim = false;
        }
        accountSkinBinding = null;
        accountCapeBinding = null;

        if (account == null) {
            return;
        }

        AccountTextureCache textureCache = AccountTextureCache.getInstance();

        // 先读本地缓存。Mojang 那边要走 profile → textures → PNG 两次往返，
        // 这段时间里界面已经有东西可显示，头像不会退回兜底皮肤。
        AccountTextureCache.Cached cached = textureCache.load(id);
        if (cached != null && cached.skin() != null) {
            accountSkinCache = cached.skin();
            accountSkinSlim = cached.slim();
            accountCapeCache = cached.cape();
        }

        // 缓存先顶上（上面已经读进来了，界面不会空白），后台再静默对一次。
        //
        // 原来这里是「24 小时内拉过就用缓存」：省两次网络往返，代价是官网换了皮肤、
        // 隔一小时开启动器还是旧样子，只能右键手动刷新。现在改成每轮运行给每个账号
        // 拉一次 —— 没变化不推界面（onAccountTextures 里比 MD5），有变化才换。
        boolean forced = forceTextureRefresh;
        forceTextureRefresh = false;
        if (!forced && !texturesPulledThisRun.add(id)) {
            LOG.info("[appearance] " + id + " 这轮已经拉过服务器纹理了");
            // 纹理不用重拉，但列表还是要推一次 —— 切账号切回来时前端得重新拿到
            requestServerCapes();
            return;
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

        // 顺手把披风列表也拉一次。
        //
        // 以前只有用户点进「披风」标签才发这个请求，所以刚启动时 3D 里
        // 只有贴图、没有列表，披风页还要转一会儿圈。现在启动就拉：
        // 列表和每件的展开图一起进内存，披风页打开即见，3D 也能立刻穿对那件。
        requestServerCapes();
    }

    /// 手动刷新当前正版账号的服务器皮肤。
    ///
    /// <p>24 小时节流是为了省网络，但官网换了皮肤总得有个立刻生效的入口 ——
    /// 就是皮肤栏那张「账号当前皮肤」卡片的右键菜单。
    public void refreshAccountSkin() {
        refreshAccountTextures("皮肤");
    }

    /// 手动刷新当前正版账号的披风**列表**。披风库任意一张卡片的右键菜单走这里。
    ///
    /// 注意这和「刷新皮肤」不是一回事：皮肤刷新重拉的是贴图，披风这里重拉的是
    /// **账号持有哪些披风**。Mojang 那边新发一件（活动送的、买的），profile 里
    /// 的 capes 数组才会变，本地不清缓存就永远只显示旧的几件。
    public void refreshAccountCape() {
        Account account = Accounts.getSelectedAccount();
        if (account == null) {
            host.toast("先登录一个账号");
            return;
        }
        if (!(account instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount)) {
            host.toast("只有正版账号的披风存在服务器上");
            return;
        }
        if (textureRefreshing) {
            host.toast("正在刷新，稍等一下");
            return;
        }
        textureRefreshing = true;

        forceTextureRefresh = true;
        // 已经下过的披风贴图也清掉：Mojang 的披风 URL 是固定的，
        // 内容换了 URL 不变，不清就还是旧图
        serverCapeImages.clear();
        // 手里那份列表同样作废，下面强制重新问服务器
        serverCapesJson.clear();
        try {
            // profile 里带着 capes 数组，不清这个 getCapes() 拿的还是老列表
            account.clearCache();
        } catch (Exception e) {
            LOG.warning("Failed to clear account cache before refreshing capes", e);
        }

        requestServerCapes(true);
        host.toast("正在刷新账号披风…");

        // 兜底：网络挂了也别让状态一直卡在「刷新中」
        javafx.animation.PauseTransition timeout =
                new javafx.animation.PauseTransition(javafx.util.Duration.seconds(15));
        timeout.setOnFinished(e -> textureRefreshing = false);
        timeout.play();
    }

    private void refreshAccountTextures(String what) {
        Account account = Accounts.getSelectedAccount();
        if (account == null) {
            host.toast("先登录一个账号");
            return;
        }
        if (!(account instanceof org.jackhuang.hmcl.auth.microsoft.MicrosoftAccount)) {
            host.toast("只有正版账号的" + what + "存在服务器上");
            return;
        }
        if (textureRefreshing) {
            host.toast("正在刷新，稍等一下");
            return;
        }
        textureRefreshing = true;

        String id = account.getAccountID().toString();
        AccountTextureCache.getInstance().forget(id);
        forceTextureRefresh = true;
        try {
            // 清掉账号内部缓存的 profile，否则拿回来的还是旧纹理
            account.clearCache();
        } catch (Exception e) {
            LOG.warning("Failed to clear account cache before refresh", e);
        }
        // keepCache=true：手上这张先留着，新图到了再换
        attachAccountTextures(account, true);
        host.toast("正在刷新服务器" + what + "…");

        // 兜底：网络挂了也别让按钮一直卡在「刷新中」
        javafx.animation.PauseTransition timeout =
                new javafx.animation.PauseTransition(javafx.util.Duration.seconds(15));
        timeout.setOnFinished(e -> textureRefreshing = false);
        timeout.play();
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
            // 刚上传完，必须绕过 24 小时节流去问服务器 —— 不然这里会被
            // 「缓存还新鲜」挡住，界面上看起来就是「点了应用没反应」
            forceTextureRefresh = true;
            if (account != null) {
                AccountTextureCache.getInstance().forget(account.getAccountID().toString());
            }
            attachAccountTextures(account);
            pushAppearance();
            host.pushState();
            refreshPreview();
            // 披风列表的 active 位来自 /minecraft/profile，和 textures 是两份数据，
            // 换了披风之后要单独重拉一次，否则「已装备」标记还停在旧的那件上。
            // 必须 force：手里那份是换之前的，直接返回等于没刷新
            requestServerCapes(true);
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
        // 无论成没成，这次刷新都算结束了
        textureRefreshing = false;

        if (skin != null && skin.image() != null) {
            boolean hadBefore = accountSkinCache != null;
            accountSkinCache = skin.image();
            accountSkinSlim = "slim".equals(skin.metadata().get("model"));
            // 写缓存时按 MD5 比对：内容和磁盘上一模一样就什么都不做（静默忽略），
            // 不一样才重写——这一步同时覆盖了「首次登录」和「用户换了皮肤」。
            // 返回值是「真的变了」，没变就别推界面，免得每次启动都闪一次重绘。
            boolean stored = cache.storeSkin(accountId, accountSkinCache, accountSkinSlim);
            // 内容没变时 storeSkin 直接返回 false、时间戳也不会更新，
            // 所以这里补一次 touch：「刚从服务器确认过」这件事本身也要记下来，
            // 不然 24 小时后又白拉一遍
            cache.touch(accountId);
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
        host.pushState();
        refreshPreview();
    }

    // ==================== 应用 / 推送 ====================

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
            host.toast("已保存到离线账号");
            pushAppearance();
            host.pushState();
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
                    host.toast("应用失败：" + Accounts.localizeErrorMessage(exception));
                } else {
                    host.toast("已应用到正版账号");
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

        host.toast("外置认证账号请前往对应平台修改外观");
    }

    private void pushAppearance() {
        host.execute("window.__hmcl && window.__hmcl.onAppearance(" + JsonUtils.GSON.toJson(appearance()) + ")");
    }

    /// 启动前把衣柜里存的皮肤重新套到离线账号上。
    ///
    /// 离线账号的皮肤只存在内存里（），重启启动器就没了；
    /// 而离线皮肤的注入依赖这个字段——没有它，authlib-injector 拿不到纹理，
    /// 游戏就会按玩家名去官方拉皮肤（于是显示成同名正版玩家的皮肤）。
    /// 这里每次启动前从 AppearanceStore 重新读一遍，成本就是读一个 JSON。
    void reapplyOfflineSkin() {
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


}
