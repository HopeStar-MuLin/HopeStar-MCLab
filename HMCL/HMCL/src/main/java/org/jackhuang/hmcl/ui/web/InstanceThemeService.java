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

import com.google.gson.JsonObject;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.setting.GameInstanceIconType;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 实例级主题：图标、游戏窗口标题、启动器外观（强调色 + 背景图）。
///
/// <p>存两处：
/// <ul>
///   <li>图标走 HMCL 自己的约定 —— `versions/<id>/icon.<ext>`，这样原生 UI 也能显示；</li>
///   <li>其余写在 `<实例>/.hmcl/theme.json`，背景图也放 `.hmcl/` 下。</li>
/// </ul>
///
/// <p>不塞进版本 json 或 `instance-game-settings.json`：那两个文件的上游格式会变，
/// 自定义字段容易在升级/保存时被覆盖。
final class InstanceThemeService {

    private static final String THEME_DIR = ".hmcl";
    private static final String THEME_FILE = "theme.json";
    private static final String BACKGROUND_STEM = "theme-bg";
    private static final String LAUNCHER_ICON_STEM = "launcher-icon";

    /// 背景图上限。转成 data URL 要塞进一次 HTTP 响应，太大前端会卡。
    private static final long MAX_BACKGROUND_BYTES = 12L * 1024 * 1024;

    private static final List<String> IMAGE_EXTENSIONS = List.of("png", "jpg", "jpeg", "webp", "bmp", "gif");

    private InstanceThemeService() {
    }

    /// 一份主题配置。字段都可能为空串。
    ///
    /// @param launcher      true = 这套主题连同启动器一起换（图标、标题、背景、主题色）；
    ///                      false = 只染实例页的顶部卡片
    /// @param launcherIcon  `.hmcl/launcher-icon.<ext>`，标题栏左上角那张图
    /// @param launcherTitle 标题栏显示的名字，空串表示用启动器自己的名字
    record Theme(String windowTitle, String accent, String background,
                 String launcherIcon, String launcherTitle, boolean launcher) {
        static final Theme EMPTY = new Theme("", "", "", "", "", false);
    }

    private static Path themeJson(HMCLGameInstance instance) {
        return instance.getInstanceRoot().resolve(THEME_DIR).resolve(THEME_FILE);
    }

    // ==================== 读写 ====================

    static Theme read(HMCLGameInstance instance) {
        Path file = themeJson(instance);
        if (!Files.isRegularFile(file)) {
            return Theme.EMPTY;
        }
        try {
            JsonObject json = JsonUtils.GSON.fromJson(Files.readString(file), JsonObject.class);
            if (json == null) {
                return Theme.EMPTY;
            }
            return new Theme(
                    str(json, "windowTitle"),
                    str(json, "accent"),
                    str(json, "background"),
                    str(json, "launcherIcon"),
                    str(json, "launcherTitle"),
                    json.has("launcher") && !json.get("launcher").isJsonNull()
                            && json.get("launcher").getAsBoolean());
        } catch (Throwable e) {
            LOG.warning("Failed to read instance theme " + file, e);
            return Theme.EMPTY;
        }
    }

    private static void write(HMCLGameInstance instance, Theme theme) throws IOException {
        JsonObject json = new JsonObject();
        json.addProperty("windowTitle", theme.windowTitle() == null ? "" : theme.windowTitle());
        json.addProperty("accent", theme.accent() == null ? "" : theme.accent());
        json.addProperty("background", theme.background() == null ? "" : theme.background());
        json.addProperty("launcherIcon", theme.launcherIcon() == null ? "" : theme.launcherIcon());
        json.addProperty("launcherTitle", theme.launcherTitle() == null ? "" : theme.launcherTitle());
        json.addProperty("launcher", theme.launcher());
        Path file = themeJson(instance);
        Files.createDirectories(file.getParent());
        Files.writeString(file, JsonUtils.GSON.toJson(json));
    }

    private static String str(JsonObject json, String key) {
        return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : "";
    }

    // ==================== 前端接口 ====================

