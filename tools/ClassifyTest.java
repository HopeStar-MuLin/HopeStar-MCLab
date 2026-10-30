import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;

/** 验证皮肤/披风判定规则：直接用那两张样例图跑一遍。 */
public final class ClassifyTest {

    static double opaqueRatio(BufferedImage img, int x, int y, int w, int h) {
        int total = 0, opaque = 0;
        int maxX = Math.min(x + w, img.getWidth());
        int maxY = Math.min(y + h, img.getHeight());
        for (int j = y; j < maxY; j++) {
            for (int i = x; i < maxX; i++) {
                total++;
                if (((img.getRGB(i, j) >>> 24) & 0xFF) > 8) {
                    opaque++;
                }
            }
        }
        return total == 0 ? 0 : (double) opaque / total;
    }

    static String classify(File file) throws Exception {
        BufferedImage img = ImageIO.read(file);
        if (img == null) return "unknown";
        int w = img.getWidth(), h = img.getHeight();
        if (w == 22 && h == 17) return "cape";
        if (w == 64 && (h == 32 || h == 64)) {
            double capeArea = opaqueRatio(img, 0, 0, 22, 17);
            double all = opaqueRatio(img, 0, 0, w, h);
            System.out.printf("  %dx%d capeArea=%.3f all=%.3f%n", w, h, capeArea, all);
            return capeArea > 0.9 && all < 0.5 ? "cape" : "skin";
        }
        return "unknown";
    }

    public static void main(String[] args) throws Exception {
        for (String a : args) {
            File f = new File(a);
            System.out.println(f.getName() + " => " + classify(f));
        }
    }
}
