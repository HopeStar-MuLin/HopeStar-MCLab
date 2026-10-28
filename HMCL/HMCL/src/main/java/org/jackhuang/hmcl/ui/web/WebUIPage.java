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

import javafx.animation.PauseTransition;
import javafx.application.Platform;
import javafx.beans.property.ReadOnlyObjectProperty;
import javafx.beans.property.ReadOnlyObjectWrapper;
import javafx.collections.ListChangeListener;
import javafx.concurrent.Worker;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.Image;
import javafx.scene.layout.Pane;
import javafx.scene.layout.StackPane;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.util.Duration;
import netscape.javascript.JSObject;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.ui.decorator.DecoratorPage;
import org.jackhuang.hmcl.util.io.FileUtils;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/**
 * 基于 WebView 的主页面。
 *
 * <p>用系统属性 {@code -Dhmcl.ui.web=true} 启用，启用后替换掉原来的 JavaFX 主页，
 * 其余部分（窗口装饰、对话框、Toast、主题、i18n、下载、启动）仍走 HMCL 原实现。
 *
 * <p>调试：{@code -Dhmcl.web.shot=C:\tmp\shot.png} 会在页面加载后截屏并退出，
 * 用于无人值守验收。
 */
public final class WebUIPage extends StackPane implements DecoratorPage {

    private static final String INDEX = "/assets/web/index.html";

    private final ReadOnlyObjectWrapper<State> state =
            new ReadOnlyObjectWrapper<>(new State("", null, false, false, true));

    private final WebView webView = new WebView();
    private final WebBridge bridge;

    /// 外观页的 3D 预览：以覆盖层形式盖在 WebView 上方，位置由前端上报
    private final SkinCanvas preview = new SkinCanvas(
            org.jackhuang.hmcl.game.TexturesLoader.getDefaultSkinImage(), 320, 420, true);
    private final Pane previewLayer = new Pane();

    public WebUIPage() {
        getStyleClass().add("web-ui-page");

        WebEngine engine = webView.getEngine();
        engine.setJavaScriptEnabled(true);
        webView.setContextMenuEnabled(false);
        webView.setMinSize(0, 0);

        bridge = new WebBridge(engine, this);

        preview.setManaged(false);
        preview.setVisible(false);
        preview.enableRotation(0.6);
        previewLayer.getChildren().add(preview);
        previewLayer.setPickOnBounds(false);
        previewLayer.setMouseTransparent(false);

        getChildren().setAll(webView, previewLayer);

        engine.getLoadWorker().stateProperty().addListener((observable, oldState, newState) -> {
            if (newState == Worker.State.SUCCEEDED) {
                onLoaded();
            } else if (newState == Worker.State.FAILED) {
                LOG.warning("Failed to load web UI: " + engine.getLocation());
            }
        });

        var url = WebUIPage.class.getResource(INDEX);
        if (url == null) {
            LOG.warning("Web UI resource not found: " + INDEX);
            return;
        }
        engine.load(url.toExternalForm());

        // 账号/实例变化时推一次完整状态给前端
        Accounts.selectedAccountProperty().addListener((observable, oldValue, newValue) -> pushLater());
        Accounts.getAccounts().addListener((ListChangeListener<Account>) change -> pushLater());
        GameDirectoryManager.selectedInstanceProperty().addListener((observable, oldValue, newValue) -> pushLater());
    }

    private void pushLater() {
        Platform.runLater(bridge::push);
    }

    private void onLoaded() {
        JSObject window = (JSObject) webView.getEngine().executeScript("window");
        window.setMember("nativeBridge", bridge);

        // 让前端知道桥已经挂上，避免时序竞争
        webView.getEngine().executeScript("document.dispatchEvent(new Event('native-ready'))");

        String shot = System.getProperty("hmcl.web.shot");
        if (shot != null && !shot.isBlank()) {
            // 截图模式下把窗口调到设计尺寸，避免默认窗口太窄看不出布局
            if (getScene() != null && getScene().getWindow() instanceof javafx.stage.Stage stage) {
                stage.setWidth(1180);
                stage.setHeight(780);
            }
            String page = System.getProperty("hmcl.web.page");
            if (page != null && !page.isBlank()) {
                // 账号页没有侧栏入口，走左下角账号卡
                String selector = "accounts".equals(page)
                        ? "#account-chip"
                        : ".nav-item[data-page=\"" + page + "\"]";
                Object switched = webView.getEngine().executeScript(
                        "(function(){var n=document.querySelector('" + selector + "');"
                                + "if(!n) return 'no-nav'; n.click();"
                                + "return document.querySelector('.page.active').id;})()");
                System.out.println("WEB PAGE -> " + switched);
            }
            PauseTransition delay = new PauseTransition(Duration.millis(4500));
            delay.setOnFinished(event -> {
                try {
                    savePng(WebUIPage.this.snapshot(null, null), Path.of(shot));
                    System.out.println("WEB SHOT OK " + shot);
                } catch (Exception e) {
                    System.out.println("WEB SHOT FAILED " + e);
                }
                Platform.exit();
            });
            delay.play();
        }
    }

    private static void savePng(Image image, Path path) throws IOException {
        int width = (int) image.getWidth();
        int height = (int) image.getHeight();
        BufferedImage buffered = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        for (int y = 0; y < height; y++) {
            for (int x = 0; x < width; x++) {
                buffered.setRGB(x, y, reader.getArgb(x, y));
            }
        }
        Path parent = path.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        ImageIO.write(buffered, "png", path.toFile());
        LOG.info("Web UI screenshot saved to " + FileUtils.getAbsolutePath(path));
    }

    /// 外观页激活时把 3D 预览摆到前端上报的矩形上；矩形为 CSS 像素，与 JavaFX 逻辑像素一致
    void placePreview(double x, double y, double width, double height) {
        preview.relocate(x, y);
        preview.setVisible(width > 0 && height > 0);
        previewLayer.setVisible(preview.isVisible());
        preview.setScaleX(Math.min(1.0, width / 320.0));
        preview.setScaleY(Math.min(1.0, width / 320.0));
    }

    void hidePreview() {
        preview.setVisible(false);
        previewLayer.setVisible(false);
    }

    SkinCanvas getPreviewCanvas() {
        return preview;
    }

    @Override
    public ReadOnlyObjectProperty<State> stateProperty() {
        return state.getReadOnlyProperty();
    }
}
