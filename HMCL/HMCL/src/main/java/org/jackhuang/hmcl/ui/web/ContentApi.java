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

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import javafx.stage.FileChooser;
import javafx.stage.Stage;
import org.jackhuang.hmcl.game.GameComponentType;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 下载页与实例内容：版本 / 加载器安装、模组 / 资源包 / 光影 / 整合包 / 世界、
/// 截图、崩溃分析、完整性检查，以及实例与存档的导入导出。
///
/// <p>业务在 `DownloadService` / `AddonService` / `CrashService` / `ExportService` /
/// `ArchiveImportService` 里，这里只做参数搬运与 JSON 组装。这些服务都从
/// {@link BridgeServices} 拿同一份实例——它们之间有联动（装完实例静默补 Java、
/// 装完模组刷缓存），各建一份会各缓存一份，症状是「页面上的数据不刷新」。
@NotNullByDefault
public final class ContentApi {

    private final BridgeHost host;
    private final BridgeServices services;

    ContentApi(BridgeHost host, BridgeServices services) {
        this.host = host;
        this.services = services;
    }

    /// 前端进下载页时调用，force=true 表示下拉刷新
    public void requestVersions(boolean force) {
        services.download.requestVersions(force);
    }

    /// 安装指定版本（原版）
    public void installVersion(String versionId) {
        services.download.installVersion(versionId);
    }

    /// 带自定义实例名的安装（安装弹窗里的「游戏实例名称」输入框）
    public void installVersionNamed(String versionId, String instanceName) {
        services.download.installVersion(versionId, instanceName);
    }

    // ==================== 实例里已装的内容 ====================

