package webshell;

import javafx.application.Application;
import javafx.application.Platform;
import javafx.scene.AmbientLight;
import javafx.scene.Group;
import javafx.scene.PerspectiveCamera;
import javafx.scene.Scene;
import javafx.scene.SceneAntialiasing;
import javafx.scene.SubScene;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.paint.Color;
import javafx.scene.paint.PhongMaterial;
import javafx.scene.transform.Rotate;
import javafx.scene.transform.Translate;
import javafx.stage.Stage;
import org.jackhuang.hmcl.ui.skin.ElytraModel;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 隔离测试：只渲染 ElytraModel，判断几何本体有没有问题。
 */
public final class SkinTest extends Application {

    @Override
    public void start(Stage stage) throws Exception {
        Group root = new Group();
        root.getChildren().add(new AmbientLight(Color.WHITE));

        ElytraModel elytra = new ElytraModel();
        elytra.setVisible(true);

        Path texture = Path.of(System.getProperty("texture", "E:/MCLab/.hmcl-demo/appearance/capes/cape-deepblue.elytra.png"));
        try (InputStream in = Files.newInputStream(texture)) {
            Image image = new Image(in);
            System.out.println("[test] texture " + (int) image.getWidth() + "x" + (int) image.getHeight() + " error=" + image.isError());
            elytra.setTexture(image);
        }

        // 与 SkinCanvas 中 capeGroup 相同的定位与旋转
        elytra.setTranslateY(2);
        elytra.setTranslateZ(-4);
        elytra.getTransforms().addAll(new Rotate(180, Rotate.Y_AXIS), new Rotate(10, Rotate.X_AXIS));
        root.getChildren().add(elytra);

        PerspectiveCamera camera = new PerspectiveCamera(true);
        camera.getTransforms().addAll(
                new Rotate(180, Rotate.Y_AXIS),
                new Translate(0, 0, -60));

        SubScene subScene = new SubScene(root, 360, 360, true, SceneAntialiasing.BALANCED);
        subScene.setCamera(camera);
        subScene.setFill(Color.WHITE);

        Scene scene = new Scene(new Group(subScene), 360, 360);
        stage.setScene(scene);
        stage.show();

        Platform.runLater(() -> {
            try {
                Image shot = scene.snapshot(null);
                int w = (int) shot.getWidth();
                int h = (int) shot.getHeight();
                BufferedImage buffered = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                PixelReader reader = shot.getPixelReader();
                for (int y = 0; y < h; y++) {
                    for (int x = 0; x < w; x++) {
                        buffered.setRGB(x, y, reader.getArgb(x, y));
                    }
                }
                ImageIO.write(buffered, "png", Path.of("E:/MCLab/docs/shot-elytra-test.png").toFile());
                System.out.println("[test] snapshot written");
            } catch (Exception e) {
                System.out.println("[test] snapshot failed: " + e);
            }
            Platform.exit();
        });
    }

    public static void main(String[] args) {
        launch(args);
    }
}
