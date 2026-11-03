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

import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.ui.Controllers;
import org.jackhuang.hmcl.ui.FXUtils;
import org.jetbrains.annotations.NotNullByDefault;


import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 设置页：启动器 / 下载 / Java / 游戏四段，外加本机 Java 的扫描与安装。
///
/// <p>业务在 {@link SettingsService}（有缓存）和 {@link JavaInstallService}（负责下载安装），
/// 这里只做参数搬运。两者都从 {@link BridgeServices} 拿，不能自己 new——
/// 各建一份会出现「改了设置页面还是旧值」。
@NotNullByDefault
public final class SettingsApi {

    private final BridgeHost host;
    private final BridgeServices services;

    SettingsApi(BridgeHost host, BridgeServices services) {
        this.host = host;
        this.services = services;
    }

    /// 设置快照：启动器 / 下载 / Java / 游戏四段。
    /// 具体字段和写入逻辑都在 {@link SettingsService}。
    public String getSettings() {
        return services.settings.snapshot();
    }

    /// 打开启动器日志目录（HMCL 设置页「杂项」里那个按钮）
    public void openLogFolder() {
        services.settings.openLogFolder();
    }

    /// 物理内存快照，前端定时刷新用
    public String memorySnapshot() {
        return services.settings.memorySnapshot();
    }

    /// 把日志打包导出（HMCL 的「导出日志」）
    public void exportLogs() {
        services.settings.exportLogs();
    }

    /// 清理下载缓存目录
    public void cleanCache() {
        services.settings.cleanCache();
    }

    /// 切换下载源。kind: `version`（版本清单）/ `file`（文件下载），
    /// value: `default`（自动）/ `official`（官方）/ `mirror`（BMCLAPI 镜像）。
    ///
    /// 底层是 `DownloadProviders.init()` 里注册的两个监听器，
    /// 改属性会立刻作用到 `HMCLDownloadProvider`，不用重启。
    public void setDownloadSource(String kind, String value) {
        org.jackhuang.hmcl.setting.DownloadSource source = switch (value == null ? "" : value) {
            case "official" -> org.jackhuang.hmcl.setting.DownloadSource.OFFICIAL;
            case "mirror" -> org.jackhuang.hmcl.setting.DownloadSource.MIRROR;
            default -> org.jackhuang.hmcl.setting.DownloadSource.DEFAULT;
        };

        try {
            var settings = org.jackhuang.hmcl.setting.SettingsManager.settings();
            if ("file".equals(kind)) {
                settings.fileDownloadSourceProperty().set(source);
            } else {
                settings.versionListSourceProperty().set(source);
            }
            pushSettings();
        } catch (Exception e) {
            LOG.warning("Failed to set download source", e);
        }
    }

    /// 下载并发。`auto` 为 true 时用 HMCL 的默认值（不写死一个数）。
    public void setDownloadThreads(String mode, String count) {
        try {
            var settings = org.jackhuang.hmcl.setting.SettingsManager.settings();
            boolean auto = !"manual".equals(mode);
            settings.autoDownloadThreadsProperty().set(auto);
            if (!auto) {
                int parsed;
                try {
                    parsed = Integer.parseInt(count == null ? "" : count.trim());
                } catch (NumberFormatException e) {
                    parsed = 64;
                }
                settings.downloadThreadsProperty().set(Math.max(1, Math.min(256, parsed)));
            }
            pushSettings();
        } catch (Exception e) {
            LOG.warning("Failed to set download threads", e);
        }
    }

    /// 把最新设置推给前端（onSettings）。改完设置要让界面回填真实值，
    /// 尤其是被夹到合法范围的那些。
    private void pushSettings() {
        String json = services.settings.snapshot();
        host.execute("window.__hmcl && window.__hmcl.onSettings("
                + JsonUtils.GSON.toJson(json) + ")");
    }

    /// 写一个启动器级设置。key 见 SettingsService.setLauncher。
    public void setLauncherSetting(String key, String value) {
        services.settings.setLauncher(key, value);
    }

    /// 写一个游戏级设置（全局预设）。key 见 SettingsService.setGame。
    public void setGameSetting(String key, String value) {
        services.settings.setGame(key, value);
    }

