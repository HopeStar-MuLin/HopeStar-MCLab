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
import javafx.scene.image.PixelReader;
import javafx.scene.paint.Material;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.shape.MeshView;
import javafx.scene.shape.TriangleMesh;
import javafx.scene.transform.Rotate;
import org.jackhuang.hmcl.ui.FXUtils;

/**
 * 鞘翅模型，按原版 {@code net.minecraft.client.model.object.equipment.ElytraModel} 复刻。
 *
 * <p>原版参数（从 {@code 26.3.jar} 里的 class 反编译得到，1.9 以来没变过）：
 * <pre>
 * CubeDeformation grow = new CubeDeformation(1.0F);
 * root.addOrReplaceChild("left_wing",
 *     CubeListBuilder.create().texOffs(22, 0)
 *         .addBox(-10, 0, 0, 10, 20, 2, grow),
 *     PartPose.offsetAndRotation(5, 0, 0, 0.2617994F, 0, -0.2617994F));
 * root.addOrReplaceChild("right_wing",
 *     CubeListBuilder.create().texOffs(22, 0).mirror()
 *         .addBox(0, 0, 0, 10, 20, 2, grow),
 *     PartPose.offsetAndRotation(-5, 0, 0, 0.2617994F, 0, 0.2617994F));
 * </pre>
 *
 * <p>由此有四条容易搞错的事实：
 * <ol>
 *   <li><b>几何是 12×22×4</b>：`addBox` 给的是 10×20×2，但 {@code CubeDeformation(1.0)}
 *       会把每个面再向外撑 1，所以实际渲染的方块是 12×22×4。skinview3d 用
 *       {@code BoxGeometry(12,22,4)} 就是这个原因。</li>
 *   <li><b>UV 仍然按 10×20×2 排</b>：贴图布局用的是扩大之前的尺寸，起点 {@code (22,0)}，
 *       整块占 24×22 像素。几何和 UV 尺寸是两套数字，不能混用。</li>
 *   <li><b>两片翅膀都横跨整个背部</b>：左翼挂在 x=+5、方块从 x=-10 到 0；右翼挂在 x=-5、
 *       方块从 0 到 10。两者在中间重叠，靠 ±15° 的 z 轴旋转拉开夹角。</li>
 *   <li><b>翼形来自贴图的 alpha</b>，不是几何。方块画出来是个 12×22 的板子，
 *       只有贴图里画了东西的地方才看得见。所以自带鞘翅图的披风能正确出翼形，
 *       而没有鞘翅图的披风必须回退到官方 elytra.png —— 把披风图案硬铺上去只会得到一块板砖。</li>
 * </ol>
 */
public final class ElytraModel extends Group {

    /// 原版 addBox 的尺寸
    private static final float BOX_W = 10f;
    private static final float BOX_H = 20f;
    private static final float BOX_D = 2f;
    /// CubeDeformation(1.0)：每面各撑 1，最终 12×22×4
    private static final float GROW = 1f;

    private static final float GEO_W = BOX_W + GROW * 2;
    private static final float GEO_H = BOX_H + GROW * 2;
    private static final float GEO_D = BOX_D + GROW * 2;

    /// 原版静止姿态：x 轴前倾 15°，z 轴外张 ∓15°
    private static final double POSE_X = 0.2617994;
    private static final double POSE_Z = 0.2617994;

    /// 贴图起点（原版 texOffs(22, 0)）
    private static final float TEX_U = 22f;
    private static final float TEX_V = 0f;

    private final MeshView leftWing;
    private final MeshView rightWing;

    /// 基础姿态的 z 轴旋转，待机摆动在这个 Rotate 上叠加。
    ///
    /// 符号和原版相反：原版写的是 left.zRot = -15°、right.zRot = +15°，
    /// 但 Minecraft 的模型空间 y 轴朝上，JavaFX 的 y 轴朝下，绕 Z 的正方向正好反转。
    /// 照抄原版符号会让两片翅膀朝身体内侧交叉，看起来像一块斜着糊上去的布。
    private final Rotate leftSway = new Rotate(Math.toDegrees(POSE_Z), Rotate.Z_AXIS);
    private final Rotate rightSway = new Rotate(-Math.toDegrees(POSE_Z), Rotate.Z_AXIS);