    /// 截图列表：文件名、大小、时间、360px 缩略图（data URL）。
    public String instanceScreenshots(String instanceId) {
        HMCLGameInstance instance = InstanceLookup.find(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        return ScreenshotService.list(instance);
    }

    /// 截图操作。action: `open` / `copy` / `rename` / `delete`。
    public String screenshotAction(String instanceId, String action, String file, String arg) {
        HMCLGameInstance instance = InstanceLookup.find(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        if (file == null || file.isBlank() || file.contains("..") || file.contains("/") || file.contains("\\")) {
            return "{\"error\":\"文件名不合法\"}";
        }
        java.nio.file.Path path = instance.getRunDirectory().resolve("screenshots").resolve(file);
        if (!java.nio.file.Files.isRegularFile(path)) {
            return "{\"error\":\"文件不存在：" + file + "\"}";
        }
        return switch (action == null ? "" : action) {
            case "open" -> ScreenshotService.open(path);
            case "copy" -> ScreenshotService.copy(path);
            case "rename" -> ScreenshotService.rename(path, arg);
            case "delete" -> ScreenshotService.delete(path);
            default -> "{\"error\":\"未知的操作：" + action + "\"}";
        };
    }

    /// 把最近一次游戏崩溃翻成人话：原因、建议、可疑模组、原文摘要。
    public String crashReportAnalysis(String instanceId) {
        return CrashService.analyze(instanceId);
    }

    /// 崩溃后一键禁用模组。`filesJson` 是 jar 文件名数组，传 `"*"` 表示全部。
    ///
    /// <p>禁用是改名（`xxx.jar` → `xxx.jar.disabled`），不删文件。同时记一份
    /// 恢复快照，用户点「恢复」能原样启用回来。
    public String crashDisableMods(String instanceId, String filesJson) {
        String result = CrashService.disableMods(instanceId, filesJson);
        // 模组页可能正开着，禁用完得让它看到新状态
        pushAddons(instanceId, "mod");
        return result;
    }

    /// 恢复上一次崩溃排障时禁用的模组。
    public String crashRestoreMods(String instanceId) {
        String result = CrashService.restoreMods(instanceId);
        pushAddons(instanceId, "mod");
        return result;
    }

    /// 扫实例的 mods：返回每个模组的元数据、缺失的前置、重复安装的 id。
    ///
    /// <p>启动前就能看出来「少装了什么」比崩了再翻日志省事得多。
    public String instanceModScan(String instanceId) {
        return ModScanService.scan(instanceId);
    }

    /// 检查游戏本体的文件完整性：客户端 jar / libraries / assets 缺了哪些。
    ///
    /// <p>只 stat 文件不联网，「缺几个、要下多少」能在半秒内出来。
    public String gameIntegrityScan(String instanceId) {
        return GameIntegrityService.scan(instanceId);
    }

    /// 补全缺失和损坏的游戏文件。真正下载走 HMCL 启动前那套校验任务，
    /// 进度推给右上角的任务列表，完成后再通知前端。
    public void gameIntegrityFix(String instanceId) {
        services.integrity.fix(instanceId);
    }

    /// 选一个本地整合包并直接安装。
    ///
    /// <p>比走 `/api/upload` 少一次拷贝：那个是「前端读文件 → POST 到本地 HTTP → 后端落盘」，
    /// 一个 300 MB 的整合包等于白写两遍磁盘。这里拿到路径就直接交给安装链路。
    ///
    /// <p>对话框用的是「浏览 Java」那套系统实现：壳模式下没有 JavaFX Stage，
    /// FileChooser 弹不出来。
    public void pickModpackFile() {
        String path = host.pickFile("选择整合包",
                "整合包|*.zip;*.mrpack;*.mcbbs|所有文件|*.*");
        if (path == null || path.isBlank()) {
            return;
        }
        services.addons.installLocalFile("modpack", java.nio.file.Path.of(path), null, null, false);
    }

    /// 按路径装整合包。留给「拖进来一个文件」和命令行调用。
    public void installModpackPath(String path) {
        if (path == null || path.isBlank()) {
            return;
        }
        services.addons.installLocalFile("modpack", java.nio.file.Path.of(path), null, null, false);
    }

    /// 取消一个正在跑的下载/安装任务（前端任务行上的 ✕）。
    public void cancelDownload(String taskId) {
        // Java 下载也走同一个任务列表，取消要一并转过去
        services.download.cancelTask(taskId);
        services.javaInstall.cancel(taskId);
    }

    /// 世界（存档）列表：名称、版本、最后游玩、图标、备份数。
    public String instanceWorlds(String instanceId) {
        HMCLGameInstance instance = InstanceLookup.find(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        return WorldService.list(instance);
    }

    /// 世界操作。action: `open` / `backup` / `rename` / `delete`；file 是 saves 下的目录名。
    public String worldAction(String instanceId, String action, String file, String arg) {
        HMCLGameInstance instance = InstanceLookup.find(instanceId);
        if (instance == null) {
            return "{\"error\":\"找不到这个实例\"}";
        }
        if (file == null || file.isBlank() || file.contains("..") || file.contains("/") || file.contains("\\")) {
            return "{\"error\":\"存档目录名不合法\"}";
        }
        java.nio.file.Path dir = instance.getSavesDirectory().resolve(file);
        if (!java.nio.file.Files.isDirectory(dir)) {
            return "{\"error\":\"存档不存在：" + file + "\"}";
        }
        org.jackhuang.hmcl.game.World world;
        try {
            world = new org.jackhuang.hmcl.game.World(dir);
        } catch (Exception e) {
            return "{\"error\":\"读取存档失败：" + e.getMessage() + "\"}";
        }
        return switch (action == null ? "" : action) {
            case "open" -> {
                WorldService.open(world);
                yield "{\"ok\":true}";
            }
            case "backup" -> WorldService.backup(instance, world);
            case "rename" -> WorldService.rename(world, arg);
            case "delete" -> WorldService.delete(world);
            default -> "{\"error\":\"未知的操作：" + action + "\"}";
        };
    }

    /// 列出实例某个目录下的内容。kind: `mod` / `resourcepack` / `shader`。
    ///
    /// 不解析 jar 里的元数据——这里只要「有哪些文件、开没开、多大」，
    /// 文件系统层面就够了。`.disabled` 后缀是 HMCL 的禁用约定。
    public String instanceAddons(String instanceId, String kind) {
        JsonObject root = new JsonObject();
        JsonArray items = new JsonArray();

        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null) {
                root.addProperty("error", "找不到实例或目录");
            } else {
                root.addProperty("directory", dir.toString());
                if (Files.isDirectory(dir)) {
                    boolean isWorld = "world".equals(kind);
                    // 只有模组需要判加载器冲突：资源包/光影/存档没有加载器这回事
                    String instLoader = "mod".equals(kind) ? instanceLoaderName(instanceId) : null;
                    try (var list = Files.list(dir)) {
                        // 世界是目录（每个存档一个），其余是文件
                        List<Path> files = list
                                .filter(isWorld ? Files::isDirectory : Files::isRegularFile)
                                .sorted()
                                .toList();
                        for (Path file : files) {
                            String fileName = file.getFileName().toString();
                            boolean disabled = fileName.endsWith(".disabled");
                            JsonObject o = new JsonObject();
                            o.addProperty("fileName", fileName);
                            o.addProperty("name", disabled
                                    ? fileName.substring(0, fileName.length() - ".disabled".length())
                                    : fileName);
                            o.addProperty("disabled", disabled);
                            // 存档目录递归求和太慢（几百 MB 几千个文件会卡住界面），
                            // 只报 level.dat 的大小，够用户判断是不是空存档
                            Path sizeTarget = isWorld ? file.resolve("level.dat") : file;
                            try {
                                o.addProperty("size", Files.isRegularFile(sizeTarget) ? Files.size(sizeTarget) : 0);
                            } catch (IOException e) {
                                o.addProperty("size", 0);
                            }
                            // 图标 URL 里带这个当版本号：用户换了同名的文件，
                            // 浏览器缓存自然失效，不用手动清缓存
                            try {
                                o.addProperty("modified", Files.getLastModifiedTime(file).toMillis());
                            } catch (IOException ignored) {
                                o.addProperty("modified", 0);
                            }
                            if (instLoader != null && !isWorld) {
                                String modLoader = ModScanService.detectLoader(file);
                                if (modLoader != null) {
                                    o.addProperty("loader", modLoader);
                                    o.addProperty("conflict",
                                            ModScanService.loaderConflict(modLoader, instLoader));
                                }
                            }
                            items.add(o);
                        }
                    }
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to list addons of " + instanceId, e);
            root.addProperty("error", String.valueOf(e.getMessage()));
        }

        root.add("items", items);
        return JsonUtils.GSON.toJson(root);
    }

    /// 内容列表里的那张小图标。
    ///
    /// <p>从本地文件里挖（模组 jar 的 icon.png、资源包的 pack.png、存档的
    /// icon.png），取不到就返回 null，前端换成字母占位。
    public byte[] addonIcon(String instanceId, String kind, String fileName) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                return null;
            }
            // 只认文件名：挡住前端传进来的 `../..`
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            return AddonIcons.read(dir.resolve(leaf), kind);
        } catch (Exception e) {
            LOG.warning("Failed to read addon icon " + fileName, e);
            return null;
        }
    }

