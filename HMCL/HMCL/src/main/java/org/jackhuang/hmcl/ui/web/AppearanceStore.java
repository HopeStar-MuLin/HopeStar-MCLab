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

import javafx.scene.image.Image;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.auth.yggdrasil.TextureModel;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.FileUtils;
import org.jackhuang.hmcl.util.skin.NormalizedSkin;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/**
 * 外观仓库：皮肤、披风（可带独立鞘翅贴图）、按账号保存的选择状态。
 *
 * <pre>
 * %HMCL_HOME%/appearance/
 *   skins/&lt;id&gt;.png          皮肤原图
 *   capes/&lt;id&gt;.png          披风原图
 *   capes/&lt;id&gt;.elytra.png   可选：同一披风附带的鞘翅贴图
 *   skins.json / capes.json  索引
 *   state/&lt;accountID&gt;.json  该账号选中的皮肤、披风、模型、背饰形态
 * </pre>
 *
 * <p>文件按内容哈希去重；任何一张图读失败都只影响它自己，不会让整个外观页崩掉。
 */
public final class AppearanceStore {

    public enum Kind {
        SKIN, CAPE
    }

    public static final class Asset {
        String id;
        String name;
        /// 皮肤专用：slim / default
        String model;
        /// 披风专用：是否带独立鞘翅贴图
        boolean hasElytra;
        /// 随启动器内置的素材（原版 Steve / Alex），不允许删除
        boolean builtin;
        long addedAt;

        private transient Image image;
        private transient Image elytraImage;

        Asset() {
        }

        Asset(String id, String name, String model, boolean hasElytra, long addedAt) {
            this.id = id;
            this.name = name;
            this.model = model;
            this.hasElytra = hasElytra;
            this.addedAt = addedAt;
        }

        Asset(String id, String name, String model, boolean builtin) {
            this.id = id;
            this.name = name;
            this.model = model;
            this.builtin = builtin;
            this.addedAt = 0L;
        }

        public boolean isBuiltin() {
            return builtin;
        }

        public String getId() {
            return id;
        }

        public String getName() {
            return name;
        }

        public String getModel() {
            return model;
        }

        public boolean isHasElytra() {
            return hasElytra;
        }

        public long getAddedAt() {
            return addedAt;
        }
    }

    public static final class State {
        String skin;
        String cape;
        String model;
        String capeMode;

        public State() {
        }

        public State(String skin, String cape, String model, String capeMode) {
            this.skin = skin;
            this.cape = cape;
            this.model = model;
            this.capeMode = capeMode;
        }

        public String getSkin() {
            return skin;
        }

        public String getCape() {
            return cape;
        }

        public String getModel() {
            return model;
        }

        public String getCapeMode() {
            return capeMode;
        }
    }

    private static final class Index {
        int version = 1;
        List<Asset> entries = new ArrayList<>();
    }

    // 目录常量必须声明在 INSTANCE 之前：静态字段按文本顺序初始化，
    // 否则单例构造时 SKIN_DIR 还是 null（已踩过一次，表现为启动即 NPE）。
    public static final Path ROOT = Metadata.HMCL_USER_HOME.resolve("appearance");
    private static final Path SKIN_DIR = ROOT.resolve("skins");
    private static final Path CAPE_DIR = ROOT.resolve("capes");
    private static final Path STATE_DIR = ROOT.resolve("state");

    private static final AppearanceStore INSTANCE = new AppearanceStore();

    public static AppearanceStore getInstance() {
        return INSTANCE;
    }

    private final List<Asset> skins = new ArrayList<>();
    private final List<Asset> capes = new ArrayList<>();

    private AppearanceStore() {
        try {
            Files.createDirectories(SKIN_DIR);
            Files.createDirectories(CAPE_DIR);
            Files.createDirectories(STATE_DIR);
        } catch (IOException e) {
            LOG.warning("Failed to create appearance directories", e);
        }
        load(Kind.SKIN, skins);
        load(Kind.CAPE, capes);
        ensureBuiltinSkins();
    }

    /// 内置素材：只放原版两套皮肤（Steve 宽体、Alex 纤体），披风一个都不预置。
    ///
    /// <p>皮肤取自 {@code HMCLCore} 里已有的资源，首次启动时复制到皮肤目录，
    /// 这样它们能被正常预览、上传，也不会因为资源包缺失而变成空白。
    /// 标记为 {@code builtin} 之后不允许删除，避免用户误操作把唯一的默认皮肤删掉。
    private static final String BUILTIN_STEVE = "builtin-steve";
    private static final String BUILTIN_ALEX = "builtin-alex";

    private void ensureBuiltinSkins() {
        installBuiltinSkin(BUILTIN_STEVE, "Steve（宽体）", "default",
                "/assets/img/skin/wide/steve.png");
        installBuiltinSkin(BUILTIN_ALEX, "Alex（纤体）", "slim",
                "/assets/img/skin/slim/alex.png");
    }

