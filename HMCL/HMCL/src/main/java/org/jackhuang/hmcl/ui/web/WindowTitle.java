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

import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.Pointer;
import com.sun.jna.WString;
import com.sun.jna.win32.StdCallLibrary;
import com.sun.jna.win32.W32APIOptions;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 启动后把 Minecraft 的游戏窗口标题改成实例设定的文字。
///
/// <p>游戏标题是 `Minecraft.getWindowTitle()` 在运行时拼出来的（"Minecraft 1.21.1"），
/// 启动参数里没有对应开关，也不在常量池里，所以改 jar 不现实。
/// 这里用 Win32 的 `SetWindowTextW` 在窗口出现后直接改标题 —— 只影响显示，
/// 不影响存档、多人游戏或任何游戏内逻辑。
///
/// <p>匹配方式是「标题以 Minecraft 开头 + 窗口可见」：启动器自己的窗口叫
/// `HopeStar-MCLab`，不会被误伤。轮询 90 秒还没等到窗口就放弃（用户可能在
/// 下载资源，或者启动失败了 —— 那种情况有别的提示）。
final class WindowTitle {

    /// 盯多久。游戏从进程起来到主菜单一般 10–25 秒，给足余量。
    private static final long TIMEOUT_MS = 120_000L;
    private static final long INTERVAL_MS = 1500L;

    private WindowTitle() {
    }

    /// 后台等游戏窗口出现并改标题。失败只记日志。
    static void applyAsync(String title) {
        if (title == null || title.isBlank()) {
            return;
        }
        try {
            if (!com.sun.jna.Platform.isWindows()) {
                return;
            }
        } catch (Throwable e) {
            return;
        }

        Thread thread = new Thread(() -> {
            long deadline = System.currentTimeMillis() + TIMEOUT_MS;
            boolean everApplied = false;
            while (System.currentTimeMillis() < deadline) {
                try {
                    // 反复设置而不是设一次就退出：GLFW 在窗口初始化、切换全屏、
                    // 重新获得焦点时都会用自己缓存的标题调一次 SetWindowText，
                    // 只设一次会在几秒后被冲掉（实测：设完 10 秒又变回
                    // "Minecraft* 1.21.1"）。这里在整个启动窗口期盯着。
                    if (rename(title.trim()) && !everApplied) {
                        everApplied = true;
                        LOG.info("[theme] window title → " + title);
                    }
                } catch (Throwable e) {
                    LOG.warning("[theme] cannot rename game window", e);
                    return;
                }
                try {
                    Thread.sleep(INTERVAL_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            if (!everApplied) {
                LOG.info("[theme] 没等到 Minecraft 窗口，标题未修改：" + title);
            }
        }, "instance-window-title");
        thread.setDaemon(true);
        thread.start();
    }

    /// 一次尝试：遍历可见窗口，找到游戏主窗口就改名。
    private static boolean rename(String title) {
        User32 user32 = User32Holder.INSTANCE;
        if (user32 == null) {
            return true; // 没 JNA 就当完成，别每 800ms 重试一次
        }
        boolean[] done = {false};
        // 回调对象必须强引用，被 GC 掉会直接 crash（JNA 的经典坑）
        User32Holder.CALLBACK = (hWnd, lParam) -> {
            if (!user32.IsWindowVisible(hWnd)) {
                return true;
            }
            char[] buffer = new char[512];
            int length = user32.GetWindowTextW(hWnd, buffer, buffer.length);
            if (length <= 0) {
                return true;
            }
            String current = new String(buffer, 0, length);
            // 只认游戏窗口：启动器的标题里没有 Minecraft
            if (!current.startsWith("Minecraft")) {
                return true;
            }
            done[0] = user32.SetWindowTextW(hWnd, new WString(title));
            return !done[0];
        };
        user32.EnumWindows(User32Holder.CALLBACK, null);
        return done[0];
    }

    /// 延迟加载：JNA 在部分环境（没 native 库）会抛，别让它在类初始化时炸掉。
    private static final class User32Holder {
        static final User32 INSTANCE = load();
        /// 持有回调引用，防止被 GC
        static User32.EnumWindowsProc CALLBACK;

        private static User32 load() {
            try {
                return Native.load("user32", User32.class, W32APIOptions.UNICODE_OPTIONS);
            } catch (Throwable e) {
                LOG.warning("[theme] user32 not available", e);
                return null;
            }
        }
    }

    private interface User32 extends Library {
        boolean EnumWindows(EnumWindowsProc callback, Pointer lParam);

        boolean IsWindowVisible(Pointer hWnd);

        int GetWindowTextW(Pointer hWnd, char[] text, int maxCount);

        boolean SetWindowTextW(Pointer hWnd, WString text);

        interface EnumWindowsProc extends StdCallLibrary.StdCallCallback {
            boolean invoke(Pointer hWnd, Pointer lParam);
        }
    }
}
