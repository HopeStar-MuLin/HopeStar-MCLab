import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.File;

public class PixelCheck {
    public static void main(String[] args) throws Exception {
        BufferedImage img = ImageIO.read(new File(args[0]));
        System.out.println("size " + img.getWidth() + "x" + img.getHeight());
        int[][] pts = {{2, 2}, {80, 100}, {160, 200}, {90, 30}};
        for (int[] p : pts) {
            if (p[0] >= img.getWidth() || p[1] >= img.getHeight()) continue;
            int argb = img.getRGB(p[0], p[1]);
            System.out.printf("(%d,%d) A=%d R=%d G=%d B=%d%n", p[0], p[1],
                    (argb >> 24) & 0xff, (argb >> 16) & 0xff, (argb >> 8) & 0xff, argb & 0xff);
        }
    }
}
