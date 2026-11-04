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
import javafx.stage.Stage;
import org.jackhuang.hmcl.ui.Controllers;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

/// 自绘标题栏：最小化 / 最大化 / 关闭 / 拖动 / 八向缩放。
///
/// <p>从 [WebBridge] 拆出来的第三块。前端标题栏是 HTML 画的，这些动作要落到真实的
/// Stage 上；壳模式下 `Controllers.getStage()` 可能为 null，此时全部空转。
@NotNullByDefault
public final class WindowApi {

    WindowApi() {
    }

    // ==================== 窗口（自绘标题栏） ====================

    private double dragMouseX;
    private double dragMouseY;
    private double dragStageX;
    private double dragStageY;

    private double resizeMouseX;
    private double resizeMouseY;
    private double resizeWidth;
    private double resizeHeight;
    private String resizeEdge = "";

    private static @Nullable Stage stage() {
        return Controllers.getStage();
    }

    public void minimize() {
        Stage stage = stage();
        if (stage != null) {
            stage.setIconified(true);
        }
    }

    public void toggleMaximize() {
        Stage stage = stage();
        if (stage != null) {
            stage.setMaximized(!stage.isMaximized());
        }
    }

    public void close() {
        Platform.exit();
    }

    /// 记录拖拽起点。参数是屏幕坐标（JS 的 e.screenX / e.screenY）
    public void dragStart(double screenX, double screenY) {
        Stage stage = stage();
        if (stage == null) {
            return;
        }
        dragMouseX = screenX;
        dragMouseY = screenY;
        dragStageX = stage.getX();
        dragStageY = stage.getY();
    }

    public void dragMove(double screenX, double screenY) {
        Stage stage = stage();
        if (stage == null || stage.isMaximized() || stage.isFullScreen()) {
            return;
        }
        stage.setX(dragStageX + (screenX - dragMouseX));
        stage.setY(dragStageY + (screenY - dragMouseY));
    }

    /// edge 取值：n / s / e / w / ne / nw / se / sw
    public void resizeStart(double screenX, double screenY, String edge) {
        Stage stage = stage();
        if (stage == null) {
            return;
        }
        dragStageX = stage.getX();
        dragStageY = stage.getY();
        resizeMouseX = screenX;
        resizeMouseY = screenY;
        resizeWidth = stage.getWidth();
        resizeHeight = stage.getHeight();
        resizeEdge = edge != null ? edge : "";
    }

    public void resizeMove(double screenX, double screenY) {
        Stage stage = stage();
        if (stage == null || stage.isMaximized() || resizeEdge.isEmpty()) {
            return;
        }

        double dx = screenX - resizeMouseX;
        double dy = screenY - resizeMouseY;
        double minWidth = stage.getMinWidth() > 0 ? stage.getMinWidth() : 960;
        double minHeight = stage.getMinHeight() > 0 ? stage.getMinHeight() : 640;

        if (resizeEdge.contains("e")) {
            stage.setWidth(Math.max(minWidth, resizeWidth + dx));
        }
        if (resizeEdge.contains("s")) {
            stage.setHeight(Math.max(minHeight, resizeHeight + dy));
        }
        if (resizeEdge.contains("w")) {
            double width = Math.max(minWidth, resizeWidth - dx);
            stage.setX(dragStageX + (resizeWidth - width));
            stage.setWidth(width);
        }
        if (resizeEdge.contains("n")) {
            double height = Math.max(minHeight, resizeHeight - dy);
            stage.setY(dragStageY + (resizeHeight - height));
            stage.setHeight(height);
        }
    }
}
