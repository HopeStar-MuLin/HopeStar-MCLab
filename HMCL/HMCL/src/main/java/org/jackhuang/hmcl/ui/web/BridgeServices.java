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

import org.jetbrains.annotations.NotNullByDefault;

import java.util.function.Consumer;

/// 下载 / 内容 / 设置 / Java 安装这组业务服务的持有者。
///
/// <p>它们原来直接挂在 [WebBridge] 上，拆出 `*Api` 之后有两三个类要共用，所以收进来一份。
/// 谁需要谁拿，不要再各自 new 一个：`SettingsService` 里有缓存，两个实例会各缓存一份，
/// 表现成「设置改了但页面里还是旧值」这种鬼问题。
@NotNullByDefault
final class BridgeServices {

    final DownloadService download;
    final AddonService addons;
    final GameIntegrityService integrity;
    final ExportService exports;
    final ArchiveImportService archiveImports;
    final SettingsService settings;
    final JavaInstallService javaInstall;

    /// 游戏退出后的收尾（自动备份 + 时长统计）。构造时就把自己挂到
    /// `LauncherHelper` 的退出回调上，之后不需要谁再调它。
    final GameExitService exits;

    BridgeServices(Consumer<String> js) {
        this.download = new DownloadService(js);
        this.addons = new AddonService(js);
        this.integrity = new GameIntegrityService(js);
        this.exports = new ExportService(js);
        this.archiveImports = new ArchiveImportService(js);
        this.settings = new SettingsService(js);
        // 装完 Java 要把新列表推回页面
        this.javaInstall = new JavaInstallService(js, settings::requestJavaList);
        // 装完一个实例就检查它需要的 Java：本地没有就静默补一个
        this.download.setAfterInstall(javaInstall::ensureForGame);
        this.exits = new GameExitService(js);
        GameExitService.register(this.exits);
    }
}
