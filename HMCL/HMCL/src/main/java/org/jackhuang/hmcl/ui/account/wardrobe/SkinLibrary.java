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
package org.jackhuang.hmcl.ui.account.wardrobe;

import javafx.collections.FXCollections;
import javafx.collections.ObservableList;
import javafx.scene.image.Image;
import javafx.scene.image.PixelReader;
import javafx.scene.image.WritableImage;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.auth.offline.OfflineAccount;
import org.jackhuang.hmcl.auth.offline.Skin;
import org.jackhuang.hmcl.auth.yggdrasil.TextureModel;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.FileUtils;
import org.jackhuang.hmcl.util.skin.NormalizedSkin;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/**
 * 本地皮肤库。
 *
 * <p>存储结构：
 * <pre>
 * ~/.hmcl/skin-library/
 *   index.json          // 元数据
 *   &lt;id&gt;.png           // 原始皮肤文件，id = 文件内容的 SHA-1 前 16 位
 * </pre>
 *
 * <p>入库时保存原始 PNG 字节，不做重编码——上传官方服务器时可以直接用原文件；
 * 只有 HD（&gt;64px）皮肤在上传前才降采样成 64x64，因为 Mojang 的接口只接受 64x32 / 64x64。
 *
 * <p>所有方法都应在 JavaFX 线程调用（除 {@link #apply(Account, Entry)} 返回的 Task 内部逻辑）。
 */
public final class SkinLibrary {

    public static final Path DIRECTORY = Metadata.HMCL_USER_HOME.resolve("skin-library");
    private static final Path INDEX_FILE = DIRECTORY.resolve("index.json");
    private static final String[] EXTENSIONS = {"png"};

    private static final SkinLibrary INSTANCE = new SkinLibrary();

    public static SkinLibrary getInstance() {
        return INSTANCE;
    }

    /**
     * 一条皮肤记录。字段名即 JSON 字段名，不要随意改名，否则旧索引文件读不出来。
     */
    public static final class Entry {
        String id;
        String name;
        String model;   // "slim" | "default"
        long addedAt;
        String source;  // 原始文件名，仅用于展示

        private transient Image cachedImage;

        Entry() {
        }

        Entry(String id, String name, String model, long addedAt, String source) {
            this.id = id;
            this.name = name;
            this.model = model;
            this.addedAt = addedAt;
            this.source = source;
        }

        public String getId() {
            return id;
        }

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public boolean isSlim() {
            return TextureModel.SLIM.modelName.equals(model);
        }

        public TextureModel getTextureModel() {
            return isSlim() ? TextureModel.SLIM : TextureModel.WIDE;
        }

        public long getAddedAt() {
            return addedAt;
        }

        public String getSource() {
            return source;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Entry && Objects.equals(id, ((Entry) o).id);
        }

        @Override
        public int hashCode() {
            return Objects.hashCode(id);
        }
    }

    private static final class Index {
        int version = 1;
        List<Entry> entries = new ArrayList<>();
        Map<String, String> applied = new LinkedHashMap<>();
    }

    private final ObservableList<Entry> entries = FXCollections.observableArrayList();
    private final Map<String, String> applied = new LinkedHashMap<>();

    private SkinLibrary() {
        load();
    }

    // ==== 持久化 ====

    private void load() {
        try {
            Files.createDirectories(DIRECTORY);
        } catch (IOException e) {
            LOG.warning("Failed to create skin library directory " + DIRECTORY, e);
            return;
        }

        if (!Files.isRegularFile(INDEX_FILE)) {
            return;
        }

        try {
            Index index = JsonUtils.fromJson(Files.readString(INDEX_FILE), Index.class);
            if (index == null) {
                return;
            }
            for (Entry entry : index.entries) {
                // 索引里指向的文件被手动删掉了就丢弃这条记录，避免 UI 出现空图
                if (entry.id != null && Files.isRegularFile(fileOf(entry))) {
                    entries.add(entry);
                }
            }
            if (index.applied != null) {
                applied.putAll(index.applied);
            }
        } catch (Exception e) {
            LOG.warning("Failed to load skin library index " + INDEX_FILE, e);
        }
    }

