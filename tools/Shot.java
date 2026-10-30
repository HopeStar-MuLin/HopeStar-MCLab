import java.awt.GraphicsEnvironment;
import java.awt.Rectangle;
import java.awt.Robot;
import java.awt.image.BufferedImage;
import java.io.File;

import javax.imageio.ImageIO;

/// 全屏截图。给 Tauri 壳做视觉验收用（壳本身没有截图 API）。
/// 用法：java Shot.java out.png
public class Shot {
    public static void main(String[] args) throws Exception {
        String out = args.length > 0 ? args[0] : "shot.png";
        Rectangle bounds = GraphicsEnvironment.getLocalGraphicsEnvironment()
                .getDefaultScreenDevice().getDefaultConfiguration().getBounds();
        BufferedImage img = new Robot().createScreenCapture(bounds);
        ImageIO.write(img, "png", new File(out));
        System.out.println("saved " + out + " " + img.getWidth() + "x" + img.getHeight());
    }
}
