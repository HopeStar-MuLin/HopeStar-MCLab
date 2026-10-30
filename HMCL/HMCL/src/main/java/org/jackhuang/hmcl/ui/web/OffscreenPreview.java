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

import javafx.geometry.Rectangle2D;
import javafx.scene.Group;
import javafx.scene.Scene;
import javafx.scene.SnapshotParameters;
import javafx.scene.image.Image;
import javafx.scene.paint.Color;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;

/// 壳模式（Tauri）下的皮肤预览画布。
///
/// JavaFX 模式下画布挂在 {@link WebUIPage} 的场景里，`snapshot()` 直接可用。
/// 壳模式没有那个场景，就得自己造一个。
///
/// 两个必须踩过的点：
/// 1. **只给 Scene 不够**。`SkinCanvas` 是带 `PerspectiveCamera` 的 3D Group，
///    3D 渲染需要真实渲染表面（RenderTarget），Scene 不挂 Window 时 snapshot
///    出来是全透明的空图（实测 726 字节的 PNG）。
///    所以还是配了一个 Stage：透明、移出可视区、UTILITY 样式（不占任务栏）。
/// 2. **snapshot 要显式给 viewport**。`SkinCanvas` 继承 Group，bounds 不等于预览框，
///    不指定 viewport 会按内容 bounds 出图（实测 340×340 而不是 340×425）。
final class OffscreenPreview {

    /// 和 WebUIPage 保持一致：竖版 340×425，前端按容器等比缩放
    static final double WIDTH = 340;
    static final double HEIGHT = 425;

    private final SkinCanvas canvas;
    private final javafx.scene.layout.Pane root;
    private final Scene scene;
    private final Stage stage;

    OffscreenPreview() {
        canvas = new SkinCanvas(TexturesLoader.getDefaultSkinImage(), WIDTH, HEIGHT, true);
        canvas.setManaged(false);
        canvas.enableRotation(0.6);

        // 用 Pane 当根并固定尺寸：SkinCanvas 是 Group，自己不带尺寸，
        // 直接 snapshot 它只能拿到内容的 bounds（340×340），不是预览框的大小。
        root = new javafx.scene.layout.Pane(canvas);
        // 同上：根节点带 `.root` 样式，不清掉会截出不透明的浅灰底
        root.setBackground(javafx.scene.layout.Background.EMPTY);
        root.setPrefSize(WIDTH, HEIGHT);
        root.setMinSize(WIDTH, HEIGHT);
        root.setMaxSize(WIDTH, HEIGHT);
        root.resize(WIDTH, HEIGHT);

        this.scene = new Scene(root, WIDTH, HEIGHT, Color.TRANSPARENT);

        stage = new Stage();
        // UTILITY 不带任务栏按钮；挪到屏幕外，用户看不到
        stage.initStyle(StageStyle.UTILITY);
        stage.setScene(scene);
        stage.setWidth(WIDTH);
        stage.setHeight(HEIGHT);
        stage.setX(-1000);
        stage.setY(-1000);
        // 不能用 setOpacity(0)：合成器会直接跳过不渲染，snapshot 拿到全透明空图。
        // 屏幕外坐标已经足够让它不可见。
        stage.show();
    }

    SkinCanvas canvas() {
        return canvas;
    }

    /// 渲染成 dataUrl。必须在 FX 线程调用。
    String snapshot() {
        try {
            SnapshotParameters params = new SnapshotParameters();
            // 默认白底，暗色主题下会糊一块白方块
            params.setFill(Color.TRANSPARENT);
            params.setViewport(new Rectangle2D(0, 0, WIDTH, HEIGHT));
            // 截 Pane 而不是 canvas：Pane 尺寸固定，输出才是 340×425
            Image image = root.snapshot(params, null);
            return WebBridge.imageToDataUrlExact(image);
        } catch (Exception e) {
            return null;
        }
    }

    void close() {
        stage.close();
    }
}
