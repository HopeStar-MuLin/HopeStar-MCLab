/*
 * Hello Minecraft! Launcher
 * Copyright (C) 2026 huangyuhui <huanghongxun2008@126.com> and contributors
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

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.util.io.FileUtils;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.Nullable;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Stream;

/// 把旧启动器目录里的账号、游戏目录、皮肤搬到当前数据目录。
///
/// 绿色版换目录、从旧版本升级上来，用户最烦的就是"账号要重新登、游戏目录要重新加"。
/// 这里只搬配置，**不动游戏文件**：旧的 `.minecraft` 留在原地，导入后按原路径
/// 登记进游戏目录列表 —— 几百 GB 的存档和 mod 不可能为了换个启动器目录复制一遍。
///
/// 覆盖之前一律先备份到 `data/backup/legacy-<时间>/`，搬坏了能捡回来。
public final class LegacyMigrator {

    private LegacyMigrator() {
    }

    /// 账号文件是"文件整体替换"，游戏目录是"合并去重"，皮肤是"按文件名补齐"。
    /// 三种策略之所以不一样，是因为账号的私有凭据是整体加密的信封，拆开合并会写坏；
    /// 而游戏目录就是一个路径数组，合并是安全的。
    public enum Part {
        ACCOUNTS("accounts"),
        GAME_DIRECTORIES("dirs"),
        APPEARANCE("appearance");

        final String key;

        Part(String key) {
            this.key = key;
        }

        static Part of(String key) {
            for (Part p : values()) {
                if (p.key.equals(key)) {
                    return p;
                }
            }
            return null;
        }
    }

    /// 旧文件怎么处理。
    ///
    /// `MOVE` 是搬走：复制到当前目录之后把旧的那份删掉，旧启动器就空了。
    /// `REFERENCE` 是留个底：只复制一份过来，旧文件原样不动。
    ///
    /// 游戏目录两种模式都不动游戏本体，只登记路径 —— 几百 GB 的存档和模组
    /// 不会因为换个启动器目录就被搬一遍。
    public enum Mode {
        MOVE,
        REFERENCE;

        static Mode of(String name) {
            // 只有明确说 "move" 才删源文件。任何拼错的、没传的值一律落到
            // REFERENCE —— 把「保守」当默认，删用户旧文件这种事必须显式要求。
            // 反过来写（默认 MOVE）的话，前端一个拼写错误就是删光旧启动器数据。
            return "move".equalsIgnoreCase(name) ? MOVE : REFERENCE;
        }
    }

    /// 扫描结果。`accounts` / `gameDirs` / `appearance` 都是"能搬多少个"。
    ///
    /// `credentials` 表示旧目录里有没有登录凭据文件。账号元数据和凭据是分开存的，
    /// 只拷了 `config/` 没拷 `private/` 的目录搬过来，账号会全部加载失败，
    /// 得让用户在点导入之前就知道。
    public record Scan(Path dataRoot, int accounts, int gameDirs, int appearance,
                       int backgrounds, boolean credentials) {
        JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("ok", true);
            o.addProperty("data", dataRoot.toString());
            o.addProperty("accounts", accounts);
            o.addProperty("gameDirs", gameDirs);
            o.addProperty("appearance", appearance);
            // 背景图单独报：它既可能在外观库里，也可能在 config/ 下（旧版）或
            // hmcl.json 指向的任意路径（原版 HMCL），用户得知道能搬几张
            o.addProperty("backgrounds", backgrounds);
            o.addProperty("credentials", credentials);
            return o;
        }
    }

    /// 把用户随手选的目录收敛成旧启动器的数据目录（带 `config/` 的那一层）。
    ///
    /// 用户可能点的是：启动器根目录、`data` 目录、官方 HMCL 的 `.hmcl`、
    /// 甚至装着 `.minecraft` 的那层。这里都往下找一遍。
    public static Path resolveDataRoot(Path chosen) throws IOException {
        Path start = chosen.toAbsolutePath().normalize();
        if (!Files.isDirectory(start)) {
            throw new IOException("这不是一个文件夹");
        }
        if (looksLikeData(start)) {
            return start;
        }
        for (String name : new String[]{"data", ".hmcl", "HMCL", "MCLab", ".minecraft"}) {
            Path child = start.resolve(name);
            if (looksLikeData(child)) {
                return child;
            }
        }
        // 还有一层：用户选的是"装着启动器文件夹的父目录"
        try (Stream<Path> list = Files.list(start)) {
            for (Path child : list.toList()) {
                if (!Files.isDirectory(child)) {
                    continue;
                }
                if (looksLikeData(child)) {
                    return child;
                }
                Path inner = child.resolve("data");
                if (looksLikeData(inner)) {
                    return inner;
                }
            }
        } catch (IOException ignored) {
            // 没权限列目录，落到下面统一的报错
        }
        throw new IOException("这里没有 config 目录，不像是启动器的数据目录");
    }

    private static boolean looksLikeData(Path dir) {
        return Files.isDirectory(dir.resolve("config"));
    }

    public static Scan scan(Path dataRoot) {
        Path config = dataRoot.resolve("config");
        int accounts = countArray(config.resolve("accounts.json"), "accounts")
                + countArray(config.resolve("user-accounts.json"), "accounts");
        int dirs = countArray(config.resolve("game-directories.json"), "directories")
                + countArray(config.resolve("user-game-directories.json"), "directories");
        int appearance = countFiles(dataRoot.resolve("appearance"));
        int backgrounds = countLegacyBackgrounds(dataRoot);
        boolean credentials = Files.isRegularFile(dataRoot.resolve("private").resolve("account-private-data.json"));
        return new Scan(dataRoot, accounts, dirs, appearance, backgrounds, credentials);
    }

    /// 旧版背景图的存放位置。
    ///
    /// <p>本项目旧版是 `config/background.<ext>` 一个文件（换图就覆盖）；
    /// 原版 HMCL 把用户选的**绝对路径**记在 `config/hmcl.json` 的
    /// `customBackgroundImagePath`（更早的版本叫 `bgpath` / `backgroundImage`）。
    /// 新版外观库里的 `appearance/backgrounds/` 不算——那个跟着 APPEARANCE
    /// 的整目录复制一起走。
    private static @Nullable Path findLegacyBackgroundFile(Path dataRoot) {
        Path config = dataRoot.resolve("config");
        for (String ext : List.of(".png", ".jpg", ".webp", ".gif", ".bmp")) {
            Path file = config.resolve("background" + ext);
            if (Files.isRegularFile(file)) {
                return file;
            }
        }
        return null;
    }

    private static @Nullable Path findHmclBackgroundFile(Path dataRoot) {
        Path config = dataRoot.resolve("config");
        for (String name : List.of("hmcl.json", "launcher_profiles.json")) {
            Path settings = config.resolve(name);
            if (!Files.isRegularFile(settings)) {
                continue;
            }
            try {
                JsonObject o = JsonUtils.fromJson(Files.readString(settings), JsonObject.class);
                if (o == null) {
                    continue;
                }
                String path = optString(o, "customBackgroundImagePath");
                if (path.isBlank()) {
                    path = optString(o, "bgpath");
                }
                if (path.isBlank()) {
                    path = optString(o, "backgroundImage");
                }
                if (path.isBlank()) {
                    continue;
                }
                Path file = Path.of(path);
                if (file.isAbsolute()) {
                    if (Files.isRegularFile(file)) {
                        return file;
                    }
                } else {
                    // 旧 HMCL 的相对背景路径是相对它自己的工作目录解析的，
                    // 那就是这里的 dataRoot（或 config/）。不修正的话，
                    // Path.of 会拿「新启动器的当前目录」去拼，必然找不到，
                    // 迁移完背景图就无声消失了。
                    for (Path base : List.of(dataRoot, dataRoot.resolve("config"))) {
                        Path candidate = base.resolve(path).normalize();
                        if (Files.isRegularFile(candidate)) {
                            return candidate;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.info("[migrate] 读不了 " + settings + "：" + e);
            }
        }
        return null;
    }

    private static String optString(JsonObject o, String key) {
        try {
            if (o.has(key) && !o.get(key).isJsonNull() && o.get(key).isJsonPrimitive()) {
                return o.get(key).getAsString();
            }
        } catch (Exception ignored) {
            // 字段类型不对就当没有
        }
        return "";
    }

    private static int countLegacyBackgrounds(Path dataRoot) {
        int n = 0;
        if (findLegacyBackgroundFile(dataRoot) != null) {
            n++;
        }
        Path custom = findHmclBackgroundFile(dataRoot);
        if (custom != null && !custom.equals(findLegacyBackgroundFile(dataRoot))) {
            n++;
        }
        return n;
    }

    private static String extensionOf(Path file) {
        String name = file.getFileName().toString();
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(dot).toLowerCase(Locale.ROOT) : ".png";
    }

    /// 把旧背景图收进外观库。
    ///
    /// <p>走 `AppearanceStore.importBackground` 而不是直接复制：它负责算内容哈希、
    /// 去重、写索引，导入之后界面立刻能选，不用重启。
    private static int importLegacyBackgrounds(Path srcData) {
        AppearanceStore store = AppearanceStore.getInstance();
        int n = 0;
        String firstId = null;

        Path legacy = findLegacyBackgroundFile(srcData);
        if (legacy != null) {
            try {
                firstId = store.importBackground(legacy, extensionOf(legacy), "旧背景图").getId();
                n++;
            } catch (Exception e) {
                LOG.warning("[migrate] 导入旧背景图失败 " + legacy, e);
            }
        }
        Path custom = findHmclBackgroundFile(srcData);
        if (custom != null && !custom.equals(legacy)) {
            try {
                var asset = store.importBackground(custom, extensionOf(custom), custom.getFileName().toString());
                if (firstId == null) {
                    firstId = asset.getId();
                }
                n++;
            } catch (Exception e) {
                LOG.warning("[migrate] 导入自定义背景图失败 " + custom, e);
            }
        }

        // 搬完把旧的那张设成当前背景。不设的话用户看到的是「默认背景」——
        // 图明明进了库，屏幕上却是空的，等于迁移没成功。
        if (firstId != null) {
            adoptAsCurrentBackground(firstId);
        }
        return n;
    }

    /// 把迁移进来的背景设为当前背景。
    ///
    /// <p>直接写 `webui.json` 的 `backgroundId`：迁移是静态流程，拿不到
    /// {@link ThemeApi} 实例。已经有选择就不覆盖 —— 用户当前的背景比旧的那张更该保留。
    private static void adoptAsCurrentBackground(String id) {
        Path file = Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("webui.json");
        try {
            JsonObject prefs = Files.isRegularFile(file)
                    ? JsonUtils.fromJson(Files.readString(file), JsonObject.class)
                    : null;
            if (prefs == null) {
                prefs = new JsonObject();
            }
            if (prefs.has("backgroundId") && !prefs.get("backgroundId").isJsonNull()
                    && !prefs.get("backgroundId").getAsString().isBlank()) {
                return;
            }
            prefs.addProperty("backgroundId", id);
            Files.createDirectories(file.getParent());
            FileUtils.saveSafely(file, JsonUtils.GSON.toJson(prefs));
        } catch (Exception e) {
            LOG.warning("[migrate] 写 backgroundId 失败", e);
        }
    }

    /// 执行导入。返回给前端的 JSON 里 `restart` 永远是 true —— 账号是在启动时
    /// 加载进内存的，不重启看不到。
    public static JsonObject migrate(Path srcData, Set<Part> parts, Mode mode) throws IOException {
        Path dstData = Metadata.HMCL_LOCAL_HOME.toAbsolutePath().normalize();
        LOG.info("[migrate] src=" + srcData.toAbsolutePath() + " dst=" + dstData + " parts=" + parts + " mode=" + mode);
        if (srcData.toAbsolutePath().normalize().equals(dstData)) {
            throw new IOException("选的是当前正在用的目录，没什么可导入的");
        }
        boolean removeSource = mode == Mode.MOVE;

        String stamp = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss"));
        Path backupRoot = dstData.resolve("backup").resolve("legacy-" + stamp);

        JsonObject result = new JsonObject();
        int accounts = 0;
        int dirs = 0;
        int appearance = 0;
        int backgrounds = 0;

        if (parts.contains(Part.ACCOUNTS)) {
            // 账号的私有数据是一个整体加密的信封，拆开合并会写坏，
            // 所以这里整文件替换。当前目录原来的账号已经先备份过了。
            accounts = scan(srcData).accounts();
            replace(srcData.resolve("config").resolve("accounts.json"),
                    dstData.resolve("config").resolve("accounts.json"), dstData, backupRoot, removeSource);
            replace(srcData.resolve("config").resolve("user-accounts.json"),
                    dstData.resolve("config").resolve("user-accounts.json"), dstData, backupRoot, removeSource);
            replace(srcData.resolve("private").resolve("account-private-data.json"),
                    dstData.resolve("private").resolve("account-private-data.json"), dstData, backupRoot, removeSource);
            replace(srcData.resolve("private").resolve("user-account-private-data.json"),
                    dstData.resolve("private").resolve("user-account-private-data.json"), dstData, backupRoot, removeSource);
        }

        if (parts.contains(Part.GAME_DIRECTORIES)) {
            // 游戏目录是纯路径数组，合并就行，不动"当前选中的目录"
            dirs = mergeDirectories(
                    srcData.resolve("config").resolve("game-directories.json"),
                    dstData.resolve("config").resolve("game-directories.json"), dstData, backupRoot)
                    + mergeDirectories(
                    srcData.resolve("config").resolve("user-game-directories.json"),
                    dstData.resolve("config").resolve("user-game-directories.json"), dstData, backupRoot);
        }

        if (parts.contains(Part.APPEARANCE)) {
            appearance = copyTree(srcData.resolve("appearance"), dstData.resolve("appearance"), removeSource);
            // 外观目录是整块复制进来的，单例里还是启动那一刻的索引。不重读的话，
            // 下面往里加背景图时会把刚复制进来的 backgrounds.json 冲掉。
            AppearanceStore.getInstance().reload();
            backgrounds = importLegacyBackgrounds(srcData);
        }

        result.addProperty("ok", true);
        result.addProperty("restart", true);
        result.addProperty("accounts", accounts);
        result.addProperty("gameDirs", dirs);
        result.addProperty("appearance", appearance);
        result.addProperty("backgrounds", backgrounds);
        result.addProperty("backup", Files.isDirectory(backupRoot) ? backupRoot.toString() : "");
        return result;
    }

    // ==================== 文件操作 ====================

    /// 整文件替换：先备份目标，再覆盖。`removeSource` 为 true 时旧文件跟着删掉。
    private static void replace(Path src, Path dst, Path dstData, Path backupRoot, boolean removeSource) throws IOException {
        if (!Files.isRegularFile(src)) {
            return;
        }
        if (Files.isRegularFile(dst)) {
            backup(dst, dstData, backupRoot);
        }
        Files.createDirectories(dst.getParent());
        Files.copy(src, dst, StandardCopyOption.REPLACE_EXISTING);
        // 只有复制成功才删源：中途失败的话旧文件还得留着
        if (removeSource) {
            deleteIfPresent(src);
        }
    }

    private static void backup(Path file, Path dstData, Path backupRoot) throws IOException {
        Path relative = dstData.relativize(file);
        Path target = backupRoot.resolve(relative);
        Files.createDirectories(target.getParent());
        Files.copy(file, target, StandardCopyOption.REPLACE_EXISTING);
    }

    /// 合并 `directories` 数组，按 path 去重（Windows 上大小写不敏感）。
    /// 返回新增的条数。
    private static int mergeDirectories(Path src, Path dst, Path dstData, Path backupRoot) throws IOException {
        if (!Files.isRegularFile(src)) {
            return 0;
        }
        JsonObject srcRoot = readObject(src);
        JsonArray incoming = arrayOf(srcRoot, "directories");
        if (incoming.isEmpty()) {
            return 0;
        }

        JsonObject dstRoot = Files.isRegularFile(dst) ? readObject(dst) : new JsonObject();
        JsonArray existing = arrayOf(dstRoot, "directories");

        Set<String> known = new HashSet<>();
        for (JsonElement e : existing) {
            String p = pathOf(e);
            if (p != null) {
                known.add(normalize(p));
            }
        }

        int added = 0;
        for (JsonElement e : incoming) {
            String p = pathOf(e);
            if (p == null || !known.add(normalize(p))) {
                continue;
            }
            existing.add(e.deepCopy());
            added++;
        }
        if (added == 0) {
            return 0;
        }

        if (Files.isRegularFile(dst)) {
            backup(dst, dstData, backupRoot);
        }
        dstRoot.add("directories", existing);
        Files.createDirectories(dst.getParent());
        Files.writeString(dst, dstRoot.toString(), StandardCharsets.UTF_8);
        return added;
    }

    private static String pathOf(JsonElement element) {
        if (element == null || !element.isJsonObject()) {
            return null;
        }
        JsonElement path = element.getAsJsonObject().get("path");
        if (path == null || path.isJsonNull()) {
            return null;
        }
        return path.getAsString();
    }

    private static String normalize(String path) {
        return path.replace('\\', '/').toLowerCase(Locale.ROOT);
    }

    /// 递归复制目录，同名文件覆盖。返回复制的文件数。
    /// `removeSource` 为 true 时复制完把源文件删掉，目录空了就顺手删掉。
    static int copyTree(Path src, Path dst, boolean removeSource) throws IOException {
        if (!Files.isDirectory(src)) {
            return 0;
        }
        List<Path> copied = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(src)) {
            for (Path from : walk.toList()) {
                if (!Files.isRegularFile(from)) {
                    continue;
                }
                Path to = dst.resolve(src.relativize(from));
                Files.createDirectories(to.getParent());
                Files.copy(from, to, StandardCopyOption.REPLACE_EXISTING);
                copied.add(from);
            }
        }
        if (removeSource) {
            for (Path from : copied) {
                deleteIfPresent(from);
            }
            pruneEmptyDirs(src);
        }
        return copied.size();
    }

    private static void deleteIfPresent(Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException ignored) {
            // 删不掉就当引用模式处理：文件搬过去了，旧的那份留着而已
        }
    }

    /// 从最里层往上删空目录，遇到非空就停。
    private static void pruneEmptyDirs(Path dir) {
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(dir)) {
            List<Path> all = new ArrayList<>(walk.toList());
            // 深的先删
            all.sort((a, b) -> b.getNameCount() - a.getNameCount());
            for (Path p : all) {
                if (Files.isDirectory(p)) {
                    try (Stream<Path> children = Files.list(p)) {
                        if (children.findAny().isPresent()) {
                            continue;
                        }
                    }
                    Files.deleteIfExists(p);
                }
            }
        } catch (IOException ignored) {
            // 删不动就不删，反正文件都搬完了
        }
    }

    // ==================== JSON 小工具 ====================

    private static JsonObject readObject(Path file) throws IOException {
        String text = Files.readString(file, StandardCharsets.UTF_8);
        try {
            JsonElement parsed = JsonParser.parseString(text);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
        } catch (RuntimeException e) {
            // 旧文件损坏就当空的：迁移不该被一个坏 JSON 卡死
            return new JsonObject();
        }
    }

    private static JsonArray arrayOf(JsonObject root, String key) {
        JsonElement e = root.get(key);
        if (e != null && e.isJsonArray()) {
            return e.getAsJsonArray();
        }
        JsonArray empty = new JsonArray();
        root.add(key, empty);
        return empty;
    }

    private static int countArray(Path file, String key) {
        if (!Files.isRegularFile(file)) {
            return 0;
        }
        try {
            JsonElement e = readObject(file).get(key);
            return e != null && e.isJsonArray() ? e.getAsJsonArray().size() : 0;
        } catch (IOException e) {
            return 0;
        }
    }

    private static int countFiles(Path dir) {
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (Stream<Path> walk = Files.walk(dir)) {
            List<Path> files = new ArrayList<>(walk.filter(Files::isRegularFile).toList());
            return files.size();
        } catch (IOException e) {
            return 0;
        }
    }
}
