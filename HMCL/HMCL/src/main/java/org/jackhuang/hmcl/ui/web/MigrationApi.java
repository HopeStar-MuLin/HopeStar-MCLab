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
import javafx.beans.value.ChangeListener;
import javafx.beans.value.ObservableValue;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.game.HMCLGameRepositorySnapshot;
import org.jackhuang.hmcl.util.PortablePath;
import org.jackhuang.hmcl.setting.GameDirectory;
import javafx.stage.DirectoryChooser;
import org.jackhuang.hmcl.setting.SettingsManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.i18n.LocalizedText;
import com.google.gson.JsonObject;
import javafx.stage.Stage;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 把已有的游戏目录接进来：old 启动器（HMCL / PCL / 官方）与手动选的目录。
///
/// <p>两套来源最后都落到「扫版本目录 → 建实例 → 等仓库加载完再推一次状态」，
/// 差别只在从哪儿开始找。扫盘是全量 IO，所以 `watchRepositoryLoaded` 挂了个一次性
/// 监听：仓库加载完就推，页面不用轮询。
@NotNullByDefault
public final class MigrationApi {

    private final BridgeHost host;

    MigrationApi(BridgeHost host) {
        this.host = host;
    }


    /// 让用户挑一个旧启动器的目录，扫一遍里面有什么可以搬，结果推回页面。
    ///
    /// 只做扫描，不动任何文件 —— 用户看完清单再决定导不导。
    public void chooseLegacyLauncher() {
        DirectoryChooser chooser = new DirectoryChooser();
        chooser.setTitle("选择旧启动器目录");
        // 从用户目录开始翻，比从 C 盘根目录开始省事
        java.io.File home = new java.io.File(System.getProperty("user.home", ""));
        if (home.isDirectory()) {
            chooser.setInitialDirectory(home);
        }
        // owner 传 null，别用 Controllers.getStage()。
        // 壳模式的 JavaFX Stage 是隐藏的、从没摆过位置，拿它当 owner 会把
        // 对话框一起带到屏幕外 —— 表现就是"点了按钮什么都没弹出来"。
        java.io.File picked = chooser.showDialog(null);
        Path chosen = picked == null ? null : picked.toPath();
        if (chosen == null) {
            // 取消也要回一句：前端把按钮点灰了在等结果，不回调的话它会一直灰着
            JsonObject cancel = new JsonObject();
            cancel.addProperty("cancel", true);
            host.execute("window.__hmcl && window.__hmcl.onLegacyScanned("
                    + JsonUtils.GSON.toJson(cancel.toString()) + ")");
            return;
        }

        JsonObject result = new JsonObject();
        try {
            Path dataRoot = LegacyMigrator.resolveDataRoot(chosen);
            result = LegacyMigrator.scan(dataRoot).toJson();
        } catch (Exception e) {
            LOG.warning("Failed to scan legacy launcher directory " + chosen, e);
            result.addProperty("ok", false);
            result.addProperty("error", e.getMessage() != null ? e.getMessage() : String.valueOf(e));
        }

        host.execute("window.__hmcl && window.__hmcl.onLegacyScanned("
                + JsonUtils.GSON.toJson(result.toString()) + ")");
    }

    /// 执行迁移。`parts` 是逗号分隔的 `accounts,dirs,appearance`，
    /// `mode` 是 `move`（搬走，删旧文件）或 `reference`（只复制，旧的留着）。
    ///
    /// 完成后必须重启启动器：账号是启动时一次性读进内存的，
    /// 换了文件不重启还是旧的。
    public void importLegacyLauncher(String dataRoot, String parts, String mode) {
        JsonObject result = new JsonObject();
        try {
            java.util.LinkedHashSet<LegacyMigrator.Part> wanted = new java.util.LinkedHashSet<>();
            if (parts != null) {
                for (String key : parts.split(",")) {
                    LegacyMigrator.Part part = LegacyMigrator.Part.of(key.trim());
                    if (part != null) {
                        wanted.add(part);
                    }
                }
            }
            if (wanted.isEmpty()) {
                throw new IllegalArgumentException("没有勾选要导入的内容");
            }
            result = LegacyMigrator.migrate(Path.of(dataRoot), wanted, LegacyMigrator.Mode.of(mode));
        } catch (Exception e) {
            LOG.warning("Failed to migrate legacy data from " + dataRoot, e);
            result.addProperty("ok", false);
            result.addProperty("error", e.getMessage() != null ? e.getMessage() : String.valueOf(e));
        }

        host.execute("window.__hmcl && window.__hmcl.onLegacyImported("
                + JsonUtils.GSON.toJson(result.toString()) + ")");
    }

