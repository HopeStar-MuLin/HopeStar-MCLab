/*
 * HopeStar-MCLab
 *
 * 正版账号纹理的本地缓存。
 *
 * 为什么需要它：Mojang 的皮肤/披风是两次网络往返才拿得到的（profile → textures → PNG），
 * 启动后到纹理到手之间有一段空窗期。以前这段时间头像只能用兜底皮肤，
 * 用户看到的就是「一个不是我的头像」。缓存之后启动直接读盘，头像永远是真实的。
 *
 * 缓存策略（对应「首次登录缓存、换皮肤刷新、启动校验」三条要求）：
 *   1. 纹理到手就按 MD5 比对；和磁盘上的一样就什么都不做（静默忽略）。
 *   2. 不一样才重写文件——这同时覆盖了「首次登录」和「用户换了皮肤」两种情况，
 *      不需要额外的开关。
 *   3. 启动时先读盘顶上，网络结果回来后再走第 1 步。
 */

package org.jackhuang.hmcl.ui.web;

import com.google.gson.JsonObject;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.Nullable;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import javax.imageio.ImageIO;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

public final class AccountTextureCache {

    private static final AccountTextureCache INSTANCE = new AccountTextureCache();

    public static AccountTextureCache getInstance() {
        return INSTANCE;
    }

    /// 磁盘上缓存的一份纹理。skin 为 null 表示这个账号还没缓存过。
    public record Cached(@Nullable Image skin, boolean slim, @Nullable Image cape,
                         String skinHash, String capeHash) {
    }

    private final Path root = Metadata.HMCL_USER_HOME.resolve("appearance").resolve("texture-cache");

    /// accountId -> 当前已知的哈希。存内存一份，省掉每次读盘。
    private final Map<String, String> skinHashes = new ConcurrentHashMap<>();
    private final Map<String, String> capeHashes = new ConcurrentHashMap<>();
    /// accountId -> 上次 touch 的时间，避免一次 push 里反复写 meta
    private final Map<String, Long> touchedAt = new ConcurrentHashMap<>();

    private AccountTextureCache() {
    }