    private void save() {
        Index index = new Index();
        index.entries = new ArrayList<>(entries);
        index.applied = new LinkedHashMap<>(applied);

        try {
            Files.createDirectories(DIRECTORY);
            FileUtils.saveSafely(INDEX_FILE, JsonUtils.GSON.toJson(index));
        } catch (IOException e) {
            LOG.warning("Failed to save skin library index " + INDEX_FILE, e);
        }
    }

    // ==== 查询 ====

    public ObservableList<Entry> getEntries() {
        return entries;
    }

    public Path fileOf(Entry entry) {
        return DIRECTORY.resolve(entry.id + ".png");
    }

    /**
     * 读取皮肤图片，带内存缓存。缓存失效由 {@link #remove(Entry)} 负责。
     */
    public Image imageOf(Entry entry) throws IOException {
        if (entry.cachedImage != null) {
            return entry.cachedImage;
        }
        Path file = fileOf(entry);
        if (!Files.isRegularFile(file)) {
            throw new IOException("Skin file not found: " + file);
        }
        try (InputStream in = Files.newInputStream(file)) {
            Image image = new Image(in);
            if (image.isError()) {
                throw new IOException("Failed to read skin image " + file, image.getException());
            }
            entry.cachedImage = image;
            return image;
        }
    }

    // ==== 修改 ====

    /**
     * 导入一张皮肤。同一张图（内容哈希相同）不会重复入库，直接返回已有记录。
     *
     * @param file 用户选中的 PNG
     * @return 入库后的记录
     * @throws IOException 读取失败或不是合法皮肤
     */
    public Entry importSkin(Path file) throws IOException {
        Objects.requireNonNull(file);

        byte[] bytes = Files.readAllBytes(file);
        String id = sha1(bytes);

        for (Entry existing : entries) {
            if (existing.id.equals(id)) {
                return existing;
            }
        }

        Image image;
        try (InputStream in = Files.newInputStream(file)) {
            image = new Image(in);
        }
        if (image.isError()) {
            throw new IOException("Failed to decode skin image", image.getException());
        }
        if (!isSupportedSize(image)) {
            throw new IOException("Unsupported skin size: " + (int) image.getWidth() + "x" + (int) image.getHeight());
        }

        Path target = DIRECTORY.resolve(id + ".png");
        if (!Files.isRegularFile(target)) {
            Files.createDirectories(DIRECTORY);
            Path tmp = FileUtils.tmpSaveFile(target);
            Files.copy(file, tmp, StandardCopyOption.REPLACE_EXISTING);
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }

        boolean slim;
        try {
            slim = new NormalizedSkin(image).isSlim();
        } catch (Exception e) {
            // NormalizedSkin 对尺寸的要求比我们宽松校验更严，识别失败按宽型处理，不阻断入库
            slim = false;
        }

        String name = FileUtils.getNameWithoutExtension(file);
        if (name.isBlank()) {
            name = "Skin " + id.substring(0, 6);
        }

        Entry entry = new Entry(id, uniqueName(name), slim ? TextureModel.SLIM.modelName : TextureModel.WIDE.modelName,
                System.currentTimeMillis(), FileUtils.getName(file));
        entry.cachedImage = image;

        entries.add(0, entry);
        save();
        return entry;
    }

    public void remove(Entry entry) {
        entries.remove(entry);
        applied.values().removeIf(entry.id::equals);
        // 只有没有其它记录引用同一个 id 时才删文件（正常情况下 id 唯一，这里是兜底）
        boolean stillUsed = entries.stream().anyMatch(it -> it.id.equals(entry.id));
        if (!stillUsed) {
            try {
                Files.deleteIfExists(fileOf(entry));
            } catch (IOException e) {
                LOG.warning("Failed to delete skin file " + fileOf(entry), e);
            }
        }
        entry.cachedImage = null;
        save();
    }

    public void rename(Entry entry, String name) {
        if (name == null || name.isBlank()) {
            return;
        }
        entry.setName(uniqueName(name.trim(), entry));
        save();
    }

    // ==== 应用到账号 ====

    /**
     * 该账号上次应用的皮肤。
     */
    public Entry getApplied(Account account) {
        String id = applied.get(account.getAccountID().toString());
        if (id == null) {
            return null;
        }
        for (Entry entry : entries) {
            if (entry.id.equals(id)) {
                return entry;
            }
        }
        return null;
    }