    public ElytraModel() {
        leftWing = createWing(false);
        rightWing = createWing(true);

        // 左翼：挂在 x=+5，方块（中心相对挂点 -10）横跨 -11..+1
        Group left = new Group(leftWing);
        left.setTranslateX(5);
        left.getTransforms().addAll(new Rotate(Math.toDegrees(POSE_X), Rotate.X_AXIS), leftSway);

        // 右翼：挂在 x=-5，方块镜像后横跨 -1..+11
        Group right = new Group(rightWing);
        right.setTranslateX(-5);
        right.getTransforms().addAll(new Rotate(Math.toDegrees(POSE_X), Rotate.X_AXIS), rightSway);

        getChildren().setAll(left, right);
        setVisible(false);
    }

    /**
     * 生成一片翅膀。
     *
     * @param mirror true 为右翼（原版 {@code CubeListBuilder.mirror()}）
     */
    private static MeshView createWing(boolean mirror) {
        TriangleMesh mesh = createWingMesh(mirror);
        MeshView view = new MeshView(mesh);
        if (mirror) {
            // 原版 mirror() 同时镜像几何与贴图；JavaFX 里直接对节点做 x 轴镜像即可。
            // 网格已经把每个面正反各生成一份，所以翻转后两面照样可见。
            view.setScaleX(-1);
            view.setTranslateX(BOX_W);
        } else {
            view.setTranslateX(-BOX_W);
        }
        // 方块中心比挂点低半个身位（原版 box 从 y=0 挂到 y=20）
        view.setTranslateY(BOX_H / 2);
        view.setTranslateZ(BOX_D / 2);
        return view;
    }

    /**
     * 建立 12×22×4 的盒子，但贴图坐标按 10×20×2 排。
     *
     * <p>顶点与面表沿用 {@link SkinCube} 的写法（这套面表在本项目里已经验证过），
     * 只把几何尺寸与 UV 尺寸拆成两组参数。
     */
    private static TriangleMesh createWingMesh(boolean mirror) {
        float gw = GEO_W / 2, gh = GEO_H / 2, gd = GEO_D / 2;

        float[] points = {
                -gw, -gh, +gd, // P0
                +gw, -gh, +gd, // P1
                -gw, +gh, +gd, // P2
                +gw, +gh, +gd, // P3
                -gw, -gh, -gd, // P4
                +gw, -gh, -gd, // P5
                -gw, +gh, -gd, // P6
                +gw, +gh, -gd  // P7
        };

        // UV 用未扩大的尺寸算：占位总宽 = 2*(10+2) = 24 像素，总高 = 20+2 = 22 像素。
        // 注意所有坐标最后都要除以纹理尺寸（64 / 32）归一化，
        // 只按 24×22 的比例算出来的数字不是 texCoord（踩过一次：翅膀只采到一条窄缝）。
        float totalW = (BOX_W + BOX_D) * 2;   // 24 px
        float totalH = BOX_H + BOX_D;         // 22 px
        float scaleX = totalW / 64f;          // 24/64
        float scaleY = totalH / 32f;          // 22/32
        float halfWidth = BOX_W / totalW * scaleX;
        float halfDepth = BOX_D / totalW * scaleX;
        float topX = TEX_U / 64f + halfDepth;
        float topY = TEX_V / 32f;
        float bottomX = TEX_U / 64f;
        float middleY = TEX_V / 32f + BOX_D / 32f;
        float bottomY = TEX_V / 32f + scaleY;
        float uvW = scaleX;

        float[] texCoords = {
                topX, topY,                                    // T0
                topX + halfWidth, topY,                        // T1
                topX + halfWidth * 2, topY,                    // T2
                bottomX, middleY,                              // T3
                bottomX + halfDepth, middleY,                  // T4
                bottomX + halfDepth + halfWidth, middleY,      // T5
                bottomX + uvW - halfWidth, middleY,            // T6
                bottomX + uvW, middleY,                        // T7
                bottomX, bottomY,                              // T8
                bottomX + halfDepth, bottomY,                  // T9
                bottomX + halfDepth + halfWidth, bottomY,      // T10
                bottomX + uvW - halfWidth, bottomY,            // T11
                bottomX + uvW, bottomY                         // T12
        };

        int[] faces = {
                // TOP
                5, 0, 4, 1, 0, 5,
                5, 0, 0, 5, 1, 4,
                // RIGHT
                5, 3, 1, 4, 3, 9,
                5, 3, 3, 9, 7, 8,
                // FRONT
                1, 4, 0, 5, 2, 10,
                1, 4, 2, 10, 3, 9,
                // LEFT
                0, 5, 4, 6, 6, 11,
                0, 5, 6, 11, 2, 10,
                // BACK
                4, 6, 5, 7, 7, 12,
                4, 6, 7, 12, 6, 11,
                // BOTTOM
                3, 5, 2, 6, 6, 2,
                3, 5, 6, 2, 7, 1
        };

        TriangleMesh mesh = new TriangleMesh();
        mesh.getPoints().addAll(points);
        mesh.getTexCoords().addAll(texCoords);
        mesh.getFaces().addAll(faces);

        // 与 SkinCube 相同：把整份面表反向再生成一遍，正反两面都能看到图案。
        // 鞘翅厚度只有 4 像素，单面渲染转到侧面就会破洞。
        int[] reversed = faces.clone();
        for (int i = 0, mid = reversed.length >> 1, j = reversed.length - 1; i < mid; i++, j--) {
            int tmp = reversed[i];
            reversed[i] = reversed[j];
            reversed[j] = tmp;
        }
        for (int i = 0; i < reversed.length; i += 2) {
            int tmp = reversed[i];
            reversed[i] = reversed[i + 1];
            reversed[i + 1] = tmp;
        }
        int[] all = new int[faces.length + reversed.length];
        System.arraycopy(faces, 0, all, 0, faces.length);
        System.arraycopy(reversed, 0, all, faces.length, reversed.length);
        mesh.getFaces().setAll(all);

        return mesh;
    }

