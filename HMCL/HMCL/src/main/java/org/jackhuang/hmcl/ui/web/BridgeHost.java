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

import org.jackhuang.hmcl.setting.Accounts;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.util.Objects;
import java.nio.charset.Charset;
import java.util.function.Consumer;
import java.util.concurrent.TimeUnit;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 桥接对象共用的出口：往页面推 JS、弹提示、让前端重拉状态。
///
/// <p>拆出去的 `*Api` 只拿这四个能力（含 [#localize]），拿不到 [WebBridge] 本身——
/// 避免刚拆完又通过 `bridge.xxx` 绕回去。确实需要更多能力时，往这里加一个明确的方法，
/// 而不是把宿主整个传进来。
@NotNullByDefault
final class BridgeHost {

    private final Consumer<String> js;
    private final Consumer<String> toast;
    private final Runnable pushState;

    BridgeHost(Consumer<String> js, Consumer<String> toast, Runnable pushState) {
        this.js = Objects.requireNonNull(js);
        this.toast = Objects.requireNonNull(toast);
        this.pushState = Objects.requireNonNull(pushState);
    }

    /// 执行一段 JS。壳模式走 SSE，JavaFX 模式走 WebEngine，由宿主决定。
    void execute(String script) {
        js.accept(script);
    }

    /// 轻提示。JavaFX 落到 Decorator 的 toast，壳模式推给页面。
    void toast(String message) {
        toast.accept(message);
    }

    /// 让前端重新拉一次完整状态（改名 / 删除实例之后要刷新列表）。
    void pushState() {
        pushState.run();
    }

    /// 弹一个 Windows 原生打开文件对话框，返回选中路径（取消返回 null）。
    @Nullable
    String pickFile(String title, String filter) {
        String script = "Add-Type -AssemblyName System.Windows.Forms;"
                + "$d = New-Object System.Windows.Forms.OpenFileDialog;"
                + "$d.Title = '" + title.replace("'", "''") + "';"
                + "$d.Filter = '" + filter.replace("'", "''") + "';"
                + "$d.CheckFileExists = $true;"
                + "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)"
                + " { [Console]::Out.Write($d.FileName) }";
        try {
            ProcessBuilder pb = new ProcessBuilder("powershell", "-NoProfile", "-STA", "-Command", script);
            Process proc = pb.start();
            byte[] out = proc.getInputStream().readAllBytes();
            proc.waitFor(300, TimeUnit.SECONDS);
            String text = new String(out, Charset.defaultCharset());
            text = text.replace("\uFEFF", "").trim();
            return text.isEmpty() ? null : text;
        } catch (Throwable e) {
            LOG.warning("[java] file dialog failed", e);
            toast("打不开文件选择器：" + e.getMessage());
            return null;
        }
    }

    /// 把异常翻成一句能给用户看的文案。
    ///
    /// <p>HMCL 的认证类异常自带本地化消息，能拿到就用它；拿不到就退回 message，
    /// 再不行用类名——总比把堆栈甩到 toast 里强。
    static String localize(Throwable t) {
        if (t instanceof Exception e) {
            try {
                return Accounts.localizeErrorMessage(e);
            } catch (Exception ignored) {
                // 落到下面
            }
        }
        return t.getMessage() != null ? t.getMessage() : t.getClass().getSimpleName();
    }
}
