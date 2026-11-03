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

import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

/// 按 id 找游戏实例。
///
/// <p>原来只是 [WebBridge] 的一个私有静态方法，拆出 `*Api` 之后有几个类都要用，
/// 单独放一份，免得复制三份还各自漂移。找不到返回 `null`（不抛异常）：
/// 用户删掉实例的同时页面还挂着一个旧 id，属于正常竞态。
@NotNullByDefault
final class InstanceLookup {

    private InstanceLookup() {
    }

    static @Nullable HMCLGameInstance find(@Nullable String id) {
        if (id == null) {
            return null;
        }
        HMCLGameInstance selected = GameDirectoryManager.getSelectedInstance();
        if (selected != null && selected.getId().toString().equals(id)) {
            return selected;
        }
        try {
            return GameDirectoryManager.getSelectedRepository().getDisplayInstances()
                    .filter(it -> it.getId().toString().equals(id))
                    .findFirst()
                    .orElse(null);
        } catch (Exception e) {
            return null;
        }
    }
}