    /**
     * 把皮肤应用到账号。
     *
     * <p>离线账号写本地路径；正版账号上传到 Mojang（需要有效的 Minecraft access token），
     * 上传后清缓存重新登录，让启动器和游戏看到新皮肤。
     *
     * @return 需要在后台执行的任务
     */
    public Task<Void> apply(Account account, Entry entry) {
        Objects.requireNonNull(account);
        Objects.requireNonNull(entry);

        Path file = fileOf(entry);
        if (!Files.isRegularFile(file)) {
            throw new IllegalStateException("Skin file not found: " + file);
        }

        applied.put(account.getAccountID().toString(), entry.id);
        save();

        if (account instanceof OfflineAccount offlineAccount) {
            return Task.runAsync(() -> {
                Skin old = offlineAccount.getSkin();
                offlineAccount.setSkin(new Skin(
                        Skin.Type.LOCAL_FILE,
                        null,
                        entry.getTextureModel(),
                        file.toString(),
                        old != null ? old.localCapePath() : null));
            });
        }

        if (!account.canUploadSkin()) {
            throw new UnsupportedOperationException("This account does not support skin uploading");
        }

        return Task.runAsync(() -> {
            Path uploadFile = prepareUploadFile(entry, file);
            account.uploadSkin(entry.isSlim(), uploadFile);
            // 服务端纹理缓存要主动失效，否则衣柜预览还是旧图
            account.clearCache();
            account.logIn();
        });
    }

    /**
     * Mojang 只接受 64x32 / 64x64，HD 皮肤先降采样再传。
     */
    private Path prepareUploadFile(Entry entry, Path source) throws IOException {
        Image image;
        try (InputStream in = Files.newInputStream(source)) {
            image = new Image(in);
        }
        if (image.getWidth() == 64 && (image.getHeight() == 32 || image.getHeight() == 64)) {
            return source;
        }

        Path dir = DIRECTORY.resolve("upload");
        Files.createDirectories(dir);
        Path target = dir.resolve(entry.id + "-64.png");

        int w = (int) image.getWidth();
        int h = (int) image.getHeight();
        BufferedImage buffered = new BufferedImage(64, 64, BufferedImage.TYPE_INT_ARGB);
        PixelReader reader = image.getPixelReader();
        for (int y = 0; y < 64; y++) {
            int sy = Math.min(h - 1, y * h / 64);
            for (int x = 0; x < 64; x++) {
                int sx = Math.min(w - 1, x * w / 64);
                buffered.setRGB(x, y, reader.getArgb(sx, sy));
            }
        }
        ImageIO.write(buffered, "png", target.toFile());
        return target;
    }

    // ==== 工具 ====

    private static boolean isSupportedSize(Image image) {
        int w = (int) image.getWidth();
        int h = (int) image.getHeight();
        return w % 64 == 0 && w > 0 && (h == w || h * 2 == w);
    }

    private String uniqueName(String name) {
        return uniqueName(name, null);
    }

    private String uniqueName(String name, Entry self) {
        String candidate = name;
        int index = 2;
        while (true) {
            String current = candidate;
            boolean conflict = entries.stream()
                    .anyMatch(it -> it != self && it.name != null && it.name.equals(current));
            if (!conflict) {
                return candidate;
            }
            candidate = name + " (" + index++ + ")";
        }
    }

    private static String sha1(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            return HexFormat.of().formatHex(digest.digest(bytes)).substring(0, 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * 缩略图：把皮肤图左上角 8x8 的头部区域放大，用于网格显示。
     * 不用整张图缩放——64x64 缩到 32x32 之后五官基本看不清。
     */
    public static Image headImage(Image skin) {
        int unit = Math.max(1, (int) skin.getWidth() / 64);
        WritableImage out = new WritableImage(8 * unit, 8 * unit);
        PixelReader reader = skin.getPixelReader();
        for (int y = 0; y < 8 * unit; y++) {
            for (int x = 0; x < 8 * unit; x++) {
                out.getPixelWriter().setArgb(x, y, reader.getArgb(8 * unit + x, 8 * unit + y));
            }
        }
        return out;
    }
}