    private void installBuiltinSkin(String id, String name, String model, String resource) {
        Path target = fileOf(Kind.SKIN, id);
        Asset existing = find(Kind.SKIN, id);

        if (existing != null && Files.isRegularFile(target)) {
            return;
        }

        try (InputStream in = AppearanceStore.class.getResourceAsStream(resource)) {
            if (in == null) {
                LOG.warning("Builtin skin resource missing: " + resource);
                return;
            }
            Files.createDirectories(SKIN_DIR);
            // 先写临时文件再替换，避免上次异常退出留下半张图
            Path tmp = target.resolveSibling(id + ".png.tmp");
            Files.copy(in, tmp, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            Files.move(tmp, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            LOG.warning("Failed to install builtin skin " + id, e);
            return;
        }

        if (existing == null) {
            skins.add(new Asset(id, name, model, true));
        }
        save(Kind.SKIN, skins);
    }

    // ==================== 索引读写 ====================

    private static Path indexFile(Kind kind) {
        return ROOT.resolve(kind == Kind.SKIN ? "skins.json" : "capes.json");
    }

    private static Path dirOf(Kind kind) {
        return kind == Kind.SKIN ? SKIN_DIR : CAPE_DIR;
    }

    private void load(Kind kind, List<Asset> target) {
        Path file = indexFile(kind);
        if (!Files.isRegularFile(file)) {
            return;
        }
        try {
            Index index = JsonUtils.fromJson(Files.readString(file), Index.class);
            if (index == null || index.entries == null) {
                return;
            }
            for (Asset asset : index.entries) {
                if (asset.id != null && Files.isRegularFile(fileOf(kind, asset.id))) {
                    target.add(asset);
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to read " + file, e);
        }
    }

    private void save(Kind kind, List<Asset> source) {
        Index index = new Index();
        index.entries = new ArrayList<>(source);
        try {
            Files.createDirectories(ROOT);
            FileUtils.saveSafely(indexFile(kind), JsonUtils.GSON.toJson(index));
        } catch (IOException e) {
            LOG.warning("Failed to save " + indexFile(kind), e);
        }
    }

    // ==================== 查询 ====================

    public List<Asset> list(Kind kind) {
        return kind == Kind.SKIN ? skins : capes;
    }

    public Asset find(Kind kind, String id) {
        if (id == null) {
            return null;
        }
        for (Asset asset : list(kind)) {
            if (asset.id.equals(id)) {
                return asset;
            }
        }
        return null;
    }

    public Path fileOf(Kind kind, String id) {
        return dirOf(kind).resolve(id + ".png");
    }

    public Path elytraFileOf(String id) {
        return CAPE_DIR.resolve(id + ".elytra.png");
    }

    public Image image(Kind kind, Asset asset) throws IOException {
        if (asset == null) {
            return null;
        }
        if (asset.image != null) {
            return asset.image;
        }
        asset.image = readImage(fileOf(kind, asset.id));
        return asset.image;
    }

    public Image elytraImage(Asset asset) {
        if (asset == null || !asset.hasElytra) {
            return null;
        }
        if (asset.elytraImage != null) {
            return asset.elytraImage;
        }
        try {
            asset.elytraImage = readImage(elytraFileOf(asset.id));
            return asset.elytraImage;
        } catch (IOException e) {
            LOG.warning("Failed to read elytra texture of " + asset.id, e);
            return null;
        }
    }

    private static Image readImage(Path file) throws IOException {
        if (!Files.isRegularFile(file)) {
            throw new IOException("missing file: " + file);
        }
        try (InputStream in = Files.newInputStream(file)) {
            Image image = new Image(in);
            if (image.isError()) {
                throw new IOException("bad image: " + file, image.getException());
            }
            return image;
        }
    }

    // ==================== 导入 / 删除 ====================

    public Asset importSkin(Path file) throws IOException {
        Image image = readImage(file);
        if (!isSkinSize(image)) {
            throw new IOException("不是合法的皮肤文件（需要 64 的倍数，且高为宽或宽的一半）");
        }

        String id = sha1(file);
        Asset existing = find(Kind.SKIN, id);
        if (existing != null) {
            return existing;
        }

        Path target = fileOf(Kind.SKIN, id);
        copyAtomically(file, target);

        boolean slim;
        try {
            slim = new NormalizedSkin(image).isSlim();
        } catch (Exception e) {
            slim = false;
        }

        Asset asset = new Asset(id, uniqueName(Kind.SKIN, baseName(file)), slim ? TextureModel.SLIM.modelName : TextureModel.WIDE.modelName,
                false, System.currentTimeMillis());
        asset.image = image;
        skins.add(0, asset);
        save(Kind.SKIN, skins);
        return asset;
    }

    /**
     * 导入披风。{@code elytraFile} 可为 null——为 null 时渲染阶段直接用披风贴图套鞘翅。
     */
    public Asset importCape(Path file, Path elytraFile) throws IOException {
        Image image = readImage(file);
        String id = sha1(file);
        Asset existing = find(Kind.CAPE, id);
        if (existing != null) {
            return existing;
        }

        Path target = fileOf(Kind.CAPE, id);
        copyAtomically(file, target);

        boolean hasElytra = false;
        if (elytraFile != null && Files.isRegularFile(elytraFile)) {
            copyAtomically(elytraFile, elytraFileOf(id));
            hasElytra = true;
        }

        Asset asset = new Asset(id, uniqueName(Kind.CAPE, baseName(file)), null, hasElytra, System.currentTimeMillis());
        asset.image = image;
        capes.add(0, asset);
        save(Kind.CAPE, capes);
        return asset;
    }

    public void remove(Kind kind, String id) {
        Asset asset = find(kind, id);
        if (asset == null || asset.builtin) {
            // 内置皮肤不允许删除，界面上也不给入口
            return;
        }
        list(kind).remove(asset);
        try {
            Files.deleteIfExists(fileOf(kind, id));
            if (kind == Kind.CAPE) {
                Files.deleteIfExists(elytraFileOf(id));
            }
        } catch (IOException e) {
            LOG.warning("Failed to delete appearance file " + id, e);
        }
        save(kind, list(kind));
    }

    public void rename(Kind kind, String id, String name) {
        Asset asset = find(kind, id);
        if (asset == null || asset.builtin || name == null || name.isBlank()) {
            return;
        }
        asset.name = uniqueName(kind, name.trim(), asset);
        save(kind, list(kind));
    }

    // ==================== 账号状态 ====================

    public State stateOf(String accountId) {
        Path file = STATE_DIR.resolve(accountId + ".json");
        if (!Files.isRegularFile(file)) {
            return new State(null, null, null, "cape");
        }
        try {
            State state = JsonUtils.fromJson(Files.readString(file), State.class);
            if (state == null) {
                return new State(null, null, null, "cape");
            }
            if (state.capeMode == null) {
                state.capeMode = "cape";
            }
            return state;
        } catch (Exception e) {
            LOG.warning("Failed to read appearance state for " + accountId, e);
            return new State(null, null, null, "cape");
        }
    }

    public void saveState(String accountId, State state) {
        try {
            Files.createDirectories(STATE_DIR);
            FileUtils.saveSafely(STATE_DIR.resolve(accountId + ".json"), JsonUtils.GSON.toJson(state));
        } catch (IOException e) {
            LOG.warning("Failed to save appearance state for " + accountId, e);
        }
    }

    // ==================== 工具 ====================

    private static void copyAtomically(Path source, Path target) throws IOException {
        Files.createDirectories(target.getParent());
        Path tmp = FileUtils.tmpSaveFile(target);
        Files.copy(source, tmp, StandardCopyOption.REPLACE_EXISTING);
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
    }

    private static boolean isSkinSize(Image image) {
        int width = (int) image.getWidth();
        int height = (int) image.getHeight();
        return width > 0 && width % 64 == 0 && (height == width || height * 2 == width);
    }

    private static String baseName(Path file) {
        String name = FileUtils.getNameWithoutExtension(file);
        return name == null || name.isBlank() ? "未命名" : name;
    }

    private String uniqueName(Kind kind, String name) {
        return uniqueName(kind, name, null);
    }

    private String uniqueName(Kind kind, String name, Asset self) {
        String candidate = name;
        int index = 2;
        while (true) {
            String current = candidate;
            boolean conflict = list(kind).stream()
                    .anyMatch(it -> it != self && it.name != null && it.name.equals(current));
            if (!conflict) {
                return candidate;
            }
            candidate = name + " (" + index++ + ")";
        }
    }

    private static String sha1(Path file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-1");
            return HexFormat.of().formatHex(digest.digest(Files.readAllBytes(file))).substring(0, 16);
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    /// 预览用：按账号状态挑出要渲染的三张图
    public Preview resolve(String accountId) {
        State state = stateOf(accountId);

        Image skinImage = null;
        boolean slim = false;

        Asset skin = find(Kind.SKIN, state.skin);
        if (skin != null) {
            try {
                skinImage = image(Kind.SKIN, skin);
                slim = TextureModel.SLIM.modelName.equals(skin.model);
            } catch (IOException e) {
                LOG.warning("Failed to load skin " + skin.id, e);
            }
        }

        Image capeImage = null;
        Image elytraImage = null;

        Asset cape = find(Kind.CAPE, state.cape);
        if (cape != null) {
            try {
                capeImage = image(Kind.CAPE, cape);
                elytraImage = elytraImage(cape);
            } catch (IOException e) {
                LOG.warning("Failed to load cape " + cape.id, e);
            }
        }

        return new Preview(skinImage, slim, capeImage, elytraImage, state.capeMode);
    }

    public record Preview(Image skin, boolean slim, Image cape, Image elytra, String capeMode) {
        public boolean hasCape() {
            return cape != null;
        }
    }
}
