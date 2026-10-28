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

import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import org.jackhuang.hmcl.util.skin.NormalizedSkin;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;

/**
 * 把皮肤 / 披风贴图压成「平面正视图」缩略图，用于外观页的资产卡片。
 *
 * <p>官方账号管理页的披风列表就是直接展示披风正面（一块 10×16 的竖矩形），
 * 皮肤列表则是把头部、身体、四肢的正面拼成一个站立小人。之前这里直接把
 * 64×64 的展开贴图当缩略图，看起来是一张看不懂的色块图。
 *
 * <p>输出保持贴图原始像素尺寸（皮肤 16×32、披风 10×16），由前端用
 * {@code image-rendering: pixelated} 放大——这样 base64 很小，而且放大后边缘依旧是硬像素。
 */
public final class AppearanceThumbnails {

    private AppearanceThumbnails() {
    }

    /// 皮肤展开图的 UV 布局（64×64 标准），每项是 {x, y, w, h}
    private static final int[] HEAD_FRONT = {8, 8, 8, 8};
    private static final int[] BODY_FRONT = {20, 20, 8, 12};
    private static final int[] RIGHT_ARM_FRONT = {44, 20, 4, 12};
    private static final int[] LEFT_ARM_FRONT = {36, 52, 4, 12};
    private static final int[] RIGHT_LEG_FRONT = {4, 20, 4, 12};
    private static final int[] LEFT_LEG_FRONT = {20, 52, 4, 12};

    /**
     * 皮肤正视图。
     *
     * @param skin 原始皮肤贴图（64×32 / 64×64 / 任意倍数）
     * @param slim 是否纤体（手臂宽度 3 而不是 4）
     * @return PNG data URL；无法解析时返回 null
     */
    public static String skinFront(Image skin, boolean slim) {
        if (skin == null) {
            return null;
        }
        Image normalized;
        boolean slimModel = slim;
        try {
            NormalizedSkin n = new NormalizedSkin(skin);
            normalized = n.getNormalizedTexture();
            slimModel = n.isSlim();
        } catch (Exception e) {
            // 尺寸不合规就退回原图，至少不崩
            normalized = skin;
        }

        PixelReader reader = normalized.getPixelReader();
        if (reader == null) {
            return null;
        }
        int scale = Math.max(1, (int) Math.round(normalized.getWidth() / 64.0));

        BufferedImage out = new BufferedImage(16, 32, BufferedImage.TYPE_INT_ARGB);
        int armWidth = slimModel ? 3 : 4;

        // 头：居中放在 16 宽画布的 x=4..12
        blit(reader, out, scale, HEAD_FRONT, 4, 0, 8, 8);
        // 身体
        blit(reader, out, scale, BODY_FRONT, 4, 8, 8, 12);
        // 角色右手（观察者左侧）
        blit(reader, out, scale, RIGHT_ARM_FRONT, 4 - armWidth, 8, armWidth, 12);
        // 角色左手（观察者右侧）
        blit(reader, out, scale, LEFT_ARM_FRONT, 12, 8, armWidth, 12);
        // 双腿
        blit(reader, out, scale, RIGHT_LEG_FRONT, 4, 20, 4, 12);
        blit(reader, out, scale, LEFT_LEG_FRONT, 8, 20, 4, 12);

        return encode(out);
    }

    /**
     * 披风正视图：取贴图里披风本体的正面那块（64×32 空间的 (1,1) 起 10×16）。
     *
     * @return PNG data URL；无法解析时返回 null
     */
    public static String capeFront(Image cape) {
        if (cape == null) {
            return null;
        }
        PixelReader reader = cape.getPixelReader();
        if (reader == null) {
            return null;
        }

        // 披风贴图按 64×32 排版，(1,1) 起 10×16 是正面；高清披风按比例换算
        double scaleX = cape.getWidth() / 64.0;
        double scaleY = cape.getHeight() / 32.0;
        int sx = (int) Math.round(1 * scaleX);
        int sy = (int) Math.round(1 * scaleY);
        int sw = Math.max(1, (int) Math.round(10 * scaleX));
        int sh = Math.max(1, (int) Math.round(16 * scaleY));

        BufferedImage out = new BufferedImage(10, 16, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < 16; y++) {
            int py = sy + Math.min(sh - 1, y * sh / 16);
            for (int x = 0; x < 10; x++) {
                int px = sx + Math.min(sw - 1, x * sw / 10);
                if (px < 0 || py < 0 || px >= cape.getWidth() || py >= cape.getHeight()) {
                    continue;
                }
                out.setRGB(x, y, reader.getArgb(px, py));
            }
        }
        return encode(out);
    }

    /// 把贴图里的一个矩形按目标尺寸贴到画布上（最近邻，保持像素感）
    private static void blit(PixelReader reader, BufferedImage dst, int scale, int[] uv,
                             int dx, int dy, int dw, int dh) {
        int sx = uv[0] * scale, sy = uv[1] * scale;
        int sw = uv[2] * scale, sh = uv[3] * scale;
        for (int y = 0; y < dh; y++) {
            int py = sy + Math.min(sh - 1, y * sh / dh);
            for (int x = 0; x < dw; x++) {
                int px = sx + Math.min(sw - 1, x * sw / dw);
                dst.setRGB(dx + x, dy + y, reader.getArgb(px, py));
            }
        }
    }

    private static String encode(BufferedImage image) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(image, "png", out);
            return "data:image/png;base64," + Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (IOException e) {
            return null;
        }
    }
}