    // ==================== 导入已有游戏目录 ====================

    /// 让用户挑一个已有的游戏目录导入。
    ///
    /// 「已有」指 PCL2 / HMCL / 官方启动器 / 整合包解出来的那份 `.minecraft`。
    /// 用户不需要知道该点哪一层：选中 `.minecraft` 的父目录也行，
    /// [`#resolveGameDirectory`] 会自己往下找到带 `versions` 的那一层。
    public void chooseGameDirectory() {
        DirectoryChooser chooser = new DirectoryChooser();
        chooser.setTitle("选择游戏目录");
        java.io.File home = new java.io.File(System.getProperty("user.home", ""));
        if (home.isDirectory()) {
            chooser.setInitialDirectory(home);
        }
        // owner 传 null：壳模式的 JavaFX Stage 是隐藏的，位置从没设过，
        // 拿它当 owner 会把对话框带到看不见的地方
        java.io.File picked = chooser.showDialog(null);
        Path chosen = picked == null ? null : picked.toPath();
        if (chosen == null) {
            return; // 用户取消
        }
        importGameDirectory(chosen.toString());
    }

    /// 路径已知时直接导入。
    ///
    /// 走完整个流程：收敛目录 → 去重 → 加成游戏目录 → 切过去 → 数版本 → 推状态。
    /// 整个过程都在 FX 线程上（调用方就在 FX 线程），只碰目录列表和设置文件，够快。
    public void importGameDirectory(String rawPath) {
        if (rawPath == null || rawPath.isBlank()) {
            return;
        }

        JsonObject result = new JsonObject();
        try {
            Path dir = resolveGameDirectory(Path.of(rawPath));

            GameDirectory target = findGameDirectory(dir);
            if (target == null) {
                target = new GameDirectory(
                        GameDirectoryManager.newGameDirectoryId(),
                        LocalizedText.plain(suggestDirectoryName(dir)),
                        PortablePath.fromPath(dir));
                // 绝对路径归用户级配置，相对路径归工作区配置（和 GameDirectoryPage 一致）
                if (target.getPath().isAbsolute()) {
                    if (SettingsManager.isUserGameDirectoriesReadOnly()) {
                        SettingsManager.forceOverwriteUserGameDirectories();
                    }
                    GameDirectoryManager.addUserGameDirectory(target);
                } else {
                    if (SettingsManager.isLocalGameDirectoriesReadOnly()) {
                        SettingsManager.forceOverwriteLocalGameDirectories();
                    }
                    GameDirectoryManager.addLocalGameDirectory(target);
                }
                result.addProperty("added", true);
            } else {
                result.addProperty("added", false);
            }

            GameDirectoryManager.setSelectedGameDirectory(target);

            // 版本数直接数目录，不问仓库：仓库是异步加载的，这一刻它一定还没刷完
            int versions = countVersionDirectories(dir);
            result.addProperty("ok", true);
            result.addProperty("path", dir.toString());
            result.addProperty("name", GameDirectoryManager.getGameDirectoryDisplayName(target));
            result.addProperty("versions", versions);

            watchRepositoryLoaded();
            host.pushState();
        } catch (Exception e) {
            LOG.warning("Failed to import game directory " + rawPath, e);
            result.addProperty("ok", false);
            result.addProperty("error", e.getMessage() != null ? e.getMessage() : String.valueOf(e));
        }

        host.execute("window.__hmcl && window.__hmcl.onGameDirectoryImported("
                + JsonUtils.GSON.toJson(result.toString()) + ")");
    }

