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

import javafx.application.Platform;
import javafx.scene.image.Image;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/// 皮肤预览画布：3D 渲染、相机角度、截图、衣柜缩略图。
///
/// <p>它**不知道**账号和素材状态——`AppearanceApi` 算好「用哪张皮肤、有没有披风」
/// 再传进来。这样待机摆动、标签页切换、拖动旋转这些纯视图逻辑可以单独改，
/// 不用在一个 1600 行的类里翻。
@NotNullByDefault
final class SkinPreview {

    private final BridgeHost host;
    private final @Nullable WebUIPage page;
    /// 外观内容变了要重算「画什么」，这条回调指回 AppearanceApi
    private final Runnable onRepaint;

    /// 壳模式的离屏预览画布；JavaFX 模式为 null（用 {@link WebUIPage} 自带的那块）
    private volatile @Nullable OffscreenPreview offscreen;

    /// 衣柜图渲染器（正 + 背）。三个皮肤就是六次 3D 渲染，按素材 id 缓存住
    private volatile @Nullable SkinGallery skinGallery;
    private final Map<String, String> skins = new ConcurrentHashMap<>();

    /// 待机摆动的定时重绘（只有外观页在屏幕上时才跑）
    private javafx.animation.Timeline idle;

    private double yaw = 180;
    private boolean yawTouched;
    /// 当前外观页停留的标签页。皮肤页看正面，披风页自动转到背面 3/4
    private String tab = "skin";

    SkinPreview(BridgeHost host, @Nullable WebUIPage page, Runnable onRepaint) {
        this.host = host;
        this.page = page;
        this.onRepaint = onRepaint;
    }

    void setOffscreenPreview(@Nullable OffscreenPreview preview) {
        this.offscreen = preview;
    }

    void setSkinGallery(@Nullable SkinGallery gallery) {
        this.skinGallery = gallery;
    }

    /// 让 AppearanceApi 重算一帧（位置 / 可见性变化时用）
    void requestRepaint() {
        Platform.runLater(onRepaint);
    }

    /// 单张皮肤的正面图（账号卡片用）：优先 3D 衣柜渲染，拿不到退回平面切片
    String skinFront(Image image, boolean slim) {
        SkinGallery gallery = skinGallery;
        String url = gallery == null ? null : gallery.render(image, slim);
        return url != null ? url : AppearanceThumbnails.skinFront(image, slim);
    }

    void setPreviewActive(boolean active) {
        Platform.runLater(() -> {
            if (!active) {
                if (idle != null) {
                    idle.stop();
                }
                return;
            }
            if (idle == null) {
                idle = new javafx.animation.Timeline(
                        new javafx.animation.KeyFrame(javafx.util.Duration.millis(500),
                                event -> onRepaint.run()));
                idle.setCycleCount(javafx.animation.Animation.INDEFINITE);
            }
            if (idle.getStatus() != javafx.animation.Animation.Status.RUNNING) {
                idle.play();
            }
        });
    }

    /// 当前外观页停留的标签页。皮肤页看正面，披风页自动转到背面 3/4，
    /// 否则打开披风列表却看不到背上的东西。
    void setTab(String tab) {
        this.tab = "cape".equals(tab) ? "cape" : "skin";
        // 换标签页时把用户手动转过的角度清掉，回到该标签页的推荐视角
        this.yawTouched = false;
        Platform.runLater(onRepaint);
    }

    /// 复位预览机位：把「用户手动转过」的标记清掉，让下次绘制重新按
    /// 当前标签页算默认角度（皮肤看正面、披风转到背面 3/4）。
    ///
    /// 不直接把 yaw 写死某个值 —— 那个默认值是跟着标签页和有没有披风变的，
    /// 写死会让披风标签复位后变成看正面，什么都看不见。
    void resetPreviewCamera() {
        yawTouched = false;
        onRepaint.run();
    }

    /// 拖动预览旋转视角（水平）
    void rotatePreview(double deltaX, double deltaY) {
        yawTouched = true;
        yaw = ((yaw + deltaX * 0.45) % 360 + 360) % 360;
        onRepaint.run();
    }

    /// 皮肤卡缩略图：优先用 3D 衣柜图（正+背），拿不到再退回旧的平面切片
    String thumbnail(AppearanceStore.Asset asset, Image texture) {
        String key = asset.getId() + "|" + asset.getModel();
        String cached = skins.get(key);
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
            skins.put(key, url);
        }
        return url;
    }

    /// 画一帧并把 dataURL 推给页面。没有画布时静默返回。
    void paint(Image skin, boolean slim, @Nullable Image cape) {
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
        if (!yawTouched) {
            boolean wantBack = cape != null && "cape".equals(tab);
            yaw = wantBack ? 326 : 180;
        }
        // 标定用：-Dhmcl.web.yaw=210 强制指定视角，方便一次性出多角度对照图
        String forcedYaw = System.getProperty("hmcl.web.yaw");
        if (forcedYaw != null && !forcedYaw.isBlank()) {
            try {
                yaw = Double.parseDouble(forcedYaw.trim());
            } catch (NumberFormatException ignored) {
            }
        }
        canvas.setYaw(yaw);
        canvas.setSwayEnabled(true);

        String dataUrl = page != null
                ? page.snapshotPreview()
                : (offscreen != null ? offscreen.snapshot() : null);
        if (dataUrl != null) {
            host.execute("window.__hmcl && window.__hmcl.onPreview(" + JsonUtils.GSON.toJson(dataUrl) + ")");
        }
    }
}
