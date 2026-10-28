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
import javafx.scene.transform.Rotate;

/**
 * 鞘翅模型。
 *
 * <p>几何照抄原版 {@code ModelElytra}（1.9 起未变）：左右各一片 <b>10×20×2 的实体方块</b>，
 * 贴图区在 64×32 纹理的 {@code (22,0)}，占 10×20 图案 + 2 像素厚度。
 *
 * <p>最早的实现把翅膀做成了零厚度的曲面片，结果只要不是正对镜头就只剩一条边——
 * 这是「看不到鞘翅」的真正原因，而不是角度问题。原版和 skinview3d 用的都是有厚度的方块，
 * 侧面自带明暗，转到任何角度都能看出形状。
 *
 * <p>贴图有两种取法，由 {@link WingTexture} 决定：
 * <ul>
 *   <li>{@link WingTexture#ELYTRA_REGION}：披风文件里带了独立鞘翅图，用 {@code (22,0)} 区域，正宗布局；</li>
 *   <li>{@link WingTexture#CAPE_REGION}：只有披风图，把披风图案区 {@code (0,0)-(22,22)} 铺到翅膀上。</li>
 * </ul>
 * 两套网格几何完全相同，只是 UV 起点不同，切换时改显隐即可，不重建网格。
 */
public final class ElytraModel extends Group {

    /// 贴图取值方式
    public enum WingTexture {
        /// 披风文件自带鞘翅图，按原版布局取 (22,0)
        ELYTRA_REGION,
        /// 没有鞘翅图，把披风图案铺到翅膀上
        CAPE_REGION
    }

    /// 单片翅膀尺寸，与原版 ModelElytra.addBox(-10, 0, 0, 10, 20, 2) 一致
    private static final float WING_WIDTH = 10f;
    private static final float WING_HEIGHT = 20f;
    private static final float WING_DEPTH = 2f;

    /// 向外张开的度数。原版静止姿态约 13°，张太开会像蝴蝶，太小会贴着背看不见。
    private static final double SPLAY_DEGREE = 15.0;
    /// 向后倾的度数，让翅膀离开背部一点，避免和身体穿插
    private static final double TILT_DEGREE = 11.0;
    /// 两片翅膀中缝留的空隙（格），太贴会 z-fighting
    private static final double CENTER_GAP = 0.4;

    /// 纹理归一化：宽 2*(10+2)=24，高 20+2=22
    private static final float UV_SCALE_X = 24F / 64F;
    private static final float UV_SCALE_Y = 22F / 32F;
    /// 原版鞘翅图案起点
    private static final float UV_ELYTRA_X = 22F / 64F;
    private static final float UV_CAPE_X = 0F;

    /// [0] 左翼，[1] 右翼；每片两份网格，对应两种 UV 取法
    private final Group[] wingGroups = new Group[2];
    private final SkinCube[][] wingMeshes = new SkinCube[2][2];

    private WingTexture currentMode = WingTexture.ELYTRA_REGION;

    /// 基础倾角，供待机摆动在它上面叠加
    private final Rotate[] swayX = {new Rotate(TILT_DEGREE, Rotate.X_AXIS), new Rotate(TILT_DEGREE, Rotate.X_AXIS)};

    public ElytraModel() {
        for (int side = 0; side < 2; side++) {
            boolean left = side == 0;
            Group group = new Group();

            // 网格默认以自身中心为原点；把内上角挪到组的原点，旋转才会绕着肩部转
            double meshX = left ? -WING_WIDTH / 2 : WING_WIDTH / 2;
            double meshY = WING_HEIGHT / 2;

            SkinCube elytraMesh = createWingMesh(UV_ELYTRA_X);
            SkinCube capeMesh = createWingMesh(UV_CAPE_X);
            for (SkinCube mesh : new SkinCube[]{elytraMesh, capeMesh}) {
                mesh.setTranslateX(meshX);
                mesh.setTranslateY(meshY);
                group.getChildren().add(mesh);
            }

            // 外张：左翼往 -x 张开，右翼镜像
            group.getTransforms().add(new Rotate(left ? SPLAY_DEGREE : -SPLAY_DEGREE, Rotate.Z_AXIS));
            group.getTransforms().add(swayX[side]);
            group.setTranslateX(left ? -CENTER_GAP : CENTER_GAP);

            wingMeshes[side][0] = capeMesh;
            wingMeshes[side][1] = elytraMesh;
            wingGroups[side] = group;
            getChildren().add(group);
        }

        applyTextureMode();
        setVisible(false);
    }

    private static SkinCube createWingMesh(float uvStartX) {
        // 不放大（enlarge = 0），与原版一致；SkinCube 内部会把面片正反各生成一份，
        // 所以翅膀两面都能看到图案，不需要额外处理 CullFace
        return new SkinCube(WING_WIDTH, WING_HEIGHT, WING_DEPTH,
                UV_SCALE_X, UV_SCALE_Y, uvStartX, 0F, 0F, false);
    }

    /**
     * 选择贴图取法。
     *
     * @param mode 披风文件是否自带鞘翅图
     */
    public void setWingTexture(WingTexture mode) {
        if (mode == null || mode == currentMode) {
            return;
        }
        currentMode = mode;
        applyTextureMode();
    }

    public WingTexture getWingTexture() {
        return currentMode;
    }

    private void applyTextureMode() {
        int index = currentMode == WingTexture.ELYTRA_REGION ? 1 : 0;
        for (int side = 0; side < 2; side++) {
            wingMeshes[side][0].setVisible(index == 0);
            wingMeshes[side][1].setVisible(index == 1);
        }
    }

    public void setMaterial(Material material) {
        for (SkinCube[] pair : wingMeshes) {
            for (SkinCube mesh : pair) {
                mesh.setMaterial(material);
            }
        }
    }

    public void setTexture(Image texture) {
        PhongMaterial material = new PhongMaterial();
        material.setDiffuseMap(texture);
        // 与身体保持同一套哑光设置，否则翅膀会比身体亮一截，看着像贴纸
        material.setSpecularColor(javafx.scene.paint.Color.gray(0.08));
        material.setSpecularPower(12);
        setMaterial(material);
    }

    /**
     * 待机微摆。
     *
     * <p>完全静止的翅膀看起来像塑料模型，给一个极小幅度的正弦摆动就自然得多。
     *
     * @param phase 相位（弧度），由调用方按时间推进
     */
    public void setSway(double phase) {
        for (int side = 0; side < 2; side++) {
            // 两片翅膀相位差一点点，避免完全同步显得机械
            double offset = side == 0 ? 0 : 0.35;
            swayX[side].setAngle(TILT_DEGREE + Math.sin(phase + offset) * 1.6);
        }
    }
}