    /// 新建实例默认用哪种版本隔离策略。
    ///
    /// @return {@code "ALWAYS"} / {@code "MODDED"} / {@code "NEVER"}
    public String getIsolationType() {
        try {
            org.jackhuang.hmcl.setting.GameSettings.Preset preset = org.jackhuang.hmcl.setting.GameDirectoryManager
                    .getSelectedRepository().getParentGameSettings(null);
            org.jackhuang.hmcl.setting.DefaultIsolationType type = preset.defaultIsolationTypeProperty().getValue();
            return (type == null ? org.jackhuang.hmcl.setting.DefaultIsolationType.ALWAYS : type).name();
        } catch (Throwable e) {
            LOG.warning("Failed to read isolation type", e);
            return "ALWAYS";
        }
    }

    /// 改新建实例的默认隔离策略。
    ///
    /// <p>隔离 = 把 `versions/<id>/` 当成独立的 .minecraft（各自的 mods、saves、配置）。
    /// 带加载器的实例基本都要开，不然模组会串到所有版本里。
    public void setIsolationType(String name) {
        try {
            org.jackhuang.hmcl.setting.DefaultIsolationType type = org.jackhuang.hmcl.setting.DefaultIsolationType
                    .valueOf(name);
            org.jackhuang.hmcl.game.HMCLGameRepository repository =
                    org.jackhuang.hmcl.setting.GameDirectoryManager.getSelectedRepository();
            org.jackhuang.hmcl.setting.GameSettings.Preset preset = repository.getParentGameSettings(null);
            preset.defaultIsolationTypeProperty().setValue(type);
            org.jackhuang.hmcl.setting.SettingsManager.savePendingChanges();

            // 同时套用到已有实例。
            //
            // 这个开关原来只改「新建实例的默认值」，改完之后老实例纹丝不动 ——
            // 用户看到的是「设置改成功了，实例还是老样子」，自然认为开关没用。
            // 现在按新策略逐个对齐；转隔离时把公共目录的模组/存档补一份进实例目录，
            // 否则切完隔离实例启动起来是空的，等于把用户的模组藏了。
            int toIsolated = 0;
            int toShared = 0;
            int seeded = 0;
            for (org.jackhuang.hmcl.game.HMCLGameInstance instance : repository.getDisplayInstances().toList()) {
                boolean want = switch (type) {
                    case ALWAYS -> true;
                    case NEVER -> false;
                    case MODDED -> instance.isModpack() || hasModLoader(instance);
                };
                if (want && !instance.isIsolated()) {
                    instance.enableIsolation();
                    seeded += seedFromSharedDirectory(repository.getBaseDirectory(), instance.getRunDirectory());
                    toIsolated++;
                } else if (!want && instance.isIsolated()) {
                    instance.disableIsolation();
                    toShared++;
                }
            }

            String scope = switch (type) {
                case ALWAYS -> "新实例一律隔离";
                case MODDED -> "只有带加载器的实例才隔离";
                case NEVER -> "新实例都不隔离";
            };
            String applied;
            if (toIsolated == 0 && toShared == 0) {
                applied = "，已有实例本来就符合";
            } else {
                applied = "；已有实例已同步：";
                if (toIsolated > 0) {
                    applied += toIsolated + " 个转为隔离";
                }
                if (toShared > 0) {
                    applied += (toIsolated > 0 ? "、" : "") + toShared + " 个转回共享目录";
                }
                if (seeded > 0) {
                    applied += "（补入 " + seeded + " 个共享目录项）";
                }
                if (toShared > 0) {
                    // 反方向没法自动做：几个实例的同名 mods/saves 合并回公共目录，
                    // 谁覆盖谁没有正确答案，宁可让用户自己决定
                    applied += "。实例目录里的 mods/saves 未移动，需要的话手动合并";
                }
            }
            host.toast(scope + applied);
            host.pushState();
        } catch (Throwable e) {
            LOG.warning("Failed to set isolation type", e);
            host.toast("切换隔离策略失败：" + e.getMessage());
        }
    }

