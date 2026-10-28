package webshell;

import javafx.animation.PauseTransition;
import javafx.application.Application;
import javafx.application.Platform;
import javafx.concurrent.Worker;
import javafx.scene.Scene;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.stage.Stage;
import javafx.stage.StageStyle;
import javafx.util.Duration;
import netscape.javascript.JSObject;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Locale;

/**
 * 最小可运行的 JavaFX WebView 外壳。
 *
 * <p>用途：验证「HMCL core + WebView 前端」这套架构的可行性，以及 JavaFX 21.0.13
 * 自带 WebKit 625.1 的实际能力（CSS Grid / flex gap / backdrop-filter / :has() 等）。
 *
 * <p>运行：见 build.sh。加 -Dsmoke=true 会在页面加载完成后打印能力自检结果并退出，
 * 用于无人值守验证。
 */
public final class WebShell extends Application {

    private static final String START_PAGE = "/ui/index.html";

    private Stage stage;
    private WebView webView;
    private WebEngine engine;

    @Override
    public void start(Stage stage) {
        this.stage = stage;

        webView = new WebView();
        engine = webView.getEngine();
        engine.setJavaScriptEnabled(true);

        // 关掉右键菜单和拖拽选择，贴近桌面应用观感
        webView.setContextMenuEnabled(false);

        Scene scene = new Scene(webView, 1180, 760);
        stage.initStyle(StageStyle.UNDECORATED);
        stage.setTitle("WebUI Shell");
        stage.setMinWidth(960);
        stage.setMinHeight(640);
        stage.setScene(scene);

        engine.getLoadWorker().stateProperty().addListener((obs, oldState, newState) -> {
            if (newState == Worker.State.SUCCEEDED) {
                onPageLoaded();
            } else if (newState == Worker.State.FAILED) {
                System.err.println("PAGE LOAD FAILED: " + engine.getLocation());
                if (Boolean.getBoolean("smoke")) {
                    Platform.exit();
                }
            }
        });

        engine.load(getClass().getResource(START_PAGE).toExternalForm());
        stage.show();
    }

    private void onPageLoaded() {
        JSObject window = (JSObject) engine.executeScript("window");
        window.setMember("nativeBridge", new Bridge());

        // 页面侧用这个事件判断桥是否就绪，避免时序问题
        engine.executeScript("document.dispatchEvent(new Event('native-ready'))");

        if (Boolean.getBoolean("smoke")) {
            String theme = System.getProperty("theme");
            if (theme != null && !theme.isBlank()) {
                engine.executeScript("document.body.setAttribute('data-theme', '" + theme + "')");
            }

            // 让页面渲染一帧再取自检结果；-Dshot=<path> 时顺便截图存盘，用于无人值守验收
            PauseTransition delay = new PauseTransition(Duration.millis(1200));
            delay.setOnFinished(e -> {
                Object result = engine.executeScript("JSON.stringify(window.__diagnostics || {})");
                System.out.println("DIAGNOSTICS " + result);

                String shot = System.getProperty("shot");
                if (shot != null && !shot.isBlank()) {
                    try {
                        savePng(webView.snapshot(null, null), Path.of(shot));
                        System.out.println("SHOT " + shot);
                    } catch (IOException ex) {
                        System.err.println("SHOT FAILED: " + ex);
                    }
                }

                System.out.println("SMOKE OK");
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
        ImageIO.write(buffered, "png", path.toFile());
    }

    /**
     * 暴露给 JS 的桥。方法必须是 public，参数/返回值只支持基本类型与 String。
     */
    public final class Bridge {
        private double dragMouseX;
        private double dragMouseY;
        private double dragStageX;
        private double dragStageY;

        private double resizeMouseX;
        private double resizeMouseY;
        private double resizeWidth;
        private double resizeHeight;

        public String getState() {
            // 真实项目里这里换成 HMCL 的 ProfileManager / Accounts 序列化结果
            return """
                    {
                      "user": {"name": "Steve", "type": "Microsoft", "uuid": "069a79f444e94726a5befca90e38aaf5"},
                      "selectedInstance": "1.21.1-fabric",
                      "versions": [
                        {"id":"1.21.1-fabric","name":"1.21.1","loader":"Fabric 0.16.5","java":"21","lastPlayed":"今天 14:02","size":"1.2 GB","icon":"grass"},
                        {"id":"1.20.1-forge","name":"1.20.1","loader":"Forge 47.2.0","java":"17","lastPlayed":"昨天","size":"980 MB","icon":"stone"},
                        {"id":"1.12.2-forge","name":"1.12.2","loader":"Forge 14.23.5","java":"8","lastPlayed":"3 天前","size":"640 MB","icon":"dirt"},
                        {"id":"1.21.4-vanilla","name":"1.21.4","loader":"原版","java":"21","lastPlayed":"从未启动","size":"420 MB","icon":"sand"}
                      ],
                      "news": [
                        {"title":"Fabric 0.16.6 已发布","desc":"修复了 1.21.1 上的启动崩溃问题","time":"2 小时前"},
                        {"title":"BMCLAPI 镜像恢复","desc":"版本清单下载已恢复正常速度","time":"昨天"}
                      ]
                    }
                    """;
        }

        public void launch(String id) {
            System.out.println("[bridge] launch requested: " + id);
            // 真实实现：ProfileManager.getProfile(id) -> launcherHelper.launch(...)
        }

        public void minimize() {
            stage.setIconified(true);
        }

        public void toggleMaximize() {
            stage.setMaximized(!stage.isMaximized());
        }

        public void close() {
            Platform.exit();
        }

        public void dragStart(double screenX, double screenY) {
            dragMouseX = screenX;
            dragMouseY = screenY;
            dragStageX = stage.getX();
            dragStageY = stage.getY();
        }

        public void dragMove(double screenX, double screenY) {
            if (stage.isMaximized()) {
                return;
            }
            stage.setX(dragStageX + (screenX - dragMouseX));
            stage.setY(dragStageY + (screenY - dragMouseY));
        }

        public void resizeStart(double screenX, double screenY) {
            resizeMouseX = screenX;
            resizeMouseY = screenY;
            resizeWidth = stage.getWidth();
            resizeHeight = stage.getHeight();
        }

        public void resizeMove(double screenX, double screenY) {
            double width = Math.max(stage.getMinWidth(), resizeWidth + (screenX - resizeMouseX));
            double height = Math.max(stage.getMinHeight(), resizeHeight + (screenY - resizeMouseY));
            stage.setWidth(width);
            stage.setHeight(height);
        }

        public void log(String message) {
            System.out.println("[js] " + message);
        }

        public String platform() {
            return System.getProperty("os.name") + " / Java " + System.getProperty("java.version")
                    + " / " + Locale.getDefault();
        }
    }

    public static void main(String[] args) {
        launch(args);
    }
}