    /// 把用户选的目录收敛成真正的游戏目录（带 `versions/` 的那一层）。
    private static Path resolveGameDirectory(Path chosen) throws IOException {
        Path dir = chosen.toAbsolutePath().normalize();
        if (!Files.isDirectory(dir)) {
            throw new IOException("目录不存在：" + dir);
        }
        if (Files.isDirectory(dir.resolve("versions"))) {
            return dir;
        }
        // 选的是装着 .minecraft 的那一层（PCL2 便携版就是这个结构）
        if (Files.isDirectory(dir.resolve(".minecraft"))) {
            return dir.resolve(".minecraft");
        }
        // 大小写不一致的 `.Minecraft` 也认
        try (Stream<Path> list = Files.list(dir)) {
            for (Path child : list.toList()) {
                if (Files.isDirectory(child)
                        && ".minecraft".equalsIgnoreCase(child.getFileName().toString())
                        && Files.isDirectory(child.resolve("versions"))) {
                    return child;
                }
            }
        } catch (IOException e) {
            // 没权限列目录，落到下面统一的报错
        }
        throw new IOException("这个目录里没有 versions 文件夹，不像是 Minecraft 游戏目录");
    }

    /// 游戏目录的默认名字。
    ///
    /// 直接拿 `getFileName()` 会得到一堆 `.minecraft`，三个目录在列表里没法区分。
    /// 这种情况退一层用父目录名（`PCL2` / `MCLab` / `HMCL`），正好是用户认得的启动器目录。
    private static String suggestDirectoryName(Path dir) {
        Path fileName = dir.getFileName();
        String name = fileName != null ? fileName.toString() : "";
        Path parent = dir.getParent();
        if ((".minecraft".equalsIgnoreCase(name) || name.isBlank()) && parent != null
                && parent.getFileName() != null) {
            String outer = parent.getFileName().toString();
            if (!outer.isBlank() && !outer.endsWith(":")) {
                return outer;
            }
        }
        return name.isBlank() ? "游戏目录" : name;
    }

    /// 数一下 `versions/` 下有 `<名字>.json` 的目录——和 HMCL 认实例的条件一致。
    private static int countVersionDirectories(Path gameDir) {
        Path versions = gameDir.resolve("versions");
        if (!Files.isDirectory(versions)) {
            return 0;
        }
        try (Stream<Path> list = Files.list(versions)) {
            return (int) list.filter(Files::isDirectory)
                    .filter(d -> Files.isRegularFile(d.resolve(d.getFileName() + ".json")))
                    .count();
        } catch (IOException e) {
            return 0;
        }
    }

    /// 同一个路径已经在列表里就别重复加：重复条目会各开一个仓库，
    /// 实例列表里看着一模一样，用户分不出点哪个。
    @Nullable
    private static GameDirectory findGameDirectory(Path dir) {
        String target = PortablePath.fromPath(dir).getPath();
        for (GameDirectory gameDirectory : GameDirectoryManager.getGameDirectories()) {
            String path = gameDirectory.getPath().getPath();
            if (path.equalsIgnoreCase(target)) {
                return gameDirectory;
            }
            if (!gameDirectory.getPath().isAbsolute()) {
                try {
                    Path resolved = Path.of(path).toAbsolutePath().normalize();
                    if (resolved.toString().equalsIgnoreCase(target)) {
                        return gameDirectory;
                    }
                } catch (Exception ignored) {
                    // 相对路径解析失败就当不匹配
                }
            }
        }
        return null;
    }

    /// 新目录的仓库要加载一遍才有实例。加载完会发布一次快照，这里挂一次性监听，
    /// 收到就再推一次状态——否则用户看到的是空列表，会以为导入失败。
    private void watchRepositoryLoaded() {
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            ChangeListener<HMCLGameRepositorySnapshot> once = new ChangeListener<>() {
                @Override
                public void changed(ObservableValue<? extends HMCLGameRepositorySnapshot> observable,
                                    @Nullable HMCLGameRepositorySnapshot oldValue,
                                    @Nullable HMCLGameRepositorySnapshot newValue) {
                    observable.removeListener(this);
                    Platform.runLater(host::pushState);
                }
            };
            repository.snapshotProperty().addListener(once);
        } catch (Exception e) {
            LOG.warning("Failed to watch repository loading", e);
        }
    }

}