    public void setMaterial(Material material) {
        leftWing.setMaterial(material);
        rightWing.setMaterial(material);
    }

    /// 套用贴图。调用方负责保证这张图里确实有鞘翅图案（见 {@link #hasElytraArt}）。
    public void setTexture(Image texture) {
        PhongMaterial material = new PhongMaterial();
        material.setDiffuseMap(texture);
        setMaterial(material);
    }

    /**
     * 判断一张 64×32 的披风贴图里是否画了鞘翅。
     *
     * <p>原版只画「背面」这一面（朝外那面），对应 UV 的 {@code (36,2)} 起 10×20 的矩形；
     * 正面是贴着身体的那面，原版留空。所以采样必须采背面——
     * 采正面的话，连官方披风都会被判成「没有鞘翅」。
     */
    public static boolean hasElytraArt(Image texture) {
        if (texture == null) {
            return false;
        }
        PixelReader reader = texture.getPixelReader();
        if (reader == null) {
            return false;
        }
        // (36,2) 10×20，单位是 64×32 逻辑像素
        return opaqueRatio(reader, texture, 36, 2, 10, 20) > 0.05;
    }

    private static double opaqueRatio(PixelReader reader, Image texture, int u, int v, int w, int h) {
        double scaleX = texture.getWidth() / 64.0;
        double scaleY = texture.getHeight() / 32.0;
        int x0 = Math.max(0, (int) Math.round(u * scaleX));
        int y0 = Math.max(0, (int) Math.round(v * scaleY));
        int x1 = Math.min((int) texture.getWidth(), (int) Math.round((u + w) * scaleX));
        int y1 = Math.min((int) texture.getHeight(), (int) Math.round((v + h) * scaleY));

        int total = 0, opaque = 0;
        int step = Math.max(1, (int) Math.round(scaleX / 2));
        for (int y = y0; y < y1; y += step) {
            for (int x = x0; x < x1; x += step) {
                total++;
                if ((reader.getArgb(x, y) >>> 24) > 16) {
                    opaque++;
                }
            }
        }
        return total == 0 ? 0 : (double) opaque / total;
    }

    /**
     * 待机微摆。
     *
     * @param phase 相位（弧度），由调用方按时间推进
     */
    public void setSway(double phase) {
        // 两片翅膀一个相位差，避免完全同步显得机械
        leftSway.setAngle(Math.toDegrees(POSE_Z) + Math.sin(phase) * 1.2);
        rightSway.setAngle(-Math.toDegrees(POSE_Z) + Math.sin(phase + 0.35) * 1.2);
    }

    private static Image defaultElytra;

    /// 官方鞘翅贴图。
    ///
    /// <p>从游戏 jar 里原样提取：{@code assets/minecraft/textures/entity/equipment/wings/elytra.png}，
    /// 64×32。没有自带鞘翅图案的披风一律回退到这张，渲染出来就是游戏里默认的鞘翅外观。
    public static synchronized Image getDefaultElytraImage() {
        if (defaultElytra == null) {
            try {
                defaultElytra = FXUtils.newBuiltinImage("/assets/img/elytra/elytra.png");
            } catch (Exception e) {
                // 资源缺失就返回 null，调用方退化成不显示背饰，不至于崩掉整个预览
            }
        }
        return defaultElytra;
    }
}
