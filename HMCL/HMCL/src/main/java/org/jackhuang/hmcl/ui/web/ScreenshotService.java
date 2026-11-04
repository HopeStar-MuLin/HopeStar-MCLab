/*
 * HopeStar-MCLab
 *
 * 实例截图：列表（带缩略图）、打开、重命名、删除、复制到剪贴板。
 */
package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.FileUtils;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 截图目录（`screenshots/`）的读写与缩略图生成。
///
/// <p>截图是 PNG，一张动辄 1–2 MB，直接把原图塞进 data URL 会让列表卡死，
/// 所以列表只给 360px 宽的 JPEG 缩略图；双击打开走系统默认程序，用的是原图。
final class ScreenshotService {

    /// 缩略图宽度。卡片按 3~4 列排，360 够清晰又不会太大。
    private static final int THUMB_WIDTH = 360;

    static String list(HMCLGameInstance instance) {
        JsonObject root = new JsonObject();
        JsonArray items = new JsonArray();
        Path dir = instance.getRunDirectory().resolve("screenshots");
        root.addProperty("dir", dir.toString());

        List<Path> files = new ArrayList<>();
        if (Files.isDirectory(dir)) {
            try (Stream<Path> paths = Files.list(dir)) {
                paths.filter(Files::isRegularFile)
                        .filter(p -> {
                            String name = p.getFileName().toString().toLowerCase();
                            return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg");
                        })
                        .forEach(files::add);
            } catch (IOException e) {
                root.addProperty("error", "读取截图目录失败：" + e.getMessage());
                return JsonUtils.GSON.toJson(root);
            }
        }

        // 新的在前：截图目录里文件名带时间戳，改时间排序更稳
        files.sort(Comparator.comparingLong((Path p) -> p.toFile().lastModified()).reversed());
        for (Path file : files) {
            JsonObject item = new JsonObject();
            item.addProperty("file", file.getFileName().toString());
            try {
                item.addProperty("size", Files.size(file));
                item.addProperty("time", file.toFile().lastModified());
            } catch (IOException ignored) {
                item.addProperty("size", 0);
                item.addProperty("time", 0L);
            }
            String thumb = thumbnail(file);
            if (thumb != null) {
                item.addProperty("thumb", thumb);
            }
            items.add(item);
        }
        root.add("items", items);
        return JsonUtils.GSON.toJson(root);
    }

    /// 生成 360px 宽的 JPEG 缩略图（data URL）。失败返回 null，前端退回占位图。
    private static String thumbnail(Path file) {
        try {
            BufferedImage source = ImageIO.read(file.toFile());
            if (source == null) {
                return null;
            }
            int width = Math.min(THUMB_WIDTH, source.getWidth());
            int height = (int) Math.round(source.getHeight() * (width / (double) source.getWidth()));
            BufferedImage scaled = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics = scaled.createGraphics();
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.drawImage(source, 0, 0, width, height, null);
            graphics.dispose();

            ByteArrayOutputStream out = new ByteArrayOutputStream();
            ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
            try (ImageOutputStream stream = ImageIO.createImageOutputStream(out)) {
                writer.setOutput(stream);
                ImageWriteParam param = writer.getDefaultWriteParam();
                param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
                param.setCompressionQuality(0.82f);
                writer.write(null, new IIOImage(scaled, null, null), param);
            } finally {
                writer.dispose();
            }
            return "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(out.toByteArray());
        } catch (Throwable e) {
            return null;
        }
    }

    static String open(Path file) {
        try {
            java.awt.Desktop.getDesktop().open(file.toFile());
            return "{\"ok\":true}";
        } catch (Throwable e) {
            return error("打不开：" + e.getMessage());
        }
    }

    static String rename(Path file, String newName) {
        if (newName == null || newName.isBlank()) {
            return error("名字不能为空");
        }
        String trimmed = newName.trim();
        if (!trimmed.matches("[^\\\\/:*?\"<>|]+")) {
            return error("名字里不能有 \\ / : * ? \" < > |");
        }
        // 用户通常会连扩展名一起改；没写扩展名就沿用原来的
        if (!trimmed.contains(".")) {
            String name = file.getFileName().toString();
            int dot = name.lastIndexOf('.');
            if (dot > 0) {
                trimmed = trimmed + name.substring(dot);
            }
        }
        try {
            Files.move(file, file.resolveSibling(trimmed));
            return "{\"ok\":true,\"file\":\"" + escape(trimmed) + "\"}";
        } catch (Throwable e) {
            return error("重命名失败：" + e.getMessage());
        }
    }

    static String delete(Path file) {
        try {
            if (FileUtils.moveToTrash(file)) {
                return "{\"ok\":true}";
            }
            return error("系统回收站不可用，已取消删除");
        } catch (Throwable e) {
            return error("删除失败：" + e.getMessage());
        }
    }

    /// 复制到剪贴板：优先复制图片本身（可以直接粘到聊天窗口），
    /// 失败时退回复制文件路径。
    static String copy(Path file) {
        try {
            BufferedImage image = ImageIO.read(file.toFile());
            if (image != null) {
                java.awt.datatransfer.Transferable transferable =
                        new java.awt.datatransfer.Transferable() {
                            @Override
                            public java.awt.datatransfer.DataFlavor[] getTransferDataFlavors() {
                                return new java.awt.datatransfer.DataFlavor[]{
                                        java.awt.datatransfer.DataFlavor.imageFlavor};
                            }

                            @Override
                            public boolean isDataFlavorSupported(java.awt.datatransfer.DataFlavor flavor) {
                                return java.awt.datatransfer.DataFlavor.imageFlavor.equals(flavor);
                            }

                            @Override
                            public Object getTransferData(java.awt.datatransfer.DataFlavor flavor) {
                                return image;
                            }
                        };
                java.awt.Toolkit.getDefaultToolkit().getSystemClipboard().setContents(transferable, null);
                return "{\"ok\":true}";
            }
        } catch (Throwable e) {
            LOG.warning("Failed to copy screenshot as image", e);
        }
        return copyPath(file);
    }

    static String copyPath(Path file) {
        try {
            java.awt.datatransfer.StringSelection selection =
                    new java.awt.datatransfer.StringSelection(file.toAbsolutePath().toString());
            java.awt.Toolkit.getDefaultToolkit().getSystemClipboard().setContents(selection, null);
            return "{\"ok\":true}";
        } catch (Throwable e) {
            return error("复制失败：" + e.getMessage());
        }
    }

    private static String error(String message) {
        return "{\"error\":\"" + escape(message) + "\"}";
    }

    private static String escape(String text) {
        return text.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private ScreenshotService() {
    }
}
