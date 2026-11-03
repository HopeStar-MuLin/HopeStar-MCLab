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

import java.io.IOException;
import java.util.logging.Level;
import java.util.logging.Logger;

/// Tauri 壳模式（`-Dhmcl.web.http=true`）的装配入口。
///
/// 和 `-Dhmcl.ui.web=true` 的区别：那个是 JavaFX 窗口里嵌 WebView，这个是
/// 不显示 JavaFX 窗口、只把 {@link WebBridge} 挂到本机 HTTP 上，窗口由 Tauri 负责。
///
/// 之所以还要起 JavaFX：`WebBridge` 里渲染皮肤披风要用 `SkinCanvas`（JavaFX Canvas），
/// 全量迁移到纯 Java2D 是另一件事，收益也不大。所以 Toolkit 照常启动，只是不出窗口。
public final class WebUIShell {

    private static final Logger LOG = Logger.getLogger(WebUIShell.class.getName());

    private static WebBridge bridge;
    private static WebHttpServer server;

    private WebUIShell() {
    }

    /// 启动桥接服务，返回实际监听端口。
    ///
    /// 端口取 `-Dhmcl.web.http.port`，默认 0（系统分配）。
    /// token 取 `-Dhmcl.web.token`，为空则不校验（只用于本地开发）。
    public static int start() throws IOException {
        if (server != null) {
            return server.port();
        }

        int port = Integer.getInteger("hmcl.web.http.port", 0);
        String token = System.getProperty("hmcl.web.token", "");

        // engine 和 page 都为 null：输出走 channel，页面由外部浏览器内核负责
        bridge = new WebBridge(null, null);
        server = WebHttpServer.start(port, token);
        server.setBridge(bridge);
        bridge.setChannel(server);

        // 皮肤预览要一块独立的 JavaFX 画布（页面在壳里，WebUIPage 不存在）。
        // 必须在 FX 线程创建，否则 Scene 绑不上 Toolkit。
        javafx.application.Platform.runLater(() -> {
            bridge.setOffscreenPreview(new OffscreenPreview());
            bridge.setSkinGallery(new SkinGallery());
        });

        LOG.info("Tauri shell mode: HTTP bridge listening on 127.0.0.1:" + server.port());
        return server.port();
    }

    public static void stop() {
        WebHttpServer s = server;
        server = null;
        bridge = null;
        if (s != null) {
            try {
                s.close();
            } catch (Exception e) {
                LOG.log(Level.WARNING, "关闭 HTTP 桥失败", e);
            }
        }
    }

    /// 由壳进程通过 `POST /api/quit` 触发，走正常退出流程（保存配置、关单例锁）
    public static void requestExit() {
        LOG.info("Tauri shell requested exit");
        javafx.application.Platform.runLater(() -> {
            stop();
            // 退出清理必须在这里跑完：下面那个 halt 兜底一旦抢先，
            // 日志不压缩、旧日志不裁剪（实测日志目录堆了 56 个 .log 就是这个原因）。
            try {
                org.jackhuang.hmcl.util.logging.Logger.LOG.exitAndFlush();
            } catch (Throwable e) {
                System.err.println("退出清理失败: " + e);
            }
            javafx.application.Platform.exit();
            System.exit(0);
        });
        // 压缩大日志可能要十几秒，兜底给足时间；正常路径早就 exit 了，走不到这里
        new Thread(() -> {
            try {
                Thread.sleep(20000);
            } catch (InterruptedException ignored) {
            }
            Runtime.getRuntime().halt(0);
        }, "hmcl-exit-watchdog").start();
    }
}