    /// 主题面板的数据。背景图以文件名返回，真正加载走 `background` 的 data URL。
    static String load(String instanceId) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            Theme theme = read(instance);
            out.addProperty("ok", true);
            out.addProperty("instanceId", instanceId);
            out.addProperty("windowTitle", theme.windowTitle());
            out.addProperty("accent", theme.accent());
            out.addProperty("background", theme.background());
            out.addProperty("hasBackground", !theme.background().isBlank()
                    && Files.isRegularFile(backgroundFile(instance, theme.background())));
            out.addProperty("launcher", theme.launcher());
            out.addProperty("launcherIcon", theme.launcherIcon());
            out.addProperty("launcherTitle", theme.launcherTitle());
            out.addProperty("hasLauncherIcon", !theme.launcherIcon().isBlank()
                    && Files.isRegularFile(launcherIconFile(instance, theme.launcherIcon())));
            out.addProperty("launcherTitleDefault", "HopeStar-MCLab");
            out.addProperty("hasIcon", instance.getIconFile() != null);
            // 游戏默认标题，前端拿去当输入框的 placeholder
            out.addProperty("defaultTitle", "Minecraft " + instance.getVersion());
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        }
    }

    /// 保存标题、强调色和启动器段的文字配置（图标和背景图单独走 upload）。
    static String save(String instanceId, String windowTitle, String accent,
                       String launcherTitle, boolean launcher) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            String cleanAccent = accent == null ? "" : accent.trim();
            if (!cleanAccent.isEmpty() && !cleanAccent.matches("#[0-9a-fA-F]{6}")) {
                throw new IOException("颜色要写成 #RRGGBB");
            }
            Theme old = read(instance);
            write(instance, new Theme(
                    windowTitle == null ? "" : windowTitle.trim(),
                    cleanAccent.toLowerCase(Locale.ROOT),
                    old.background(),
                    old.launcherIcon(),
                    launcherTitle == null ? "" : launcherTitle.trim(),
                    launcher));
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        }
    }

    /// 换图标：拷成 `icon.<ext>`，顺手把「预设图标」重置成 DEFAULT，
    /// 否则用户之前选过草方块，上传的图会被预设盖掉。
    static String applyIcon(String instanceId, Path image) {
        JsonObject out = new JsonObject();
        Path temp = image;
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            String extension = extensionOf(image.getFileName().toString());
            if (!IMAGE_EXTENSIONS.contains(extension)) {
                throw new IOException("只支持 png / jpg / webp / bmp / gif");
            }
            try {
                instance.getSettings().iconProperty().setValue(GameInstanceIconType.DEFAULT);
            } catch (Throwable ignored) {
                // 拿不到设置不影响换图标
            }
            instance.setIconFile(temp);
            instance.invalidateIconImage();
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            LOG.warning("Failed to apply instance icon", e);
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        } finally {
            // 上传落地的是临时文件，复制完就能删
            deleteQuietly(temp);
        }
    }

    /// 恢复默认图标：删掉 `icon.*`，预设也回到 DEFAULT。
    static String resetIcon(String instanceId) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            try {
                instance.getSettings().iconProperty().setValue(GameInstanceIconType.DEFAULT);
            } catch (Throwable ignored) {
            }
            for (String extension : IMAGE_EXTENSIONS) {
                Files.deleteIfExists(instance.getInstanceRoot().resolve("icon." + extension));
            }
            instance.invalidateIconImage();
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        }
    }

    /// 换背景图：统一改名成 `theme-bg.<ext>` 放进 `.hmcl/`，旧的一张删掉。
    static String applyBackground(String instanceId, Path image) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            String extension = extensionOf(image.getFileName().toString());
            if (!IMAGE_EXTENSIONS.contains(extension)) {
                throw new IOException("只支持 png / jpg / webp / bmp / gif");
            }
            if (Files.size(image) > MAX_BACKGROUND_BYTES) {
                throw new IOException("背景图不能超过 12 MB");
            }
            Path dir = instance.getInstanceRoot().resolve(THEME_DIR);
            Files.createDirectories(dir);
            String name = BACKGROUND_STEM + "." + extension;
            Path target = dir.resolve(name);
            Files.copy(image, target, StandardCopyOption.REPLACE_EXISTING);
            // 换格式时旧文件会留下，清掉
            for (String other : IMAGE_EXTENSIONS) {
                if (!other.equals(extension)) {
                    Files.deleteIfExists(dir.resolve(BACKGROUND_STEM + "." + other));
                }
            }
            Theme old = read(instance);
            write(instance, new Theme(old.windowTitle(), old.accent(), name,
                    old.launcherIcon(), old.launcherTitle(), old.launcher()));
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            LOG.warning("Failed to apply instance background", e);
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        } finally {
            deleteQuietly(image);
        }
    }

    static String clearBackground(String instanceId) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            Path dir = instance.getInstanceRoot().resolve(THEME_DIR);
            for (String extension : IMAGE_EXTENSIONS) {
                Files.deleteIfExists(dir.resolve(BACKGROUND_STEM + "." + extension));
            }
            Theme old = read(instance);
            write(instance, new Theme(old.windowTitle(), old.accent(), "",
                    old.launcherIcon(), old.launcherTitle(), old.launcher()));
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        }
    }

    /// 背景图的 data URL。
    ///
    /// <p>WebView2 对指向 127.0.0.1 的 `<img src>` 会做 Private Network Access 检查，
    /// 和图标一样必须走 data URL（见 `buildAddonIcon` 的注释）。
    static String backgroundDataUrl(String instanceId) {
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                return "";
            }
            Theme theme = read(instance);
            if (theme.background().isBlank()) {
                return "";
            }
            Path file = backgroundFile(instance, theme.background());
            if (!Files.isRegularFile(file) || Files.size(file) > MAX_BACKGROUND_BYTES) {
                return "";
            }
            byte[] bytes = Files.readAllBytes(file);
            String mime = switch (extensionOf(file.getFileName().toString())) {
                case "png" -> "image/png";
                case "webp" -> "image/webp";
                case "bmp" -> "image/bmp";
                case "gif" -> "image/gif";
                default -> "image/jpeg";
            };
            return "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes);
        } catch (Throwable e) {
            LOG.warning("Failed to read instance background", e);
            return "";
        }
    }

    /// 启动时用：实例设了游戏窗口标题就返回，没有返回空串。
    static String windowTitleOf(String instanceId) {
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            return instance == null ? "" : read(instance).windowTitle();
        } catch (Throwable e) {
            return "";
        }
    }

    /// 启动器图标（标题栏左上角那张）。只影响界面，不动 exe / 系统图标。
    static String applyLauncherIcon(String instanceId, Path image) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            String extension = extensionOf(image.getFileName().toString());
            if (!IMAGE_EXTENSIONS.contains(extension)) {
                throw new IOException("只支持 png / jpg / webp / bmp / gif");
            }
            Path dir = instance.getInstanceRoot().resolve(THEME_DIR);
            Files.createDirectories(dir);
            String name = LAUNCHER_ICON_STEM + "." + extension;
            Files.copy(image, dir.resolve(name), StandardCopyOption.REPLACE_EXISTING);
            for (String other : IMAGE_EXTENSIONS) {
                if (!other.equals(extension)) {
                    Files.deleteIfExists(dir.resolve(LAUNCHER_ICON_STEM + "." + other));
                }
            }
            Theme old = read(instance);
            write(instance, new Theme(old.windowTitle(), old.accent(), old.background(),
                    name, old.launcherTitle(), old.launcher()));
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            LOG.warning("Failed to apply launcher icon", e);
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        } finally {
            deleteQuietly(image);
        }
    }

    static String clearLauncherIcon(String instanceId) {
        JsonObject out = new JsonObject();
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                throw new IOException("找不到这个实例");
            }
            Path dir = instance.getInstanceRoot().resolve(THEME_DIR);
            for (String extension : IMAGE_EXTENSIONS) {
                Files.deleteIfExists(dir.resolve(LAUNCHER_ICON_STEM + "." + extension));
            }
            Theme old = read(instance);
            write(instance, new Theme(old.windowTitle(), old.accent(), old.background(),
                    "", old.launcherTitle(), old.launcher()));
            out.addProperty("ok", true);
            return JsonUtils.GSON.toJson(out);
        } catch (Throwable e) {
            out.addProperty("ok", false);
            out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            return JsonUtils.GSON.toJson(out);
        }
    }

    /// 启动器图标的 data URL（没设返回空串）。
    static String launcherIconDataUrl(String instanceId) {
        try {
            HMCLGameInstance instance = instanceOf(instanceId);
            if (instance == null) {
                return "";
            }
            Theme theme = read(instance);
            if (theme.launcherIcon().isBlank()) {
                return "";
            }
            return dataUrlOf(launcherIconFile(instance, theme.launcherIcon()));
        } catch (Throwable e) {
            LOG.warning("Failed to read launcher icon", e);
            return "";
        }
    }

    // ==================== 杂项 ====================

    private static Path backgroundFile(HMCLGameInstance instance, String name) {
        return instance.getInstanceRoot().resolve(THEME_DIR).resolve(name);
    }

    private static Path launcherIconFile(HMCLGameInstance instance, String name) {
        return instance.getInstanceRoot().resolve(THEME_DIR).resolve(name);
    }

    /// 图片转 data URL。WebView2 对指向 127.0.0.1 的 `<img src>` 会做
    /// Private Network Access 检查，图标和背景图都只能走这条路。
    private static String dataUrlOf(Path file) {
        try {
            if (!Files.isRegularFile(file) || Files.size(file) > MAX_BACKGROUND_BYTES) {
                return "";
            }
            byte[] bytes = Files.readAllBytes(file);
            String mime = switch (extensionOf(file.getFileName().toString())) {
                case "png" -> "image/png";
                case "webp" -> "image/webp";
                case "bmp" -> "image/bmp";
                case "gif" -> "image/gif";
                default -> "image/jpeg";
            };
            return "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(bytes);
        } catch (Throwable e) {
            LOG.warning("Failed to read image " + file, e);
            return "";
        }
    }

    private static HMCLGameInstance instanceOf(String instanceId) {
        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        if (repository == null || instanceId == null || instanceId.isBlank()) {
            return null;
        }
        // 用 findInstance 而不是 getInstance：实例删掉之后前端还可能拿着旧 id
        // （选中态晚一拍更新），getInstance 会抛 NoSuchGameInstanceException，
        // 每次切页刷两条堆栈，日志里全是噪音。
        return repository.findInstance(new GameInstanceID(instanceId));
    }

    private static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    private static void deleteQuietly(Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (Throwable ignored) {
        }
    }
}
