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
import javafx.scene.Scene;
import javafx.scene.SnapshotParameters;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.PixelWriter;
import javafx.scene.image.WritableImage;
import javafx.scene.layout.Pane;
import javafx.scene.paint.Color;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import org.jackhuang.hmcl.game.TexturesLoader;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;

/// 衣柜图：背面 + 正面并排，两个模型各向内偏一点，看着像在互相对视。
///
/// 布局参照 LittleSkin 的 `/preview/<id>?png`：左边那个背对镜头、右边那个正对，
/// 各自内旋约 20°，镜头略微俯视（能看到头顶）。
///
/// 为什么不摆两个 `SkinCanvas`：里面的手臂 `SkinCube` 是 **static** 的
/// （`STEVEN_LARM` / `ALEX_LARM`），JavaFX 一个 Node 只能有一个父节点，
/// 第二个实例拿来用会把节点从第一个那里抢走——结果就是只有左边那个有身体，
/// 右边一片空白。实测就是这样。
///
/// 改完 yaw 立刻 snapshot 是有效的：WebBridge 渲染外观页预览时也是
/// 「设 yaw → 截图」同一个调用栈走下来的，角度能正确反映。
final class SkinGallery {

    // 和外观页那块预览保持同一个宽高比（340:425），
    // 比例不一致时 3D 模型会被 SubScene 裁掉下半身。
    private static final int VIEW_W = 170;
    private static final int VIEW_H = 212;

    // 170 宽的画布里人物只占中间一段，左右裁掉一点，卡片里的小人才看得清
    private static final int CROP_X = 44;
    private static final int CROP_W = 82;

    private final SkinCanvas canvas;
    private final Pane box;
    private final Stage stage;

    SkinGallery() {
        canvas = new SkinCanvas(TexturesLoader.getDefaultSkinImage(), VIEW_W, VIEW_H, true);
        canvas.setManaged(false);
        canvas.setSwayEnabled(false);

        box = new Pane(canvas);
        // Scene 的根节点会吃到 Modena 的 `.root` 样式（-fx-background-color: #f4f4f4）。
        // 不显式清掉的话，截出来的图就是一层不透明的浅灰，
        // 暗色主题下卡片里会显出一块白板。
        box.setBackground(javafx.scene.layout.Background.EMPTY);
        box.setPrefSize(VIEW_W, VIEW_H);
        box.setMinSize(VIEW_W, VIEW_H);
        box.setMaxSize(VIEW_W, VIEW_H);
        box.resize(VIEW_W, VIEW_H);

        Scene scene = new Scene(box, VIEW_W, VIEW_H, Color.TRANSPARENT);
        stage = new Stage();
        // 3D 需要真实渲染表面：Scene 不挂 Window 时截出来是全透明
        stage.initStyle(StageStyle.UTILITY);
        stage.setScene(scene);
        stage.setWidth(VIEW_W);
        stage.setHeight(VIEW_H);
        stage.setX(-1000);
        stage.setY(-1000);
        stage.show();
    }

    /// 渲染成 dataUrl（背面 | 正面）。必须在 FX 线程调用。
    String render(Image skin, boolean slim) {
        if (skin == null) {
            return null;
        }
        try {
            canvas.updateSkin(skin, slim, null);
            // 角度取自 blessing-skin 的 renderSkin：两次水平旋转 -45° 和 135°（相差 180°），
            // 垂直方向再压 -25° 俯视。yaw 换算过来就是 225 / 45 这一对。
            Image front = shot(225);   // 正面偏 45°
            Image back = shot(45);     // 背面偏 45°
            // 正面在左、背面在右：先看到脸，翻过去的背影在右边收尾，比反过来自然
            return WebBridge.imageToDataUrlExact(combine(front, back));
        } catch (Exception e) {
            return null;
        }
    }

    private Image shot(double yaw) {
        canvas.setYaw(yaw);
        SnapshotParameters params = new SnapshotParameters();
        params.setFill(Color.TRANSPARENT);
        params.setViewport(new Rectangle2D(CROP_X, 0, CROP_W, VIEW_H));
        return box.snapshot(params, null);
    }

    private static Image combine(Image left, Image right) {
        int lw = (int) left.getWidth();
        int rw = (int) right.getWidth();
        int h = (int) Math.max(left.getHeight(), right.getHeight());
        WritableImage out = new WritableImage(lw + rw, h);
        PixelReader rl = left.getPixelReader();
        PixelReader rr = right.getPixelReader();
        PixelWriter pw = out.getPixelWriter();

        if (rl != null) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < lw; x++) {
                    pw.setArgb(x, y, rl.getArgb(x, y));
                }
            }
        }
        if (rr != null) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < rw; x++) {
                    pw.setArgb(lw + x, y, rr.getArgb(x, y));
                }
            }
        }
        return out;
    }

    void close() {
        stage.close();
    }
}