    /// 版本里有没有模组加载器（按版本 id 判断，够用且不依赖实例是否已解析）。
    private static boolean hasModLoader(org.jackhuang.hmcl.game.HMCLGameInstance instance) {
        String id = String.valueOf(instance.getId()).toLowerCase(java.util.Locale.ROOT);
        for (String loader : new String[]{"fabric", "forge", "neoforge", "quilt", "cleanroom", "optifine"}) {
            if (id.contains(loader)) {
                return true;
            }
        }
        return false;   // modpack 的判断在外层 switch 里已经做过
    }

    /// 把公共目录里实例还缺的那几项目录补进来（mods / saves / config 等）。
    ///
    /// <p>只在实例目录里**完全没有**这个子目录时复制，避免把用户在实例里
    /// 改过的配置冲掉。返回补了几项。
    private static int seedFromSharedDirectory(java.nio.file.Path base, java.nio.file.Path runDir) {
        if (base == null || runDir == null || base.normalize().equals(runDir.normalize())) {
            return 0;
        }
        int seeded = 0;
        for (String name : new String[]{"mods", "saves", "config", "resourcepacks", "shaderpacks"}) {
            java.nio.file.Path from = base.resolve(name);
            java.nio.file.Path to = runDir.resolve(name);
            if (!java.nio.file.Files.isDirectory(from) || java.nio.file.Files.exists(to)) {
                continue;
            }
            try {
                LegacyMigrator.copyTree(from, to, false);
                seeded++;
            } catch (Exception e) {
                LOG.warning("[settings] 补入 " + name + " 失败", e);
            }
        }
        return seeded;
    }

    /// 前端进设置页时调一次，把 Java 列表推过来。
    /// 前端打开「下载 Java」时调一次：拉当前设备可安装的版本列表。
    public void listInstallableJava() {
        services.javaInstall.requestList();
    }

    /// 装一个。id 是列表里那一项的 `temurin-21`，别自己拼。
    public void installJava(String id) {
        services.javaInstall.install(id);
    }

    /// 暂停 Java 下载。已下好的字节留在 .part 里，继续时接着下。
    public void pauseJavaDownload(String taskId) {
        services.javaInstall.pause(taskId);
    }

    /// 继续下载。
    public void resumeJavaDownload(String taskId) {
        services.javaInstall.resume(taskId);
    }

    public void requestJavaList() {
        services.settings.requestJavaList();
    }

    /// 重新扫描本机 Java。
    public void refreshJava() {
        services.settings.refreshJava();
    }

    /// 添加一个 Java 可执行文件（<java-home>/bin/java.exe 或 javaw.exe）。
    public void addJava(String binary) {
        services.settings.addJava(binary);
    }

    /// 用 Windows 原生的「打开文件」对话框挑一个 java 可执行文件，选完直接加进列表。
    ///
    /// <p>壳模式下 JavaFX 根本没有 Stage，`Controllers.showOpenDialog` 一定返回 null，
    /// 所以借 `System.Windows.Forms.OpenFileDialog` —— 系统原生对话框，
    /// 不依赖任何 UI 框架，模态也跑在它自己的进程里，不会卡住界面。
    public void pickJavaFile() {
        String path = host.pickFile("选择 Java 可执行文件",
                "Java 可执行文件|javaw.exe;java.exe|所有文件|*.*");
        if (path == null || path.isBlank()) {
            return;
        }
        addJava(path);
        LOG.info("[java] picked from dialog: " + path);
        host.toast("已添加：" + path);
    }

    /// 移除 / 禁用列表里的 Java。
    public void removeJava(String binary) {
        services.settings.removeJava(binary);
    }

    /// 在资源管理器里定位一个 Java。
    public void revealJava(String binary) {
        try {
            java.nio.file.Path path = java.nio.file.Path.of(binary.trim());
            java.nio.file.Path target = path;
            java.nio.file.Path parent = path.getParent();
            // bin/java.exe → 退到 java home，跟 HMCL 的行为一致
            if (parent != null && parent.getFileName() != null
                    && "bin".equalsIgnoreCase(parent.getFileName().toString())
                    && java.nio.file.Files.exists(parent.resolveSibling("release"))) {
                target = parent.getParent();
            }
            org.jackhuang.hmcl.ui.FXUtils.showFileInExplorer(target);
        } catch (Exception e) {
            LOG.warning("Failed to reveal java " + binary, e);
        }
    }
}
