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
package org.jackhuang.hmcl.ui.skin;

import javafx.scene.Group;
import javafx.scene.image.Image;
import javafx.scene.paint.Material;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.CullFace;
import javafx.scene.shape.MeshView;
import javafx.scene.shape.TriangleMesh;
import javafx.scene.transform.Rotate;
import javafx.scene.transform.Translate;

/**
 * 鞘翅模型。
 *
 * <p>Minecraft 里鞘翅贴图与披风同为 64×32，披风图案区域位于 {@code (1,1)-(11,17)}。
 * 玩家有披风时，游戏正是把披风贴图套到鞘翅上；所以这里只接受一张 64×32 的贴图，
 * 调用方决定传披风图还是独立的鞘翅图（见 {@code AppearanceStore} 的回退规则）。
 *
 * <p>几何：左右各一片弯曲的网格，向外张开 22°，从肩部向下垂，末端略向外翻。
 * 局部坐标以「块」为单位，1 格 = 1 个像素单位（与 {@link SkinCube} 的披风 10×16 一致）。
 */
public final class ElytraModel extends Group {

    /// 单片翅膀的宽度（格）
    private static final float WING_WIDTH = 5.0f;
    /// 单片翅膀的高度（格）
    private static final float WING_HEIGHT = 15.5f;
    /// 向外张开的弧度
    private static final double SPLAY_DEGREE = 22.0;

    private final MeshView leftWing;
    private final MeshView rightWing;

    public ElytraModel() {
        leftWing = createWing(true);
        rightWing = createWing(false);

        Group left = new Group(leftWing);
        left.getTransforms().add(new Rotate(-SPLAY_DEGREE, Rotate.Y_AXIS));
        left.getTransforms().add(new Translate(-0.4, 0, 0));

        Group right = new Group(rightWing);
        right.getTransforms().add(new Rotate(SPLAY_DEGREE, Rotate.Y_AXIS));
        right.getTransforms().add(new Translate(0.4, 0, 0));

        getChildren().setAll(left, right);
        setVisible(false);
    }

    public void setMaterial(Material material) {
        leftWing.setMaterial(material);
        rightWing.setMaterial(material);
    }

    public void setTexture(Image texture) {
        PhongMaterial material = new PhongMaterial();
        material.setDiffuseMap(texture);
        setMaterial(material);
    }

    /**
     * 生成一片翅膀。
     *
     * @param left true 为左翼（贴图取披风图案左半边并镜像），false 为右翼
     */
    private static MeshView createWing(boolean left) {
        final int cols = 4;
        final int rows = 6;

        TriangleMesh mesh = new TriangleMesh();
        // 顶点：网格点 (cols+1) * (rows+1)
        for (int j = 0; j <= rows; j++) {
            float v = (float) j / rows;
            for (int i = 0; i <= cols; i++) {
                float u = (float) i / cols;

                float x = left ? -u * WING_WIDTH : u * WING_WIDTH;
                float y = -v * WING_HEIGHT;
                // 沿高度方向向后弯，末端再稍微向外翻，避免看起来像一块平板
                float z = (float) (Math.sin(v * Math.PI * 0.55) * 1.6 + v * v * 0.8);

                mesh.getPoints().addAll(x, y, z);
            }
        }

        // 贴图坐标：披风图案区域 (1,1)-(11,17) / 64x32，左右各取一半
        final float uMin = 1f / 64f;
        final float uMid = 6f / 64f;
        final float uMax = 11f / 64f;
        final float vMin = 1f / 32f;
        final float vMax = 17f / 32f;

        for (int j = 0; j <= rows; j++) {
            float v = vMin + (vMax - vMin) * (float) j / rows;
            for (int i = 0; i <= cols; i++) {
                float t = (float) i / cols;
                // 左翼镜像，让两片翅膀的花纹从中间向外对称
                float u = left ? uMid - (uMid - uMin) * t : uMid + (uMax - uMid) * t;
                mesh.getTexCoords().addAll(u, v);
            }
        }

        // 面：每个方格两个三角形（逆时针，外侧朝 +z）
        for (int j = 0; j < rows; j++) {
            for (int i = 0; i < cols; i++) {
                int p00 = j * (cols + 1) + i;
                int p10 = p00 + 1;
                int p01 = p00 + (cols + 1);
                int p11 = p01 + 1;

                if (left) {
                    // 左翼镜像后绕序相反
                    mesh.getFaces().addAll(p00, p00, p11, p11, p10, p10);
                    mesh.getFaces().addAll(p00, p00, p01, p01, p11, p11);
                } else {
                    mesh.getFaces().addAll(p00, p00, p10, p10, p11, p11);
                    mesh.getFaces().addAll(p00, p00, p11, p11, p01, p01);
                }
            }
        }

        MeshView view = new MeshView(mesh);
        view.setCullFace(CullFace.NONE);
        return view;
    }
}
