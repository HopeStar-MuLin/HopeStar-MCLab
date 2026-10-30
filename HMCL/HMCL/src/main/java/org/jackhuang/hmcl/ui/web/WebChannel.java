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

/// Java -> 前端的输出通道。
///
/// 存在的理由：`WebBridge` 里有 40 多处 `execute("window.__hmcl.onXxx(...)")`，
/// 这些拼好的 JS 字符串不该为换壳重写。把「执行这段 JS」抽象成一个方法，
/// JavaFX 模式下落到 `WebEngine.executeScript`，Tauri 模式下落到 SSE 推送，
/// 上层调用点一行都不用动。
public interface WebChannel {

    /// 在页面里执行一段 JS。实现方负责切到合适的线程。
    void eval(String script);
}