    /// 启用 / 禁用。禁用就是加 `.disabled` 后缀，和 HMCL 一致——
    /// 游戏只加载后缀为 `.jar` 的文件，改名后自然不生效。
    public void setAddonEnabled(String instanceId, String kind, String fileName, boolean enabled) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                return;
            }
            // 只取文件名，防止前端传进来 `../..` 之类
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            Path current = dir.resolve(leaf);
            if (!Files.isRegularFile(current)) {
                return;
            }

            String plain = leaf.endsWith(".disabled")
                    ? leaf.substring(0, leaf.length() - ".disabled".length())
                    : leaf;
            Path target = dir.resolve(enabled ? plain : plain + ".disabled");
            if (!current.equals(target)) {
                Files.move(current, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
            pushAddons(instanceId, kind);
        } catch (Exception e) {
            LOG.warning("Failed to toggle addon " + fileName, e);
        }
    }

    /// 批量启用 / 禁用。
    ///
    /// <p>一次请求处理一批：前端逐个调用 `setAddonEnabled` 会变成 N 个 HTTP 往返、
    /// N 次列表重推，50 个模组能卡好几秒。这里只在最后推一次列表。
    public void addonBatchEnabled(String instanceId, String kind, String filesJson, boolean enabled) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null) {
                return;
            }
            for (String raw : parseFileList(filesJson)) {
                String leaf = java.nio.file.Path.of(raw).getFileName().toString();
                Path current = dir.resolve(leaf);
                if (!Files.isRegularFile(current)) {
                    continue;
                }
                String plain = leaf.endsWith(".disabled")
                        ? leaf.substring(0, leaf.length() - ".disabled".length())
                        : leaf;
                Path target = dir.resolve(enabled ? plain : plain + ".disabled");
                try {
                    if (!current.equals(target)) {
                        Files.move(current, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    }
                } catch (Exception e) {
                    LOG.warning("Failed to toggle addon " + leaf, e);
                }
            }
            pushAddons(instanceId, kind);
        } catch (Exception e) {
            LOG.warning("Failed to batch toggle addons", e);
        }
    }

    /// 批量删除。存档是目录，得整个删掉。
    public void addonBatchRemove(String instanceId, String kind, String filesJson) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null) {
                return;
            }
            for (String raw : parseFileList(filesJson)) {
                String leaf = java.nio.file.Path.of(raw).getFileName().toString();
                Path target = dir.resolve(leaf);
                try {
                    if ("world".equals(kind) && Files.isDirectory(target)) {
                        try (var walk = Files.walk(target)) {
                            List<Path> all = walk.sorted(Comparator.reverseOrder()).toList();
                            for (Path p : all) {
                                Files.deleteIfExists(p);
                            }
                        }
                    } else {
                        Files.deleteIfExists(target);
                    }
                } catch (Exception e) {
                    LOG.warning("Failed to delete addon " + leaf, e);
                }
            }
            pushAddons(instanceId, kind);
        } catch (Exception e) {
            LOG.warning("Failed to batch remove addons", e);
        }
    }

    /// 前端传的是 JSON 数组字符串（文件名可能带引号、空格，不适合逗号分隔）。
    private static List<String> parseFileList(String json) {
        List<String> out = new ArrayList<>();
        if (json == null || json.isBlank()) {
            return out;
        }
        try {
            var parsed = com.google.gson.JsonParser.parseString(json);
            if (!parsed.isJsonArray()) {
                return out;
            }
            for (com.google.gson.JsonElement e : parsed.getAsJsonArray()) {
                if (e.isJsonPrimitive()) {
                    out.add(e.getAsString());
                }
            }
        } catch (Exception e) {
            LOG.warning("Bad file list: " + json, e);
        }
        return out;
    }

    /// 模组详情：文件信息 + jar 里读出来的元数据。右键「查看模组详情」用。
    public String addonDetails(String instanceId, String kind, String fileName) {
        JsonObject o = new JsonObject();
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                o.addProperty("error", "参数不完整");
                return JsonUtils.GSON.toJson(o);
            }
            // 只取文件名，挡住前端传进来的 `../..`
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            Path file = dir.resolve(leaf);
            if (!Files.isRegularFile(file)) {
                o.addProperty("error", "文件已经不在了");
                return JsonUtils.GSON.toJson(o);
            }

            o.addProperty("fileName", leaf);
            o.addProperty("path", file.toString());
            try {
                o.addProperty("size", Files.size(file));
                o.addProperty("modified", Files.getLastModifiedTime(file).toMillis());
            } catch (IOException ignored) {
                // 大小/时间读不到不影响别的字段
            }
            String loader = ModScanService.detectLoader(file);
            if (loader != null) {
                o.addProperty("loader", loader);
                o.addProperty("conflict",
                        ModScanService.loaderConflict(loader, instanceLoaderName(instanceId)));
            }
            JsonObject meta = ModScanService.describe(file);
            if (meta.has("ok") && meta.get("ok").getAsBoolean()) {
                o.add("meta", meta);
            }
        } catch (Exception e) {
            LOG.warning("Failed to read addon details", e);
            o.addProperty("error", String.valueOf(e.getMessage()));
        }
        return JsonUtils.GSON.toJson(o);
    }

    /// 在资源管理器里定位到某个文件 —— 打开父目录并选中它，不是只打开目录。
    ///
    /// Windows 用 `explorer /select,`，macOS 用 `open -R`，其它平台退化成打开
    /// 父目录：用户至少能自己找过去，总比什么都不发生强。
    public void showAddonInExplorer(String instanceId, String kind, String fileName) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                return;
            }
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            Path file = dir.resolve(leaf);
            if (!Files.exists(file)) {
                host.toast("文件已经不在了");
                return;
            }

            String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
            if (os.contains("win")) {
                // `/select,` 和路径分两个参数传：ProcessBuilder 会自动给带空格的
                // 路径加引号，拼成一整串反而会被 explorer 当成一个畸形参数
                new ProcessBuilder("explorer.exe", "/select,", file.toString()).start();
            } else if (os.contains("mac")) {
                new ProcessBuilder("open", "-R", file.toString()).start();
            } else {
                org.jackhuang.hmcl.ui.FXUtils.openFolder(file.getParent());
            }
        } catch (Exception e) {
            LOG.warning("Failed to reveal addon in explorer", e);
            host.toast("打开文件夹失败");
        }
    }

    public void removeAddon(String instanceId, String kind, String fileName) {
        try {
            Path dir = addonDir(instanceId, kind);
            if (dir == null || fileName == null || fileName.isBlank()) {
                return;
            }
            String leaf = java.nio.file.Path.of(fileName).getFileName().toString();
            Path target = dir.resolve(leaf);
            if ("world".equals(kind) && Files.isDirectory(target)) {
                // 存档是目录，得整个删掉
                try (var walk = Files.walk(target)) {
                    List<Path> all = walk.sorted(Comparator.reverseOrder()).toList();
                    for (Path p : all) {
                        Files.deleteIfExists(p);
                    }
                }
            } else {
                Files.deleteIfExists(target);
            }
            pushAddons(instanceId, kind);
        } catch (Exception e) {
            LOG.warning("Failed to delete addon " + fileName, e);
        }
    }

    private void pushAddons(String instanceId, String kind) {
        String json = instanceAddons(instanceId, kind);
        host.execute("window.__hmcl && window.__hmcl.onInstanceAddons("
                + JsonUtils.GSON.toJson(json) + ")");
    }

    @Nullable
    /// 实例的加载器名（Fabric / Forge / NeoForge / Quilt / 原版）。
    /// 和实例详情里那个 `loader` 字段同源，冲突检测要拿它跟 jar 的元数据比。
    private static String instanceLoaderName(String instanceId) {
        try {
            var instance = GameDirectoryManager.getSelectedRepository()
                    .getInstance(new GameInstanceID(instanceId));
            for (GameComponentType type : GameComponentType.MOD_LOADERS) {
                if (instance.getComponentVersion(type) != null) {
                    var loaderType = type.getModLoaderType();
                    return loaderType != null ? loaderType.displayName() : type.name();
                }
            }
        } catch (Exception e) {
            // 认不出就当原版，不判冲突
        }
        return "原版";
    }

    static Path addonDir(String instanceId, String kind) {
        if (instanceId == null || instanceId.isBlank()) {
            return null;
        }
        String sub = switch (kind == null ? "" : kind) {
            case "resourcepack" -> "resourcepacks";
            case "shader" -> "shaderpacks";
            // 世界是 saves/ 下的一堆目录，不是文件——列表和删除都要单独处理
            case "world" -> "saves";
            // 蓝图与截图同样是查看为主：蓝图是 .schematic/.litematic 文件，
            // 截图是 .png。两者都不参与加载，没有启用/禁用
            case "schematic" -> "schematics";
            case "screenshot" -> "screenshots";
            default -> "mods";
        };
        try {
            var repository = GameDirectoryManager.getSelectedRepository();
            if (repository == null) {
                return null;
            }
            var instance = repository.findInstance(new org.jackhuang.hmcl.game.GameInstanceID(instanceId));
            if (instance == null) {
                return null;
            }
            return instance.getRunDirectory().resolve(sub).toAbsolutePath();
        } catch (Exception e) {
            return null;
        }
    }

    // ==================== 内容下载（模组 / 资源包 / 光影 / 整合包 / 世界） ====================

    /// 搜索。type: mod / modpack / resourcepack / shader / world
    /// gameVersion 为空表示不按游戏版本过滤，loader 为空表示不按加载器过滤，
    /// category 是逗号分隔的类别 slug（Modrinth `/v2/tag/category` 里的 name），
    /// reqId 由前端生成，只用于丢弃迟到的响应。
    public void addonSearch(String type, String gameVersion, String query, String page, String sort,
                            String loader, String category, String reqId, String source) {
        int p = 0;
        try {
            p = page == null || page.isBlank() ? 0 : Integer.parseInt(page.trim());
        } catch (NumberFormatException ignored) {
        }
        services.addons.search(type, gameVersion, query, p, sort, loader, category, reqId, source);
    }

    /// 某个类型可用的类别，按当前内容平台取。
    ///
    /// 平台参数不能省：Modrinth 的类别是 `adventure` 这类 slug，CurseForge 是 434 这类
    /// 数字 id，两套完全不通用。切了平台还挂旧表，点哪个类别都搜不出东西。
    public void addonCategories(String type, String source) {
        services.addons.categories(type, source);
    }

    /// 某个项目的全部可用版本（已按游戏版本 + 加载器筛过，新的在前）
    /// 内容平台能不能用 CurseForge。没配 API Key 时前端会把那个选项禁掉 ——
    /// 让用户切过去搜出一片空白，比直接告诉他「没配密钥」更糟。
    public boolean curseForgeAvailable() {
        return org.jackhuang.hmcl.addon.repository.CurseForgeRemoteAddonRepository.isAvailable();
    }

    /// 内容平台选择。目前搜索/版本/安装都只接了 Modrinth，CurseForge 只有世界在走；
    /// 这里先接住这个调用，免得前端点了报「方法不存在」。
    public void setAddonSource(String source) {
        if ("curseforge".equals(source) && !curseForgeAvailable()) {
            host.toast("CurseForge 需要 API Key，当前先用 Modrinth");
        }
    }

    public void addonVersions(String type, String slug, String gameVersion, String loader) {
        services.addons.versions(type, slug, gameVersion, loader);
    }

    /// 依赖检查里点「安装」的第一步：把 mod id 翻译成 Modrinth 的 slug。
    ///
    /// `fabric.mod.json` 里只有 id（sodium 这种），列版本要的是 slug，两者大多数时候
    /// 一致但不保证。结果通过 `onAddonResolved` 推回去，前端拿到 slug 再走正常流程。
    public void resolveAddonSlug(String modId, String gameVersion, String loader) {
        services.addons.resolveModSlug(modId, gameVersion, loader);
    }

    /// 下载到实例的 mods / resourcepacks / shaderpacks。instanceId 为空时用当前选中实例。
    /// fileName 非空则改名保存；directory 非空则存到这里（用户没选实例时挑的目录）。
    public void addonInstall(String type, String slug, String versionId, String instanceId,
                             String fileName, String directory) {
        services.addons.install(type, slug, versionId, instanceId, fileName, directory);
    }

    /// 这个类型默认存到哪儿（确认弹窗里显示给用户看）
    public String addonTargetDirectory(String type, String instanceId) {
        return services.addons.defaultTargetDirectory(type, instanceId);
    }

    /// 检查实例里已装模组 / 资源包 / 光影有没有新版本。
    ///
    /// <p>按文件指纹到 Modrinth / CurseForge 反查，结果从 `onAddonUpdates` 推回来。
    /// `kinds` 逗号分隔（mod,resourcepack,shader），空表示全查。
    public void addonUpdateCheck(String instanceId, String kinds) {
        services.addons.checkAddonUpdates(instanceId, kinds);
    }

    /// 应用一批更新。itemsJson 是 `[{kind,file,fileName,downloadUrl,source,name}]`。
    public void addonUpdateApply(String instanceId, String itemsJson) {
        services.addons.applyAddonUpdates(instanceId, itemsJson);
    }

    /// 拉某个游戏版本可用的加载器版本（fabric / quilt / forge / neoforge）
    public void requestLoaderVersions(String gameVersion, String loaderType) {
        services.download.requestLoaderVersions(gameVersion, loaderType);
    }

    /// 问一遍各加载器在这个游戏版本下能不能装。
    /// 前端据此把不能装的卡片置灰，省掉「点开→拉清单→说没有」那一趟。
    public void requestInstallerSupport(String gameVersion) {
        services.download.requestInstallerSupport(gameVersion);
    }

    /// 安装「游戏 + 加载器」到新实例
    public void installLoader(String gameVersion, String loaderType, String loaderVersion) {
        services.download.installLoader(gameVersion, loaderType, loaderVersion);
    }

    public void installLoaderNamed(String gameVersion, String loaderType, String loaderVersion, String instanceName) {
        services.download.installLoader(gameVersion, loaderType, loaderVersion, instanceName);
    }

    /// 某个实例上已经装了哪些组件。给安装弹窗的「已有实例」模式用：
    /// 装了哪个就显示哪个的版本号，旁边配 ✕（卸载）和 ↻（重装）。
    public String instanceInstallers(String instanceId) {
        JsonObject root = new JsonObject();
        JsonArray items = new JsonArray();

        try {
            var repository = GameDirectoryManager.getSelectedRepository();
            // 用 findInstance：实例不存在时返回 null，不抛异常
            var instance = repository.findInstance(new org.jackhuang.hmcl.game.GameInstanceID(instanceId));
            if (instance == null) {
                root.addProperty("error", "找不到实例 " + instanceId);
            } else {
                // 用 getManifest（未解析的原始 manifest）：resolved 那份会把 patches
                // 展开成 libraries，反而查不到「装了哪个加载器的哪个版本」
                var manifest = instance.getManifest();
                // 主版本单独报一次，前端用它确认实例跟弹窗的游戏版本对不对得上
                var game = manifest.findPatch(org.jackhuang.hmcl.game.GameComponentType.GAME);
                if (game != null && game.version() != null) {
                    root.addProperty("gameVersion", game.version());
                }
                for (org.jackhuang.hmcl.game.GameComponentType type
                        : org.jackhuang.hmcl.game.GameComponentType.values()) {
                    if (type == org.jackhuang.hmcl.game.GameComponentType.GAME) {
                        continue;
                    }
                    var patch = manifest.findPatch(type);
                    if (patch == null || patch.version() == null) {
                        continue;
                    }
                    JsonObject o = new JsonObject();
                    o.addProperty("id", type.getPatchId());
                    o.addProperty("version", patch.version());
                    items.add(o);
                }
            }
        } catch (Exception e) {
            LOG.warning("Failed to read installers of " + instanceId, e);
            root.addProperty("error", String.valueOf(e.getMessage()));
        }

        root.add("installed", items);
        return JsonUtils.GSON.toJson(root);
    }
}
