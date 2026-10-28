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
import javafx.geometry.Rectangle2D;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.layout.Pane;
import javafx.scene.layout.StackPane;
import org.jackhuang.hmcl.ui.skin.SkinCanvas;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.stage.Screen;
import javafx.stage.Stage;
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
    /// 渲染区固定 4:5 竖长方形，和前端 .preview-slot 的 aspect-ratio 一致，
    /// 这样人物在卡片里不会上下留大片空白。分辨率取 2 倍常用尺寸，缩小后边缘更干净。
    private static final double PREVIEW_WIDTH = 340;
    private static final double PREVIEW_HEIGHT = 425;

    private final SkinCanvas preview = new SkinCanvas(
            org.jackhuang.hmcl.game.TexturesLoader.getDefaultSkinImage(), PREVIEW_WIDTH, PREVIEW_HEIGHT, true);
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

        getChildren().setAll(previewLayer, webView);

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

    /// 在页面里造一个持续 3 秒的位移动画，用 requestAnimationFrame 采样帧间隔。
    ///
    /// <p>只动 `transform`：这是唯一能走合成层、不触发布局的属性。
    /// 如果这里都跑不到 55fps，说明瓶颈在 WebView 的软件光栅，而不是我们写的 CSS。
    private void measureFrameRate() {
        String probe = """
                (function(){
                  var d = document.createElement('div');
                  d.style.cssText = 'position:fixed;left:0;top:0;width:120px;height:120px;'
                    + 'border-radius:24px;background:linear-gradient(135deg,#5b7cfa,#8f6bff);'
                    + 'opacity:.5;z-index:9999;pointer-events:none;will-change:transform';
                  document.body.appendChild(d);
                  var t0 = 0, last = 0, frames = 0, worst = 0, sum = 0;
                  function tick(t){
                    if (!t0) { t0 = t; last = t; }
                    var dt = t - last; last = t; frames++; sum += dt;
                    if (dt > worst) worst = dt;
                    d.style.transform = 'translate(' + (Math.sin(t/300)*200+240) + 'px,120px)';
                    if (t - t0 < 3000) { requestAnimationFrame(tick); }
                    else {
                      window.__fps = { avg: +(frames/((t-t0)/1000)).toFixed(1),
                                       worst: +worst.toFixed(1), meanGap: +(sum/frames).toFixed(2) };
                      d.remove();
                    }
                  }
                  requestAnimationFrame(tick);
                })();
                """;
        webView.getEngine().executeScript(probe);

        var report = new PauseTransition(Duration.millis(4200));
        report.setOnFinished(event -> {
            Object result = webView.getEngine().executeScript(
                    "window.__fps ? JSON.stringify(window.__fps) : 'null'");
            LOG.info("Web UI frame rate: " + result);
            System.out.println("WEB FPS " + result);
        });
        report.play();
    }

    /// 设计尺寸：窗口默认按这个尺寸开，屏幕装不下时按比例收。
    private static final double DESIGN_WIDTH = 1280;
    private static final double DESIGN_HEIGHT = 860;
    /// 最小尺寸：只保证「不超屏」，不跟着 0.92 一起折减
    private static final double MIN_WIDTH = 960;
    private static final double MIN_HEIGHT = 640;

    /// 按屏幕可用区（{@link Screen#getVisualBounds()}，已排除任务栏）决定窗口尺寸并居中。
    ///
    /// <p>JavaFX 的屏幕坐标本身就是逻辑像素，不需要像 Tauri 那样再除一次 scale factor；
    /// 直接用 `Math.min(设计尺寸, 可用区 * 0.92)` 就够。
    ///
    /// <p>两处容易踩的坑：
    /// <ul>
    ///   <li>不能用 {@code getBounds()}（含任务栏），低分屏上会正好顶到任务栏底下；</li>
    ///   <li>最小尺寸不能也乘 0.92，否则 960×640 会被折成 883×589，
    ///       用户能拖到比设计最小还小，布局就塌了。</li>
    /// </ul>
    public static void fitWindowToScreen(Stage stage) {
        Rectangle2D area = Screen.getPrimary().getVisualBounds();

        double minWidth = Math.min(MIN_WIDTH, area.getWidth() * 0.98);
        double minHeight = Math.min(MIN_HEIGHT, area.getHeight() * 0.98);
        stage.setMinWidth(minWidth);
        stage.setMinHeight(minHeight);

        double width = Math.max(minWidth, Math.min(DESIGN_WIDTH, area.getWidth() * 0.92));
        double height = Math.max(minHeight, Math.min(DESIGN_HEIGHT, area.getHeight() * 0.92));

        stage.setWidth(width);
        stage.setHeight(height);
        stage.setX(area.getMinX() + (area.getWidth() - width) / 2);
        stage.setY(area.getMinY() + (area.getHeight() - height) / 2);

        LOG.info(String.format("Web UI window: %.0fx%.0f (min %.0fx%.0f, screen %.0fx%.0f)",
                width, height, minWidth, minHeight, area.getWidth(), area.getHeight()));
    }

    private void pushLater() {
        Platform.runLater(bridge::push);
    }

    private void onLoaded() {
        JSObject window = (JSObject) webView.getEngine().executeScript("window");
        window.setMember("nativeBridge", bridge);

        // 帧率探针：-Dhmcl.web.fps=true 时在页面里跑一段持续动画，统计 rAF 间隔，
        // 用来判断「卡」到底是动画本身的成本，还是渲染管线的问题（而不是凭感觉猜）
        if (Boolean.getBoolean("hmcl.web.fps")) {
            measureFrameRate();
        }

        // 让前端知道桥已经挂上，避免时序竞争
        webView.getEngine().executeScript("document.dispatchEvent(new Event('native-ready'))");

        // 验收/调试用的现场覆盖（切页、主题、侧栏、注入脚本）与截图无关，
        // 所以放在截图分支外面：不带 -Dhmcl.web.shot 也能用来手动触发安装、登录这些路径
        applyOverrides();

        String shot = System.getProperty("hmcl.web.shot");
        if (shot == null || shot.isBlank()) {
            return;
        }

        // 截图模式把窗口调到指定尺寸，避免默认窗口太窄看不出布局
        if (getScene() != null && getScene().getWindow() instanceof Stage stage) {
            String size = System.getProperty("hmcl.web.size", "1366x768");
            String[] parts = size.split("x");
            stage.setWidth(Integer.parseInt(parts[0].trim()));
            stage.setHeight(Integer.parseInt(parts[1].trim()));
        }

        // 等待时长可调：异步拉清单/加载器列表的验收需要更长的窗口
        long waitMs = 4500;
        try {
            waitMs = Long.parseLong(System.getProperty("hmcl.web.delay", "4500"));
        } catch (NumberFormatException ignored) {
        }
        PauseTransition delay = new PauseTransition(Duration.millis(waitMs));
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

    /// 应用 `-Dhmcl.web.*` 指定的现场覆盖。全部可选，缺省即正常界面。
    private void applyOverrides() {
        WebEngine engine = webView.getEngine();

        String scroll = System.getProperty("hmcl.web.scroll");
        if (scroll != null && !scroll.isBlank()) {
            engine.executeScript(
                    "var c = document.getElementById('page-body'); if (c) c.scrollTop = " + scroll + ";");
        }

        String page = System.getProperty("hmcl.web.page");
        if (page != null && !page.isBlank()) {
            // 账号页没有侧栏入口，走左下角账号卡
            String selector = "accounts".equals(page)
                    ? "#account-chip"
                    : ".rail-nav .rail-item[data-page=\"" + page + "\"]";
            Object switched = engine.executeScript(
                    "(function(){var n=document.querySelector('" + selector + "');"
                            + "if(!n) return 'no-nav'; n.click();"
                            + "return document.querySelector('.page.on').id;})()");
            System.out.println("WEB PAGE -> " + switched);
        }

        String tab = System.getProperty("hmcl.web.tab");
        if (tab != null && !tab.isBlank()) {
            Object clicked = engine.executeScript(
                    "(function(){var t=document.querySelector('.tab[data-tab=\"" + tab + "\"]');"
                            + "if(!t) return 'no-tab'; t.click(); return t.textContent;})()");
            System.out.println("WEB TAB -> " + clicked);
        }

        String theme = System.getProperty("hmcl.web.theme");
        if (theme != null && !theme.isBlank()) {
            // 同时写进 localStorage：否则随后推来的 state.theme 会把强制主题覆盖回去
            String t = org.jackhuang.hmcl.util.gson.JsonUtils.GSON.toJson(theme);
            engine.executeScript(
                    "(function(){try{localStorage.setItem('mclab.theme'," + t + ")}catch(e){}"
                            + "document.body.setAttribute('data-theme'," + t + ");})()");
        }

        String rail = System.getProperty("hmcl.web.rail");
        if (rail != null && !rail.isBlank()) {
            engine.executeScript("document.body.classList.toggle('rail-open', "
                    + ("open".equals(rail)) + ")");
        }

        // 注入任意脚本：验证需要点击才能走到的地方（安装、登录、导入…）
        String js = System.getProperty("hmcl.web.js");
        if (js != null && !js.isBlank()) {
            try {
                System.out.println("WEB JS -> " + engine.executeScript(js));
            } catch (Exception e) {
                System.out.println("WEB JS FAILED -> " + e);
            }
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

    /// 把 3D 预览渲染成 PNG data URL 交给前端。
    ///
    /// 早期版本是把 JavaFX 画布直接盖在 WebView 上按矩形对位，但页面滚动、换行、缩放
    /// 都会让两套坐标错开（人物被卡片裁掉、浮到别的内容上）。改成出图后，位置完全由 CSS 决定。
    String snapshotPreview() {
        try {
            // 画布被 WebView 盖在下面，用户看不见；但快照要求节点在场景里且可见，
            // 连同父容器一起点亮，否则截出来是空白（踩过：离开外观页时父容器被隐藏，
            // 再回来预览就一直空白）。
            previewLayer.setVisible(true);
            preview.setVisible(true);

            // 必须显式指定透明填充：SnapshotParameters 默认是白底，
            // 暗色主题下预览就成了一块刺眼的白方块（截图里能看到）。
            var params = new javafx.scene.SnapshotParameters();
            params.setFill(javafx.scene.paint.Color.TRANSPARENT);
            Image image = preview.snapshot(params, null);
            return WebBridge.imageToDataUrl(image, (int) PREVIEW_WIDTH);
        } catch (Exception e) {
            LOG.warning("Failed to snapshot skin preview", e);
            return null;
        }
    }

    /// 预览以图片形式呈现，画布本身不需要显示/隐藏，这里保留空实现兼容旧调用
    void hidePreview() {
    }

    SkinCanvas getPreviewCanvas() {
        return preview;
    }

    @Override
    public ReadOnlyObjectProperty<State> stateProperty() {
        return state.getReadOnlyProperty();
    }
}