    /// 账号 id 里带 `account:` 前缀和 UUID，直接当文件名不合适
    private static String fileKey(String accountId) {
        String id = accountId == null ? "none" : accountId;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            // 只留字母数字和下划线，其余（冒号、连字符）统一换成下划线
            sb.append(Character.isLetterOrDigit(c) ? c : '_');
        }
        return sb.toString();
    }

    private Path skinFile(String accountId) {
        return root.resolve(fileKey(accountId) + "-skin.png");
    }

    private Path capeFile(String accountId) {
        return root.resolve(fileKey(accountId) + "-cape.png");
    }

    private Path metaFile(String accountId) {
        return root.resolve(fileKey(accountId) + "-meta.json");
    }

    /// 读盘。没有缓存或读失败都返回 null，调用方按「没缓存」处理。
    public @Nullable Cached load(String accountId) {
        if (accountId == null) {
            return null;
        }
        Path skin = skinFile(accountId);
        if (!Files.isRegularFile(skin)) {
            return null;
        }
        try {
            Image skinImage = new Image(Files.newInputStream(skin));
            if (skinImage.isError() || skinImage.getWidth() <= 0) {
                return null;
            }
            Image capeImage = null;
            Path cape = capeFile(accountId);
            if (Files.isRegularFile(cape)) {
                capeImage = new Image(Files.newInputStream(cape));
                if (capeImage.isError()) {
                    capeImage = null;
                }
            }
            JsonObject meta = readMeta(accountId);
            String skinHash = safeString(meta, "skinHash");
            String capeHash = safeString(meta, "capeHash");
            boolean slim = meta.has("slim") && meta.get("slim").getAsBoolean();
            skinHashes.put(accountId, skinHash);
            capeHashes.put(accountId, capeHash);
            return new Cached(skinImage, slim, capeImage, skinHash, capeHash);
        } catch (Exception e) {
            LOG.warning("Failed to read cached account texture for " + accountId, e);
            return null;
        }
    }

    /// 皮肤是否变了。变了才写盘，返回 true。
    ///
    /// 模型也算在内：同一张皮肤从宽体切成纤体，纹理没变但要重新上传，
    /// 所以这里不能只看 MD5。
    public boolean storeSkin(String accountId, Image image, boolean slim) {
        if (accountId == null || image == null) {
            return false;
        }
        byte[] png = encodePng(image);
        if (png == null) {
            return false;
        }
        String hash = md5(png);
        boolean modelChanged = isSlim(accountId) != slim;
        if (hash.equals(skinHashes.get(accountId)) && !modelChanged) {
            return false;   // 一模一样，什么都不做
        }
        try {
            Files.createDirectories(root);
            Path target = skinFile(accountId);
            Path temp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(temp, png);
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);

            JsonObject meta = readMeta(accountId);
            meta.addProperty("skinHash", hash);
            meta.addProperty("slim", slim);
            meta.addProperty("fetchedAt", System.currentTimeMillis());
            writeMeta(accountId, meta);

            skinHashes.put(accountId, hash);
            return true;
        } catch (Exception e) {
            LOG.warning("Failed to cache account skin for " + accountId, e);
            return false;
        }
    }

    /// 披风同理。没有披风传 null，会把缓存文件删掉。
    public boolean storeCape(String accountId, @Nullable Image image) {
        if (accountId == null) {
            return false;
        }
        if (image == null) {
            String known = capeHashes.get(accountId);
            if (known == null || known.isEmpty()) {
                return false;
            }
            capeHashes.put(accountId, "");
            try {
                Files.deleteIfExists(capeFile(accountId));
                JsonObject meta = readMeta(accountId);
                meta.addProperty("capeHash", "");
                writeMeta(accountId, meta);
            } catch (IOException e) {
                LOG.warning("Failed to drop cached cape for " + accountId, e);
            }
            return true;
        }

        byte[] png = encodePng(image);
        if (png == null) {
            return false;
        }
        String hash = md5(png);
        if (hash.equals(capeHashes.get(accountId))) {
            return false;
        }
        try {
            Files.createDirectories(root);
            Path target = capeFile(accountId);
            Path temp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(temp, png);
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);

            JsonObject meta = readMeta(accountId);
            meta.addProperty("capeHash", hash);
            meta.addProperty("fetchedAt", System.currentTimeMillis());
            writeMeta(accountId, meta);

            capeHashes.put(accountId, hash);
            return true;
        } catch (Exception e) {
            LOG.warning("Failed to cache account cape for " + accountId, e);
            return false;
        }
    }

    /// 记一笔「刚刚从服务器验证过」。
    ///
    /// <p>只在内容和磁盘一致时才需要单独调：`storeSkin` 里内容没变就直接 return 了，
    /// 时间戳不会往前走，结果 24 小时后又白拉一次。所以拉到纹理之后无论变没变都要 touch 一下。
    ///
    /// <p>30 秒内重复调用直接忽略 —— 一次 push 可能连着走好几条路径，没必要反复写盘。
    public void touch(String accountId) {
        if (accountId == null) {
            return;
        }
        long now = System.currentTimeMillis();
        Long last = touchedAt.get(accountId);
        if (last != null && now - last < 30_000L) {
            return;
        }
        try {
            JsonObject meta = readMeta(accountId);
            meta.addProperty("fetchedAt", now);
            Files.createDirectories(root);
            writeMeta(accountId, meta);
            touchedAt.put(accountId, now);
        } catch (Exception e) {
            LOG.warning("Failed to touch account texture cache for " + accountId, e);
        }
    }

    /// 上次从服务器拉到这个账号纹理的时间（毫秒）。0 表示不知道 / 没记录。
    public long fetchedAt(String accountId) {
        if (accountId == null) {
            return 0L;
        }
        JsonObject meta = readMeta(accountId);
        if (!meta.has("fetchedAt")) {
            return 0L;
        }
        try {
            return meta.get("fetchedAt").getAsLong();
        } catch (Exception e) {
            return 0L;
        }
    }

    /// 缓存是不是还在「新鲜期」内。
    ///
    /// <p>这里判的是**时间**不是内容：24 小时内拉过就算新鲜，不再问服务器。
    /// 这样每次启动少两次网络往返，代价是官网上换了皮肤要等一天才自动更新 ——
    /// 所以皮肤栏那张服务器卡片上留了右键「刷新」。
    public boolean isFresh(String accountId, long hours) {
        long at = fetchedAt(accountId);
        if (at <= 0) {
            return false;
        }
        return System.currentTimeMillis() - at < hours * 3600_000L;
    }

    /// 抹掉时间戳，下次一定重新拉。用户点了「刷新」时用。
    public void forget(String accountId) {
        if (accountId == null) {
            return;
        }
        touchedAt.remove(accountId);
        try {
            JsonObject meta = readMeta(accountId);
            if (meta.has("fetchedAt")) {
                meta.remove("fetchedAt");
                writeMeta(accountId, meta);
            }
        } catch (Exception e) {
            LOG.warning("Failed to forget texture cache time for " + accountId, e);
        }
    }

    /// 缓存里记录的模型是不是纤体。没缓存就是宽体。
    public boolean isSlim(String accountId) {
        JsonObject meta = readMeta(accountId);
        return meta.has("slim") && meta.get("slim").getAsBoolean();
    }

    /// 用户主动换了模型之后，把缓存里的模型位同步过去。
    /// 不然下次启动读盘还是旧模型，皮肤会「自己变回宽体」。
    public void updateSlim(String accountId, boolean slim) {
        if (accountId == null) {
            return;
        }
        try {
            Files.createDirectories(root);
            JsonObject meta = readMeta(accountId);
            meta.addProperty("slim", slim);
            writeMeta(accountId, meta);
        } catch (Exception e) {
            LOG.warning("Failed to update cached model for " + accountId, e);
        }
    }

    private JsonObject readMeta(String accountId) {
        Path file = metaFile(accountId);
        if (!Files.isRegularFile(file)) {
            return new JsonObject();
        }
        try {
            return JsonUtils.fromNonNullJson(Files.readString(file), JsonObject.class);
        } catch (Exception e) {
            return new JsonObject();
        }
    }

    private void writeMeta(String accountId, JsonObject meta) throws IOException {
        Path file = metaFile(accountId);
        Path temp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(temp, JsonUtils.GSON.toJson(meta));
        Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
    }

    private static String safeString(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
    }

    /// 编码成 PNG 字节。不能直接拿 Image 算哈希：同一个纹理重新解码出来的
    /// Image 对象不同，但像素一样，哈希必须落在字节上才对得上。
    static byte @Nullable [] encodePng(Image image) {
        int width = Math.max(1, (int) image.getWidth());
        int height = Math.max(1, (int) image.getHeight());
        BufferedImage buffered = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        if (reader != null) {
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    buffered.setRGB(x, y, reader.getArgb(x, y));
                }
            }
        }
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            ImageIO.write(buffered, "png", out);
            return out.toByteArray();
        } catch (IOException e) {
            LOG.warning("Failed to encode texture", e);
            return null;
        }
    }

    /// 从字节解回 Image。上传模型变更时要用原始纹理，从缓存文件读回来最省事。
    static @Nullable Image decodePng(byte[] bytes) {
        try {
            Image image = new Image(new ByteArrayInputStream(bytes));
            return image.isError() ? null : image;
        } catch (Exception e) {
            return null;
        }
    }

    private static String md5(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            return HexFormat.of().formatHex(digest.digest(bytes));
        } catch (Exception e) {
            // 拿不到 MD5 就退化成「每次都算变了」，宁可多写一次盘也不要漏存
            return String.valueOf(System.nanoTime());
        }
    }
}
