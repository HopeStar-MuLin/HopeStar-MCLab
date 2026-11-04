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
import org.jetbrains.annotations.NotNullByDefault;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.Objects;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// JavaFX `Image` → `data:image/png;base64,...`。
///
/// <p>前端拿不到本地文件，图标 / 皮肤 / 截图一律走 dataUrl。两个变体：
/// `toDataUrl` 缩放到正方形（图标），`toDataUrlExact` 原样保留比例（预览图）。
@NotNullByDefault
final class ImageCodec {

    private ImageCodec() {
    }

    /// 原样编码，不缩放也不改比例。预览图是竖版（340×425），走 `toDataUrl`
    /// 会被压成正方形（那个方法是给 64×64 图标用的）。
    static String toDataUrlExact(Image image) {
        Objects.requireNonNull(image);
        int width = Math.max(1, (int) image.getWidth());
        int height = Math.max(1, (int) image.getHeight());

        BufferedImage buffered = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        if (reader != null) {
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    buffered.setRGB(x, y, reader.getArgb(x, y));
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
    /// 按比例缩到不超过 maxWidth × maxHeight，用于列表缩略图。
    ///
    /// <p>背景原图动辄 4K，一张 8MB 的图转成 dataUrl 是 11MB 文本；列表里十几张
    /// 就是上百 MB，页面直接卡死。缩略图只用于挑选，宽 320 足够看清是什么图。
    static String toDataUrlFit(Image image, int maxWidth, int maxHeight) {
        Objects.requireNonNull(image);
        int width = Math.max(1, (int) image.getWidth());
        int height = Math.max(1, (int) image.getHeight());

        double scale = Math.min(1.0, Math.min((double) maxWidth / width, (double) maxHeight / height));
        int w = Math.max(1, (int) Math.round(width * scale));
        int h = Math.max(1, (int) Math.round(height * scale));

        BufferedImage buffered = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        if (reader != null) {
            for (int y = 0; y < h; y++) {
                int sy = Math.min(height - 1, y * height / h);
                for (int x = 0; x < w; x++) {
                    int sx = Math.min(width - 1, x * width / w);
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

    static String toDataUrl(Image image, int size) {
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
