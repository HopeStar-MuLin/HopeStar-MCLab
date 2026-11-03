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

/// 实例主题：图标、窗口标题、强调色、背景图。
///
/// <p>数据在 `InstanceThemeService`（每个实例一份 theme.json），这里只做转发。
/// 「重置图标」和「清除背景」要顺手推一次状态，否则页面上删了还挂着旧图。
@NotNullByDefault
public final class InstanceThemeApi {

    private final BridgeHost host;

    InstanceThemeApi(BridgeHost host) {
        this.host = host;
    }

    /// 主题面板的数据（窗口标题、强调色、是否有背景图/自定义图标）。
    public String instanceTheme(String instanceId) {
        return InstanceThemeService.load(instanceId);
    }

    /// 保存窗口标题、强调色和启动器段的文字配置。
    public String instanceThemeSave(String instanceId, String windowTitle, String accent,
                                    String launcherTitle, boolean launcher) {
        return InstanceThemeService.save(instanceId, windowTitle, accent, launcherTitle, launcher);
    }

    /// 启动器图标（标题栏左上角）的 data URL，没设返回空串。
    public String instanceThemeLauncherIcon(String instanceId) {
        return InstanceThemeService.launcherIconDataUrl(instanceId);
    }

    /// 去掉自定义的启动器图标，回到内置那张。
    public String instanceThemeClearLauncherIcon(String instanceId) {
        return InstanceThemeService.clearLauncherIcon(instanceId);
    }

    /// 背景图的 data URL（没有背景图时返回空串）。
    public String instanceThemeBackgroundUrl(String instanceId) {
        return InstanceThemeService.backgroundDataUrl(instanceId);
    }

    /// 恢复默认图标（删掉 icon.*，预设也回到 DEFAULT）。
    public String instanceThemeResetIcon(String instanceId) {
        String json = InstanceThemeService.resetIcon(instanceId);
        host.pushState();
        return json;
    }

    /// 移除背景图。
    public String instanceThemeClearBackground(String instanceId) {
        return InstanceThemeService.clearBackground(instanceId);
    }

}
