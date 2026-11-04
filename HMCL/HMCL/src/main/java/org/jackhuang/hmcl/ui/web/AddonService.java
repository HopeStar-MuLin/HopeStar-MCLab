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
import javafx.application.Platform;
import org.jackhuang.hmcl.addon.AddonLoader;
import org.jackhuang.hmcl.addon.RemoteAddon;
import org.jackhuang.hmcl.addon.RemoteAddonRepository;
import org.jackhuang.hmcl.addon.repository.CurseForgeRemoteAddonRepository;
import org.jackhuang.hmcl.download.DownloadProvider;
import org.jackhuang.hmcl.game.GameInstanceID;
import org.jackhuang.hmcl.game.HMCLGameInstance;
import org.jackhuang.hmcl.game.HMCLGameRepository;
import org.jackhuang.hmcl.game.ModpackHelper;
import org.jackhuang.hmcl.game.ManuallyCreatedModpackException;
import org.jackhuang.hmcl.modpack.Modpack;
import org.jackhuang.hmcl.modpack.ModpackConfiguration;
import org.jackhuang.hmcl.setting.DownloadProviders;
import org.jackhuang.hmcl.setting.GameDirectoryManager;
import org.jackhuang.hmcl.task.FileDownloadTask;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.task.TaskExecutor;
import org.jackhuang.hmcl.task.TaskListener;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.HttpRequest;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import org.jetbrains.annotations.Nullable;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 下载页的「内容」部分：模组 / 资源包 / 光影 / 整合包 / 世界。
///
/// <p>数据全部来自 Modrinth（`{@link RemoteAddon.Source#MODRINTH}`），
/// 走 HMCL 自带的那套 `RemoteAddonRepository`，不自己拼 HTTP 请求——
/// 它已经处理了镜像候选、限流、重试和 JSON 反序列化。
///
/// <p>为什么世界没有在线列表：Modrinth 只有 mod / modpack / resourcepack /
/// shader / datapack 五类，没有 world。HMCL 的世界页走 CurseForge，
/// 而 CurseForge 的 API key 是 HMCL 构建时注入的（`hmcl.curseforge.apikey`
/// 系统属性），源码里没有，所以这边拿不到。世界只能本地导入。
///
/// <p>前端契约（都在 `window.__hmcl` 上）：
/// <ul>
///   <li>`onAddonSearch(json)`：`{type, page, totalPages, total, items[]}`</li>
///   <li>`onAddonVersions(json)`：`{type, slug, items[]}`</li>
///   <li>`onInstallStage(json)`：复用下载页那条进度通道</li>
/// </ul>
final class AddonService {

    private static final int PAGE_SIZE = 20;

    /// Modrinth 的 HTTP API。**不走 `RemoteAddonRepository`**，原因见 `fetchSearch` 的注释。
    private static final String API = "https://api.modrinth.com/v2";

    /// 一个可下载的版本。从 Modrinth 的 JSON 直接解出来，不经过 HMCL 的
    /// `RemoteAddon.Version`——那套要走 `RemoteAddonRepository`，会把整个项目的
    /// 全部版本拉下来（Fabric API 有 1217 个，1MB），再在本地过滤。
    private record AddonVersion(String versionId, String name, String number, String type,
                                String date, List<String> loaders, List<String> gameVersions,
                                String fileUrl, String filename, long fileSize, int downloads) {
    }

    /// `/v2/tag/category` 的原始响应。这张表一天到晚不变，进程内缓存一份，
    /// 切换分类标签时不再走网络（126 条、约 40KB，带一堆内联 SVG）。
    private static volatile JsonArray categoryTagCache;
    private static volatile long categoryTagAt;
    private static final long CATEGORY_TTL_MS = 6L * 60 * 60 * 1000;

    /// 与 `DownloadService` 同一格式的进度通道
    private final Consumer<String> push;

    /// 任务进度（`onInstallStage`）的唯一出口，见 `TaskProgress`
    private final TaskProgress progress;

    AddonService(Consumer<String> push) {
        this.push = push;
        this.progress = new TaskProgress(push);
    }

    // ==================== 搜索 ====================

    /// `reqId` 是前端发来的请求序号，只做原样回传。
    /// 类别是芯片，用户常常连点两下：两个请求同时在路上，谁先回来不一定，
    /// 后回来的那个会把新结果盖成旧结果。前端拿 reqId 一比就能丢掉过期响应。
    void search(String type, String gameVersion, String query, int page, String sort, String loader,
                @Nullable String category, @Nullable String reqId) {
        search(type, gameVersion, query, page, sort, loader, category, reqId, null);
    }

    void search(String type, String gameVersion, String query, int page, String sort, String loader,
                @Nullable String category, @Nullable String reqId, @Nullable String source) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null) {
            pushSearchJson(type, reqId, null, new IllegalArgumentException("不支持的资源类型：" + type), 0, 0);
            return;
        }

        // 世界只有 CurseForge（Modrinth 没有 world 这个类型）；其它类型看用户选的平台。
        // CurseForge 没 key 时模组这边退回 Modrinth，总比给个空列表强；
        // 世界没得退，只能报错。
        boolean wantCf = addonType == RemoteAddon.Type.WORLD || "curseforge".equals(source);
        if (wantCf && CurseForgeRemoteAddonRepository.isAvailable()) {
            searchCurseForge(type, cfClassId(addonType), gameVersion, query, page, sort, loader, category, reqId);
            return;
        }
        if (addonType == RemoteAddon.Type.WORLD) {
            pushSearchJson(type, reqId, null, new IOException("CurseForge 需要 API Key"), 0, 0);
            return;
        }

        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                JsonObject root = NetRetry.call("search " + type,
                        () -> fetchSearch(addonType, gameVersion, query, page, sort, loader, category));
                int totalHits = root.has("total_hits") ? root.get("total_hits").getAsInt() : 0;
                int totalPages = totalHits <= 0 ? 0 : (int) Math.ceil((double) totalHits / PAGE_SIZE);
                LOG.info("[addon] search " + type + " q=" + query + " page=" + page + " cat=" + category
                        + " loader=" + loader
                        + " hits=" + totalHits + " in " + (System.currentTimeMillis() - started) + "ms");
                pushSearchJson(type, reqId, root.getAsJsonArray("hits"), null,
                        Math.max(0, page), totalPages);
            } catch (Exception e) {
                LOG.warning("Addon search failed: " + type + " / " + query, e);
                pushSearchJson(type, reqId, null, e, Math.max(0, page), 0);
            }
        }).start();
    }

    /// 直接打 `api.modrinth.com/v2/search`。
    ///
    /// 为什么不走 `RemoteAddonRepository.search`：它内部用
    /// `DownloadProvider.getVersionListCandidates`，会**串行**试一串镜像候选
    /// （`mod.mcimirror.top` 现在 503，每个都要等超时才换下一个），
    /// 实测一次搜索 8 秒起步。而 `api.modrinth.com` 本身是通的（700ms 内返回），
    /// 直接请求就快了一个数量级。
    ///
    /// facets 是「组间 AND、组内 OR」：`[[type],[version],[cat1,cat2],[loader]]`，
    /// 所以多个类别是「任一命中」，类别和游戏版本之间是「同时满足」。
    private static JsonObject fetchSearch(RemoteAddon.Type type, @Nullable String gameVersion,
                                          @Nullable String query, int page, @Nullable String sort,
                                          @Nullable String loader, @Nullable String category) throws IOException {
        String projectType = projectTypeOf(type);
        if (projectType == null) {
            throw new IOException("不支持的类型：" + type);
        }

        JsonArray facets = new JsonArray();
        JsonArray typeFacet = new JsonArray();
        typeFacet.add("project_type:" + projectType);
        facets.add(typeFacet);
        if (gameVersion != null && !gameVersion.isBlank()) {
            JsonArray versionFacet = new JsonArray();
            versionFacet.add("versions:" + gameVersion);
            facets.add(versionFacet);
        }
        // 加载器：模组必须跟实例的加载器对上。之前这个参数一路传下来却没进 facet，
        // 结果 Fabric 实例搜出来一堆 Forge 模组，点进去一个版本都装不上。
        String loaderSlug = modrinthLoader(loader);
        if (loaderSlug != null) {
            JsonArray loaderFacet = new JsonArray();
            loaderFacet.add("loaders:" + loaderSlug);
            facets.add(loaderFacet);
        }
        if (category != null && !category.isBlank()) {
            JsonArray categoryFacet = new JsonArray();
            for (String raw : category.split(",")) {
                String slug = raw.strip().toLowerCase(Locale.ROOT);
                if (!slug.isEmpty()) {
                    categoryFacet.add("categories:" + slug);
                }
            }
            if (categoryFacet.size() > 0) {
                facets.add(categoryFacet);
            }
        }

        String url = API + "/search"
                + "?limit=" + PAGE_SIZE
                + "&offset=" + (Math.max(0, page) * PAGE_SIZE)
                + "&index=" + sortIndex(sort)
                + "&query=" + enc(query == null ? "" : query)
                + "&facets=" + enc(facets.toString());

        return HttpRequest.GET(url).getJson(JsonObject.class);
    }

    /// HMCL 的加载器显示名 → Modrinth 的 `loaders` 取值。
    ///
    /// 直接小写是不够的：Modrinth 的 facet **大小写敏感**，
    /// `loaders:["Fabric"]` 返回 0 条、`loaders:["fabric"]` 返回 47423 条（实测）。
    /// 另外 `Legacy Fabric` 在 Modrinth 上叫 `legacy-fabric`（连字符），
    /// `Cleanroom` 则根本没有对应值。
    ///
    /// 对不上时返回 null，表示「不按加载器筛」——给多几条让人自己挑，
    /// 比给零条、看着像下载源挂了要好。
    @Nullable
    private static String modrinthLoader(@Nullable String loader) {
        if (loader == null || loader.isBlank()) {
            return null;
        }
        return switch (loader.strip().toLowerCase(Locale.ROOT)) {
            case "fabric" -> "fabric";
            case "forge" -> "forge";
            case "neoforge" -> "neoforge";
            case "quilt" -> "quilt";
            case "liteloader" -> "liteloader";
            case "legacy fabric", "legacy-fabric" -> "legacy-fabric";
            default -> null;
        };
    }

    private static List<String> stringList(JsonObject object, String key) {
        List<String> out = new ArrayList<>();
        if (object == null || !object.has(key) || !object.get(key).isJsonArray()) {
            return out;
        }
        for (JsonElement e : object.getAsJsonArray(key)) {
            if (e.isJsonPrimitive()) {
                out.add(e.getAsString());
            }
        }
        return out;
    }

    private static long longValue(JsonObject object, String key) {
        try {
            return object != null && object.has(key) && !object.get(key).isJsonNull()
                    ? object.get(key).getAsLong() : 0L;
        } catch (Exception e) {
            return 0L;
        }
    }

    private static int intValue(JsonObject object, String key) {
        try {
            return object != null && object.has(key) && !object.get(key).isJsonNull()
                    ? object.get(key).getAsInt() : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    /// 主文件的字节数。版本列表里要显示大小，让用户知道下的是 2KB 的补丁还是 200MB 的整合包。
    private static long fileSize(JsonObject version) {
        if (version == null || !version.has("files") || !version.get("files").isJsonArray()) {
            return 0L;
        }
        JsonArray files = version.getAsJsonArray("files");
        if (files.size() == 0 || !files.get(0).isJsonObject()) {
            return 0L;
        }
        try {
            JsonObject file = files.get(0).getAsJsonObject();
            return file.has("size") && !file.get("size").isJsonNull() ? file.get("size").getAsLong() : 0L;
        } catch (Exception e) {
            return 0L;
        }
    }

    private static String optString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return "";
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String sortIndex(@Nullable String sort) {
        if (sort == null) {
            return "relevance";
        }
        return switch (sort.toLowerCase(Locale.ROOT)) {
            case "downloads" -> "downloads";
            case "updated" -> "updated";
            case "new" -> "newest";
            case "popular" -> "follows";
            default -> "relevance";
        };
    }

    private static String enc(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private void pushSearchJson(String type, @Nullable String reqId, @Nullable JsonArray hits,
                                @Nullable Exception error, int page, int totalPages) {
        JsonObject root = new JsonObject();
        root.addProperty("type", type);
        root.addProperty("page", page);
        root.addProperty("totalPages", totalPages);
        if (reqId != null) {
            root.addProperty("reqId", reqId);
        }

        JsonArray array = new JsonArray();
        if (error != null) {
            root.addProperty("error", error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
            root.add("items", new JsonArray());
        } else {
            if (hits != null) {
                for (JsonElement element : hits) {
                    if (!element.isJsonObject()) {
                        continue;
                    }
                    JsonObject hit = element.getAsJsonObject();
                    JsonObject o = new JsonObject();
                    // slug 同时是 Modrinth 的项目 id：/v2/project/{slug}/version 两种都能用
                    o.addProperty("slug", optString(hit, "slug"));
                    o.addProperty("title", optString(hit, "title"));
                    o.addProperty("description", optString(hit, "description"));
                    o.addProperty("author", optString(hit, "author"));

                    // 两个来源的字段名不一样（Modrinth 是 icon_url / project_url /
                    // display_categories，我们自己给 CurseForge 用的是驼峰）。
                    // 这里两边都认一次，否则世界的图标和分类会被整段丢掉，
                    // 卡片全变成字母占位。
                    String icon = optString(hit, "icon_url");
                    if (icon.isBlank()) {
                        icon = optString(hit, "iconUrl");
                    }
                    o.addProperty("iconUrl", icon);

                    String pageUrl = optString(hit, "project_url");
                    if (pageUrl.isBlank()) {
                        pageUrl = optString(hit, "pageUrl");
                    }
                    o.addProperty("pageUrl", pageUrl);

                    JsonArray cats = new JsonArray();
                    // display_categories 里既有内容分类（库 / 优化）也有加载器
                    // （Fabric / Forge），HMCL 的卡片就是全列出来的
                    JsonArray raw = null;
                    if (hit.has("display_categories") && hit.get("display_categories").isJsonArray()) {
                        raw = hit.getAsJsonArray("display_categories");
                    } else if (hit.has("categories") && hit.get("categories").isJsonArray()) {
                        raw = hit.getAsJsonArray("categories");
                    }
                    if (raw != null) {
                        for (int i = 0; i < raw.size() && i < 8; i++) {
                            JsonElement c = raw.get(i);
                            if (c.isJsonPrimitive()) {
                                cats.add(c.getAsString());
                            }
                        }
                    }
                    o.add("categories", cats);
                    array.add(o);
                }
            }
            root.add("items", array);
        }

        String text = JsonUtils.GSON.toJson(root);
        push.accept("window.__hmcl && window.__hmcl.onAddonSearch("
                + JsonUtils.GSON.toJson(text) + ")");

        // 数据已经推给前端了，图标在后台慢慢抓。
        // 用户还在看第一屏，后面的图已经落到磁盘缓存里，滚下去就是缓存命中。
        if (error == null) {
            prefetchIcons(array);
        }
    }

    /// 后台预取这一页的图标。串行就够了——并发反而会和前端的请求撞车。
    private void prefetchIcons(JsonArray items) {
        if (items == null || items.size() == 0) {
            return;
        }
        List<String> urls = new ArrayList<>();
        for (JsonElement element : items) {
            if (!element.isJsonObject()) {
                continue;
            }
            String icon = optString(element.getAsJsonObject(), "iconUrl");
            if (!icon.isBlank()) {
                urls.add(icon);
            }
        }
        if (urls.isEmpty()) {
            return;
        }

        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            int ok = 0;
            for (String url : urls) {
                try {
                    if (IconCache.getInstance().resolve(url) != null) {
                        ok++;
                    }
                } catch (Exception ignored) {
                    // 单个图标失败无所谓，前端会显示首字母占位
                }
            }
            LOG.info("[addon] 预取图标 " + ok + "/" + urls.size()
                    + "，用时 " + (System.currentTimeMillis() - started) + "ms");
        }).start();
    }

    // ==================== 类别标签 ====================

    /// 拉当前平台的分类表，按资源类型筛出来推给前端。
    ///
    /// **两家平台的分类完全不是一套东西**，slug 也不通用：Modrinth 是
    /// `adventure` / `optimization` 这样的字符串，CurseForge 是 434 / 4485 这样的数字 id。
    /// 所以 `source` 必须参与，否则切到 CurseForge 还挂着一份 Modrinth 的类别，
    /// 点哪个都搜不出东西。
    ///
    /// 分类**不做本地硬编码**：Modrinth 会加新类别（`adventure` / `quests` 都是后加的），
    /// CurseForge 那边连子分类都是作者自建的。写死一份表就会永远缺。
    void categories(String type, @Nullable String source) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null) {
            pushCategories(type, "modrinth", new JsonArray(), null);
            return;
        }
        // 世界只有 CurseForge，平台参数长什么样都得走 CF 那套
        boolean cf = addonType == RemoteAddon.Type.WORLD
                || "curseforge".equalsIgnoreCase(source);
        String platform = cf ? "curseforge" : "modrinth";
        if (cf) {
            pushCurseForgeCategories(addonType, platform);
            return;
        }

        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                JsonArray groups = buildCategoryGroups(addonType);
                LOG.info("[addon] categories " + type + " → " + groups.size() + " 组，用时 "
                        + (System.currentTimeMillis() - started) + "ms");
                pushCategories(type, platform, groups, null);
            } catch (Exception e) {
                LOG.warning("Failed to load categories of " + type, e);
                pushCategories(type, platform, new JsonArray(), e);
            }
        }).start();
    }

    /// 分组结果：`[{key:"categories", items:[{slug:"adventure"}]}]`
    private static JsonArray buildCategoryGroups(RemoteAddon.Type type) throws IOException {
        String projectType = projectTypeOf(type);
        if (projectType == null) {
            return new JsonArray();
        }

        JsonArray tags = categoryTags();

        // LinkedHashMap 保序：接口给的顺序就是「类别 → 特性 → 分辨率」，
        // 换成 HashMap 每次启动顺序都不一样，用户会觉得界面在乱跳
        java.util.LinkedHashMap<String, JsonArray> groups = new java.util.LinkedHashMap<>();
        for (JsonElement element : tags) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject tag = element.getAsJsonObject();
            if (!projectType.equals(optString(tag, "project_type"))) {
                continue;
            }
            String slug = optString(tag, "name");
            if (slug.isBlank()) {
                continue;
            }
            String header = optString(tag, "header");
            if (header.isBlank()) {
                header = "categories";
            }
            JsonObject item = new JsonObject();
            item.addProperty("slug", slug);
            groups.computeIfAbsent(header, k -> new JsonArray()).add(item);
        }

        // 顺序固定成「类别 → 特性 → 分辨率 → 性能影响」。
        // 接口那边的顺序不保证（资源包第一组给的是 resolutions），
        // 前端把它们平铺进一个下拉，所以「类别」必须排最前面 ——
        // 玩家找「冒险」「优化」都在这一组，被分辨率挤到后面等于藏起来了。
        JsonArray out = new JsonArray();
        for (String key : new String[]{"categories", "features", "resolutions", "performance impact"}) {
            JsonArray items = groups.remove(key);
            if (items == null || items.size() == 0) {
                continue;
            }
            JsonObject group = new JsonObject();
            group.addProperty("key", key);
            group.add("items", items);
            out.add(group);
        }
        // 接口以后加了新 header 也不能丢，剩下的按原顺序接在后面
        groups.forEach((header, items) -> {
            JsonObject group = new JsonObject();
            group.addProperty("key", header);
            group.add("items", items);
            out.add(group);
        });
        return out;
    }

    /// 带 TTL 的进程内缓存。失败不缓存——网络恢复后下一次点击应该就好了。
    private static JsonArray categoryTags() throws IOException {
        JsonArray cached = categoryTagCache;
        if (cached != null && System.currentTimeMillis() - categoryTagAt < CATEGORY_TTL_MS) {
            return cached;
        }
        synchronized (AddonService.class) {
            JsonArray again = categoryTagCache;
            if (again != null && System.currentTimeMillis() - categoryTagAt < CATEGORY_TTL_MS) {
                return again;
            }
            JsonArray fresh = HttpRequest.GET(API + "/tag/category").getJson(JsonArray.class);
            categoryTagCache = fresh;
            categoryTagAt = System.currentTimeMillis();
            return fresh;
        }
    }

    private void pushCategories(String type, String source, JsonArray groups, @Nullable Exception error) {
        JsonObject root = new JsonObject();
        root.addProperty("type", type);
        // 平台也得带回去：分类表两套，前端缓存按 type|source 分开存
        root.addProperty("source", source);
        if (error != null) {
            root.addProperty("error", error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
        }
        root.add("groups", groups);

        String text = JsonUtils.GSON.toJson(root);
        push.accept("window.__hmcl && window.__hmcl.onAddonCategories("
                + JsonUtils.GSON.toJson(text) + ")");
    }

    @Nullable
    private static String projectTypeOf(RemoteAddon.Type type) {
        return switch (type) {
            case MOD -> "mod";
            case MODPACK -> "modpack";
            case RESOURCE_PACK -> "resourcepack";
            case SHADER_PACK -> "shader";
            default -> null;
        };
    }

    // ==================== CurseForge（世界） ====================
    //
    // Modrinth 没有 world 类型（只有 mod / modpack / resourcepack / shader /
    // minecraft_java_server），地图和存档全世界都在 CurseForge，classId=17。
    //
    // 官方 API 要 `x-api-key`，key 由构建时的环境变量注入，落进 jar 里的
    // `assets/hmcl.properties`，运行期由 CurseForgeRemoteAddonRepository.API_KEY 读到。
    //
    // 这里没有复用 HMCL 的 RemoteAddonRepository，两个原因：
    //   1. 它的 getRemoteVersionsById 只认数字 id，而搜索结果给的是 slug，
    //      再查 /v1/mods/{slug} 是 404（实测）；
    //   2. 项目 id 藏在它的内部 record 里，外面取不到。
    // 直接打 CF 的 REST 接口更短，也方便把 id 和下载直链一起处理掉。

    private static final String CF_API = "https://api.curseforge.com";
    /// CurseForge 的「世界」分区 id，和 HMCL 的 SECTION_WORLD 一致。
    private static final int CF_CLASS_WORLD = 17;

    private static JsonObject cfGet(String path) throws IOException {
        String key = CurseForgeRemoteAddonRepository.API_KEY;
        if (key == null || key.isBlank()) {
            throw new IOException("这个构建里没有 CurseForge API Key，世界下载不可用");
        }
        return HttpRequest.GET(CF_API + path)
                .header("x-api-key", key)
                .header("Accept", "application/json")
                .getJson(JsonObject.class);
    }

    /// CurseForge 的分类表，按 classId 缓存 6 小时。
    ///
    /// 接口返回是**扁平的一层**，没有「组」的概念：`parentCategoryId` 等于 classId 的
    /// 才是玩家认知里的大类（科技 / 魔法 / 冒险），其余都是作者自建的子分类
    /// （`Create`、`Blood Magic`），拿它当筛选条件只会把结果缩到那几个模组。
    /// 所以这里只收顶级。
    private static volatile Map<Integer, Map<Integer, String>> cfCategoryCache;
    private static volatile long cfCategoryAt;

    private static Map<Integer, String> cfCategories(int classId) {
        Map<Integer, Map<Integer, String>> all = cfCategoryCache;
        if (all != null && all.containsKey(classId)
                && System.currentTimeMillis() - cfCategoryAt < 6 * 3600_000L) {
            return all.get(classId);
        }
        try {
            JsonObject root = cfGet("/v1/categories?gameId=432&classId=" + classId);
            Map<Integer, String> map = new java.util.LinkedHashMap<>();
            if (root.has("data") && root.get("data").isJsonArray()) {
                for (JsonElement e : root.getAsJsonArray("data")) {
                    if (!e.isJsonObject()) {
                        continue;
                    }
                    JsonObject c = e.getAsJsonObject();
                    // 只要顶级：parent 是 classId 本身。子分类的结构各类型不一样，
                    // 资源包那批干脆没有 parent，全都算顶级。
                    int parent = intValue(c, "parentCategoryId");
                    if (parent >= 0 && parent != classId) {
                        continue;
                    }
                    String name = optString(c, "name");
                    if (name.isBlank()) {
                        continue;
                    }
                    map.put(intValue(c, "id"), name);
                }
            }
            Map<Integer, Map<Integer, String>> merged = new java.util.HashMap<>();
            if (all != null && System.currentTimeMillis() - cfCategoryAt < 6 * 3600_000L) {
                merged.putAll(all);
            }
            merged.put(classId, map);
            cfCategoryCache = merged;
            cfCategoryAt = System.currentTimeMillis();
            return map;
        } catch (Exception e) {
            LOG.warning("Failed to load CurseForge categories of class " + classId, e);
            Map<Integer, String> cached = all == null ? null : all.get(classId);
            return cached != null ? cached : Map.of();
        }
    }

    /// CurseForge 的分类，形状按前端统一的 `[{key:"categories", items:[{slug,name}]}]` 给。
    private void pushCurseForgeCategories(RemoteAddon.Type type, String platform) {
        String typeName = typeNameOf(type);
        Task.runAsync(() -> {
            try {
                JsonArray items = new JsonArray();
                Map<Integer, String> categories = cfCategories(cfClassId(type));
                categories.forEach((id, name) -> {
                    JsonObject o = new JsonObject();
                    // slug 用数字 id：搜索的 categoryId 参数要的就是它
                    o.addProperty("slug", String.valueOf(id));
                    o.addProperty("name", name);
                    items.add(o);
                });
                JsonArray groups = new JsonArray();
                if (items.size() > 0) {
                    JsonObject group = new JsonObject();
                    group.addProperty("key", "categories");
                    group.add("items", items);
                    groups.add(group);
                }
                pushCategories(typeName, platform, groups, null);
            } catch (Exception e) {
                pushCategories(typeName, platform, new JsonArray(), e);
            }
        }).start();
    }

    /// CurseForge 的搜索。除了世界，模组 / 整合包 / 资源包 / 光影也走这里 ——
    /// 它和 Modrinth 是并行的两个平台，不是「世界的专用接口」。
    ///
    /// classId 是 CurseForge 的资源大类：模组 6、整合包 4471、资源包 12、
    /// 光影 6552、世界 17。传错这个参数会搜出完全不相干的东西。
    private void searchCurseForge(String type, int classId, String gameVersion, String query, int page,
                                  @Nullable String sort, @Nullable String loader,
                                  @Nullable String category, @Nullable String reqId) {
        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                StringBuilder path = new StringBuilder("/v1/mods/search?gameId=432&classId=" + classId);
                path.append("&index=").append(Math.max(0, page) * PAGE_SIZE);
                path.append("&pageSize=").append(PAGE_SIZE);
                path.append("&sortField=").append(cfSortField(sort));
                path.append("&sortOrder=desc");
                if (query != null && !query.isBlank()) {
                    path.append("&searchFilter=").append(enc(query));
                }
                // 实例的版本名带加载器后缀（1.21.1-fabric），CurseForge 只认纯版本号：
                // 带后缀查出来永远是 0 条（实测 curl 同条件下 1.21.1-fabric 空、
                // 1.21.1 有结果）。
                String mcVersion = gameVersion == null ? "" : gameVersion
                        .replaceAll("(?i)[-_](fabric|forge|neoforge|quilt|cleanroom|optifine|liteloader)$", "")
                        .trim();
                if (!mcVersion.isBlank()) {
                    path.append("&gameVersion=").append(enc(mcVersion));
                }
                int loaderId = cfLoaderId(loader);
                if (loaderId > 0) {
                    path.append("&modLoaderType=").append(loaderId);
                }
                // 类别是多选，CF 只吃一个 categoryId。取第一个就够了
                if (category != null) {
                    for (String part : category.split(",")) {
                        String id = part.trim();
                        if (!id.isEmpty() && id.chars().allMatch(Character::isDigit)) {
                            path.append("&categoryId=").append(id);
                            break;
                        }
                    }
                }

                JsonObject root = cfGet(path.toString());
                JsonArray data = root.has("data") && root.get("data").isJsonArray()
                        ? root.getAsJsonArray("data") : new JsonArray();
                int total = root.has("pagination") && root.get("pagination").isJsonObject()
                        ? intValue(root.getAsJsonObject("pagination"), "totalCount") : 0;
                int totalPages = total <= 0 ? 0 : (int) Math.ceil((double) total / PAGE_SIZE);

                JsonArray hits = new JsonArray();
                for (JsonElement e : data) {
                    if (!e.isJsonObject()) {
                        continue;
                    }
                    JsonObject m = e.getAsJsonObject();
                    String id = String.valueOf(intValue(m, "id"));

                    JsonObject o = new JsonObject();
                    // slug 直接给数字 id：后面的 versions / install 都用它，
                    // 因为 /v1/mods/oneblock 是 404（只认 id）
                    o.addProperty("slug", id);
                    o.addProperty("projectId", id);
                    o.addProperty("cfSlug", optString(m, "slug"));
                    o.addProperty("title", optString(m, "name"));
                    o.addProperty("description", optString(m, "summary"));
                    o.addProperty("author", cfAuthor(m));
                    o.addProperty("iconUrl", cfIcon(m));
                    o.addProperty("pageUrl", cfLink(m, "websiteUrl"));
                    o.addProperty("downloads", intValue(m, "downloadCount"));

                    JsonArray cats = new JsonArray();
                    if (m.has("categories") && m.get("categories").isJsonArray()) {
                        for (JsonElement ce : m.getAsJsonArray("categories")) {
                            if (!ce.isJsonObject()) {
                                continue;
                            }
                            // mod 对象里的分类自带 name，不用再查一次映射表
                            String name = optString(ce.getAsJsonObject(), "name");
                            if (!name.isBlank()) {
                                cats.add(name);
                            }
                        }
                    }
                    o.add("categories", cats);
                    hits.add(o);
                }

                LOG.info("[addon] search cf " + type + " q=" + query + " page=" + page
                        + " hits=" + total + " in " + (System.currentTimeMillis() - started) + "ms");
                pushSearchJson(type, reqId, hits, null, Math.max(0, page), totalPages);
            } catch (Exception e) {
                LOG.warning("CurseForge search failed: " + type, e);
                pushSearchJson(type, reqId, null, e, Math.max(0, page), 0);
            }
        }).start();
    }

    /// 资源类型 → CurseForge 的 classId。
    private static int cfClassId(RemoteAddon.Type type) {
        return switch (type) {
            case MOD -> 6;
            case MODPACK -> 4471;
            case RESOURCE_PACK -> 12;
            case SHADER_PACK -> 6552;
            case WORLD -> 17;
            default -> -1;
        };
    }

    /// 加载器 → CurseForge 的 modLoaderType。0 表示不筛。
    private static int cfLoaderId(@Nullable String loader) {
        if (loader == null || loader.isBlank()) {
            return 0;
        }
        return switch (loader.toLowerCase(Locale.ROOT)) {
            case "forge" -> 1;
            case "fabric" -> 4;
            case "quilt" -> 5;
            case "neoforge" -> 6;
            default -> 0;
        };
    }

    /// CurseForge 项目的文件列表。世界是一堆 zip，模组是一堆 jar，接口是同一个 ——
    /// 区别只在 classId 由搜索那边决定，这里只管把文件捞回来。
    private static List<AddonVersion> cfFiles(String projectId, @Nullable String gameVersion,
                                              @Nullable String loader) throws IOException {
        StringBuilder path = new StringBuilder("/v1/mods/" + enc(projectId) + "/files?pageSize=50");
        String mcVersion = gameVersion == null ? "" : gameVersion
                .replaceAll("(?i)[-_](fabric|forge|neoforge|quilt|cleanroom|optifine|liteloader)$", "")
                .trim();
        if (!mcVersion.isBlank()) {
            path.append("&gameVersion=").append(enc(mcVersion));
        }
        // modLoaderType 单独传是有效的（实测 /files 和 /search 都认），
        // 这点很重要：版本弹窗故意不传 gameVersion（要在弹窗里按版本再筛），
        // 如果这里也要求版本号，列表就会把 NeoForge 的构建混进来。
        int loaderId = cfLoaderId(loader);
        if (loaderId > 0) {
            path.append("&modLoaderType=").append(loaderId);
        }
        JsonObject root = cfGet(path.toString());
        List<AddonVersion> out = new ArrayList<>();
        if (!root.has("data") || !root.get("data").isJsonArray()) {
            return out;
        }
        for (JsonElement e : root.getAsJsonArray("data")) {
            if (!e.isJsonObject()) {
                continue;
            }
            JsonObject f = e.getAsJsonObject();
            int fileId = intValue(f, "id");
            String name = optString(f, "fileName");
            String url = optString(f, "downloadUrl");
            if (url.isBlank() && !name.isBlank()) {
                url = cfCdnUrl(fileId, name);
            }
            // CurseForge 把游戏版本和加载器混在同一个 gameVersions 数组里
            // （["1.21.1", "Fabric"]）。拆开才能让弹窗的「加载器」筛选和行内标签工作。
            List<String> allTags = stringList(f, "gameVersions");
            List<String> loaderNames = new ArrayList<>();
            List<String> gameVersions = new ArrayList<>();
            for (String tag : allTags) {
                if (isLoaderTag(tag)) {
                    loaderNames.add(tag.toLowerCase(Locale.ROOT));
                } else {
                    gameVersions.add(tag);
                }
            }
            out.add(new AddonVersion(
                    String.valueOf(fileId),
                    optString(f, "displayName"),
                    optString(f, "displayName"),
                    switch (intValue(f, "releaseType")) {
                        case 2 -> "beta";
                        case 3 -> "alpha";
                        default -> "release";
                    },
                    optString(f, "fileDate"),
                    loaderNames,
                    gameVersions,
                    url,
                    name,
                    longValue(f, "fileLength"),
                    0));
        }
        return out;
    }

    /// CurseForge 的 gameVersions 里混着加载器名，认一下哪些是加载器。
    /// 剩下的才是真正的游戏版本号（`1.21.1` 这种）。
    private static boolean isLoaderTag(@Nullable String tag) {
        if (tag == null) {
            return false;
        }
        return switch (tag.toLowerCase(Locale.ROOT)) {
            case "fabric", "forge", "neoforge", "quilt", "liteloader", "rift" -> true;
            default -> false;
        };
    }

    /// CurseForge 的 CDN 直链规则：files/{id/1000}/{id%1000}/{文件名}。
    /// 少数文件 API 不给 downloadUrl（作者关掉了第三方分发），只能按这个拼。
    private static String cfCdnUrl(int fileId, String fileName) {
        return "https://edge.forgecdn.net/files/" + (fileId / 1000) + "/" + (fileId % 1000) + "/"
                + encPath(fileName);
    }

    /// 路径段编码。`URLEncoder` 把空格编成 `+`，那是 query 的规则；
    /// 放在 path 里 `+` 就是字面的加号，带空格的文件名会 404。
    private static String encPath(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    /// 把 CurseForge 的下载地址解析成最终地址。
    ///
    /// <p>`edge.forgecdn.net` 对**任何** 文件都先 302 到 `mediafilez.forgecdn.net`，
    /// 而 edge 自己不认 Range 请求（直接 404）。小文件单连接能过，大文件一分段就
    /// 「not found」—— 实测 1.5 MB 的模组下载成功、42 MB 的资源包失败，差别就在这。
    ///
    /// <p>所以下载前先 HEAD 一次把跳转跟到底，拿最终地址给下载器。
    /// 解析失败就原样返回，最坏情况退化成原来的行为，不会更差。
    private static String resolveRedirect(String url) {
        String current = url;
        for (int hop = 0; hop < 3; hop++) {
            java.net.HttpURLConnection conn = null;
            try {
                conn = (java.net.HttpURLConnection) java.net.URI.create(current).toURL().openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setRequestMethod("HEAD");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("User-Agent", "HMCL/HopeStar");
                int code = conn.getResponseCode();
                String location = conn.getHeaderField("Location");
                if (code >= 300 && code < 400 && location != null && !location.isBlank()) {
                    current = location;
                    continue;
                }
                return current;
            } catch (Exception e) {
                // 超时、DNS 失败都退回原地址，交给下载器自己重试
                return current;
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        return current;
    }

    /// 这个 slug 是不是 CurseForge 的项目 id。
    ///
    /// <p>CurseForge 的 projectId 是纯数字，Modrinth 的 slug 一定带字母 ——
    /// 用它分流，前端不用多传一个 source 参数，老调用方也不会漏传。
    private static boolean isCurseForgeSlug(@Nullable String slug) {
        return slug != null && !slug.isBlank() && slug.chars().allMatch(Character::isDigit);
    }

    /// CurseForge 的一个文件，就是「一个可下载的版本」。
    private record CfFile(String fileId, String fileName, String displayName,
                          String url, long length, @Nullable String sha1) {
    }

    /// 取 CurseForge 单个文件的详情。
    ///
    /// <p>对应 HMCL 的 `CurseForgeRemoteAddonRepository.getAddonFile`
    /// （`/v1/mods/{projectId}/files/{fileId}`），比 Modrinth 多一层兜底：
    /// 作者关闭第三方分发时 `downloadUrl` 是 null，得按 CDN 规则自己拼。
    /// 这个 fallback 不是猜测 —— `edge.forgecdn.net/files/{id/1000}/{id%1000}/{fileName}`
    /// 是 CurseForge 官方的静态路径，HMCL 和 PCL 都这么兜。
    private static CfFile cfFile(String projectId, @Nullable String fileId) throws IOException {
        String id = fileId == null ? "" : fileId.trim();
        if (id.isEmpty()) {
            // 没指定文件就取这个项目最新的一个
            List<AddonVersion> all = cfFiles(projectId, null, null);
            if (all.isEmpty()) {
                throw new IOException("这个项目没有可下载的文件");
            }
            AddonVersion first = all.get(0);
            return new CfFile(first.versionId(), first.filename(), first.name(),
                    first.fileUrl(), first.fileSize(), null);
        }

        JsonObject root = cfGet("/v1/mods/" + enc(projectId) + "/files/" + enc(id));
        JsonObject f = root.has("data") && root.get("data").isJsonObject()
                ? root.getAsJsonObject("data") : null;
        if (f == null) {
            throw new IOException("CurseForge 上找不到这个文件（项目 " + projectId + " 文件 " + id + "）");
        }

        int numericId = intValue(f, "id");
        String fileName = optString(f, "fileName");
        String url = optString(f, "downloadUrl");
        if (url.isBlank() && !fileName.isBlank()) {
            url = cfCdnUrl(numericId, fileName);
        }
        if (url.isBlank()) {
            throw new IOException("这个文件没有可下载地址（作者关闭了第三方分发）");
        }

        // hashes 里 algo=1 是 SHA-1、2 是 MD5（CurseForge 文档的固定枚举）
        String sha1 = null;
        if (f.has("hashes") && f.get("hashes").isJsonArray()) {
            for (JsonElement h : f.getAsJsonArray("hashes")) {
                if (!h.isJsonObject()) {
                    continue;
                }
                JsonObject hash = h.getAsJsonObject();
                if (intValue(hash, "algo") == 1) {
                    String v = optString(hash, "value");
                    if (!v.isBlank()) {
                        sha1 = v;
                    }
                }
            }
        }

        String displayName = optString(f, "displayName");
        return new CfFile(String.valueOf(numericId), fileName,
                displayName.isBlank() ? fileName : displayName,
                url, longValue(f, "fileLength"), sha1);
    }

    /// 下载完整性校验：先对大小，再核 SHA-1。
    ///
    /// <p>CurseForge 的 CDN 在限流或故障时会返回一段 HTML、或者把响应截断。
    /// 大小不符是最早能发现的信号，SHA-1 是 API 自带的不额外花钱。
    /// 校验不过在客户端就等于没下 —— 所以这里直接删掉文件并报错，让用户重试，
    /// 别把一个半截 jar 放进 mods 让游戏去崩。
    private static void verifyDownload(Path file, long expectedSize, @Nullable String expectedSha1)
            throws IOException {
        if (!Files.isRegularFile(file)) {
            throw new IOException("下载后找不到文件");
        }
        if (expectedSize > 0) {
            long actual = Files.size(file);
            if (actual != expectedSize) {
                deleteQuietly(file);
                throw new IOException("下载不完整（" + actual + "/" + expectedSize
                        + " 字节），已删除，请重试");
            }
        }
        if (expectedSha1 != null && !expectedSha1.isBlank()) {
            String actual = sha1Hex(file);
            if (actual != null && !actual.equalsIgnoreCase(expectedSha1)) {
                deleteQuietly(file);
                throw new IOException("文件校验失败（SHA-1 不符），可能下到了错误页，已删除");
            }
        }
    }

    /// 文件 SHA-1，小写 hex。算不出来返回 null（校验会跳过，不影响安装）。
    @Nullable
    private static String sha1Hex(Path file) {
        try (var in = Files.newInputStream(file)) {
            var digest = java.security.MessageDigest.getInstance("SHA-1");
            byte[] buf = new byte[8192];
            int read;
            while ((read = in.read(buf)) > 0) {
                digest.update(buf, 0, read);
            }
            StringBuilder sb = new StringBuilder(40);
            for (byte b : digest.digest()) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private void installCurseForgeWorld(String projectId, String fileId, String instanceId, String taskId,
                                        @Nullable String directory) {
        Task.runAsync(() -> {
            try {
                JsonObject root = cfGet("/v1/mods/" + enc(projectId) + "/files/" + enc(fileId));
                JsonObject f = root.has("data") && root.get("data").isJsonObject()
                        ? root.getAsJsonObject("data") : new JsonObject();
                int id = intValue(f, "id");
                String name = optString(f, "fileName");
                String url = optString(f, "downloadUrl");
                if (url.isBlank() && !name.isBlank()) {
                    url = cfCdnUrl(id, name);
                }
                if (url.isBlank()) {
                    throw new IOException("这个文件没有可下载地址（作者关闭了第三方分发）");
                }

                Path tmp = Files.createTempFile("hmcl-world-", ".zip");
                pushTitle(taskId, name);
                pushStage(taskId, "下载 " + name + "…", false, null, -1);

                // 世界包动辄几十上百 MB，半截的包解出来是个残缺存档，
                // 比直接失败更难收拾 —— 大小和 SHA-1 都核一遍
                final long expectSize = longValue(f, "fileLength");
                String sha1 = null;
                if (f.has("hashes") && f.get("hashes").isJsonArray()) {
                    for (JsonElement h : f.getAsJsonArray("hashes")) {
                        if (h.isJsonObject() && intValue(h.getAsJsonObject(), "algo") == 1) {
                            String v = optString(h.getAsJsonObject(), "value");
                            if (!v.isBlank()) {
                                sha1 = v;
                            }
                        }
                    }
                }
                final String expectSha1 = sha1;

                DownloadProvider provider = DownloadProviders.getDownloadProvider();
                FileDownloadTask download = buildDownload(provider, resolveRedirect(url), tmp);
                // 用户在确认弹窗里挑过位置就用它；没挑就落到实例的 saves
                Path saves = directory != null && !directory.isBlank() ? Path.of(directory) : null;
                runWithProgress(download, taskId, () -> {
                    try {
                        verifyDownload(tmp, expectSize, expectSha1);
                        installWorldArchive(tmp, instanceId, taskId, stripExtension(name), saves);
                    } catch (IOException e) {
                        throw new RuntimeException(e.getMessage(), e);
                    } finally {
                        deleteQuietly(tmp);
                    }
                });
            } catch (Exception e) {
                LOG.warning("Failed to install world " + projectId + "@" + fileId, e);
                pushStage(taskId, "世界下载失败：" + e.getMessage(), true, String.valueOf(e), -1);
            }
        }).start();
    }

    private static String cfAuthor(JsonObject mod) {
        if (mod.has("authors") && mod.get("authors").isJsonArray()) {
            JsonArray authors = mod.getAsJsonArray("authors");
            if (authors.size() > 0 && authors.get(0).isJsonObject()) {
                return optString(authors.get(0).getAsJsonObject(), "name");
            }
        }
        return "";
    }

    private static String cfIcon(JsonObject mod) {
        if (mod.has("logo") && mod.get("logo").isJsonObject()) {
            JsonObject logo = mod.getAsJsonObject("logo");
            String thumb = optString(logo, "thumbnailUrl");
            return thumb.isBlank() ? optString(logo, "url") : thumb;
        }
        return "";
    }

    private static String cfLink(JsonObject mod, String key) {
        if (mod.has("links") && mod.get("links").isJsonObject()) {
            return optString(mod.getAsJsonObject("links"), key);
        }
        return "";
    }

    /// 前端排序（relevancy / downloads / newest / updated）映射到 CF 的 sortField：
    /// 1 精选 2 热度 3 最后更新 6 总下载 11 发布日期。世界没有「相关度」，用热度顶上。
    private static int cfSortField(@Nullable String sort) {
        if (sort == null) {
            return 2;
        }
        return switch (sort) {
            case "downloads" -> 6;
            case "newest" -> 11;
            case "updated" -> 3;
            default -> 2;
        };
    }

    // ==================== 版本列表 ====================


    void versions(String type, String slug, String gameVersion, String loader) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null || slug == null || slug.isBlank()) {
            pushVersions(type, slug, null, new IllegalArgumentException("参数不完整"));
            return;
        }

        // CurseForge 的项目 id 是纯数字（搜索结果里 slug 就是 projectId），
        // Modrinth 的 slug 一定带字母。用这个就能分清这批版本该问谁，
        // 不用再往下多传一个 source 参数。
        boolean numericSlug = slug.chars().allMatch(Character::isDigit);

        // 世界：slug 是 CurseForge 的项目数字 id，一个项目下挂着若干 zip
        if (addonType == RemoteAddon.Type.WORLD || numericSlug) {
            Task.runAsync(() -> {
                try {
                    List<AddonVersion> items = NetRetry.call("cf files " + slug,
                            () -> cfFiles(slug, gameVersion, loader));
                    LOG.info("[addon] versions world " + slug + " → " + items.size() + " 条");
                    pushVersions(type, slug, items, null);
                } catch (Throwable e) {
                    LOG.warning("Failed to load world files of " + slug, e);
                    pushVersions(type, slug, null,
                            e instanceof Exception ex ? ex : new Exception(String.valueOf(e)));
                }
            }).start();
            return;
        }

        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                List<AddonVersion> items = NetRetry.call("versions " + slug,
                        () -> fetchVersions(slug, gameVersion, loader));
                LOG.info("[addon] versions " + slug + " gv=" + gameVersion + " loader=" + loader
                        + " → " + items.size() + " 条，用时 " + (System.currentTimeMillis() - started) + "ms");
                pushVersions(type, slug, items, null);
            } catch (Throwable e) {
                // Throwable：这里出过 Error（不是 Exception）被静默吞掉的情况，
                // 前端就会永远停在「正在拉取版本…」
                LOG.warning("Failed to load versions of " + slug, e);
                pushVersions(type, slug, null, e instanceof Exception ex ? ex : new Exception(String.valueOf(e)));
            }
        }).start();
    }

    /// 拉版本列表。
    ///
    /// **游戏版本不再交给服务端过滤**：用户要看到「这个 mod 支持哪些游戏版本」并能自己选，
    /// 提前按实例版本筛掉的话，弹窗里就只剩一条，没法比。
    /// 加载器仍然服务端筛——那是硬性兼容门槛，跨加载器的文件装了也跑不起来；
    /// 没选实例（`loader` 为空）时不筛，全部拉回来在前端按加载器分类。
    ///
    /// 代价是体积：Fabric API 这种 1200+ 版本的项目会到 1.2MB。
    /// 前端弹窗先开、骨架屏先上，数据到了再填，用户看不到空白等待。
    private static List<AddonVersion> fetchVersions(String slug, @Nullable String gameVersion,
                                                    @Nullable String loader) throws IOException {
        StringBuilder url = new StringBuilder(API + "/project/" + enc(slug) + "/version");
        List<String> params = new ArrayList<>();
        if (gameVersion != null && !gameVersion.isBlank()) {
            params.add("game_versions=" + enc("[\"" + gameVersion + "\"]"));
        }
        String loaderSlug = modrinthLoader(loader);
        if (loaderSlug != null) {
            params.add("loaders=" + enc("[\"" + loaderSlug + "\"]"));
        }
        for (int i = 0; i < params.size(); i++) {
            url.append(i == 0 ? "?" : "&").append(params.get(i));
        }

        JsonArray raw = HttpRequest.GET(url.toString()).getJson(JsonArray.class);
        List<AddonVersion> out = new ArrayList<>();
        for (JsonElement element : raw) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject v = element.getAsJsonObject();

            String fileUrl = null;
            String filename = null;
            if (v.has("files") && v.get("files").isJsonArray()) {
                JsonArray files = v.getAsJsonArray("files");
                if (files.size() > 0 && files.get(0).isJsonObject()) {
                    JsonObject file = files.get(0).getAsJsonObject();
                    fileUrl = optString(file, "url");
                    filename = optString(file, "filename");
                }
            }
            if (fileUrl == null || fileUrl.isBlank()) {
                // 没有可下载文件（Modrinth 上有这种空壳项目）
                continue;
            }

            List<String> loaders = new ArrayList<>();
            if (v.has("loaders") && v.get("loaders").isJsonArray()) {
                for (JsonElement l : v.getAsJsonArray("loaders")) {
                    if (l.isJsonPrimitive()) {
                        loaders.add(l.getAsString());
                    }
                }
            }

            out.add(new AddonVersion(
                    optString(v, "id"),
                    optString(v, "name"),
                    optString(v, "version_number"),
                    optString(v, "version_type"),
                    optString(v, "date_published"),
                    loaders,
                    stringList(v, "game_versions"),
                    fileUrl,
                    filename,
                    fileSize(v),
                    intValue(v, "downloads")));
        }
        // 新的在前。API 的默认顺序不保证
        out.sort(Comparator.comparing(AddonVersion::date).reversed());
        return out;
    }

    private void pushVersions(String type, String slug, @Nullable List<AddonVersion> items, @Nullable Exception error) {
        JsonObject root = new JsonObject();
        root.addProperty("type", type);
        root.addProperty("slug", slug);

        if (error != null) {
            root.addProperty("error", error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
            root.add("items", new JsonArray());
        } else {
            JsonArray array = new JsonArray();
            for (AddonVersion v : items) {
                JsonObject o = new JsonObject();
                o.addProperty("versionId", v.versionId());
                o.addProperty("name", v.name());
                o.addProperty("version", v.number());
                o.addProperty("type", v.type() == null || v.type().isBlank() ? "release" : v.type());
                o.addProperty("date", v.date());
                o.addProperty("filename", v.filename());
                o.addProperty("size", v.fileSize());
                o.addProperty("downloads", v.downloads());
                JsonArray loaders = new JsonArray();
                for (int i = 0; i < v.loaders().size() && i < 8; i++) {
                    loaders.add(v.loaders().get(i));
                }
                o.add("loaders", loaders);
                // 这个文件支持哪些游戏版本。前端拿它和实例的版本比对，
                // 决定哪一条是「推荐」、哪些归到「其他游戏版本」
                JsonArray gvs = new JsonArray();
                for (int i = 0; i < v.gameVersions().size() && i < 24; i++) {
                    gvs.add(v.gameVersions().get(i));
                }
                o.add("gameVersions", gvs);
                array.add(o);
            }
            root.add("items", array);
            root.addProperty("total", array.size());
        }

        String text = JsonUtils.GSON.toJson(root);
        push.accept("window.__hmcl && window.__hmcl.onAddonVersions("
                + JsonUtils.GSON.toJson(text) + ")");
    }

    /// 依赖检查只给得出 mod id（`fabric.mod.json` 里那个 id），装的时候要的是 slug。
    ///
    /// Modrinth 上多数模组的 slug 和 mod id 就是同一个词（sodium / jei / create），
    /// 所以先按 slug 直接问项目；问不到再退回搜索，取第一条 project_type:mod。
    /// 这一步只是个翻译，真正的版本列表还是走 {@link #versions}，前端复用模组页那套弹窗。
    void resolveModSlug(String modId, String gameVersion, String loader) {
        Task.runAsync(() -> {
            JsonObject out = new JsonObject();
            out.addProperty("modId", modId == null ? "" : modId);
            try {
                String id = modId == null ? "" : modId.trim();
                if (id.isEmpty()) {
                    throw new IOException("模组 id 是空的");
                }

                JsonObject project = null;
                try {
                    project = HttpRequest.GET(API + "/project/" + enc(id)).getJson(JsonObject.class);
                } catch (Exception e) {
                    // mod id 和 slug 对不上时这里就是 404，很正常，交给下面的搜索
                }
                if (project == null || !project.has("slug") || project.get("slug").isJsonNull()) {
                    project = searchProject(id);
                }
                if (project == null || !project.has("slug") || project.get("slug").isJsonNull()) {
                    throw new IOException("Modrinth 上没找到 " + id);
                }

                out.addProperty("ok", true);
                out.addProperty("slug", project.get("slug").getAsString());
                out.addProperty("title", project.has("title") && !project.get("title").isJsonNull()
                        ? project.get("title").getAsString() : id);
                out.addProperty("icon", project.has("icon_url") && !project.get("icon_url").isJsonNull()
                        ? project.get("icon_url").getAsString() : "");
            } catch (Throwable e) {
                out.addProperty("ok", false);
                out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
            }

            String text = JsonUtils.GSON.toJson(out);
            push.accept("window.__hmcl && window.__hmcl.onAddonResolved("
                    + JsonUtils.GSON.toJson(text) + ")");
        }).start();
    }

    /// 按 mod id 搜一次，优先取 slug/title 跟它对得上的，都对不上就用第一条。
    private static @Nullable JsonObject searchProject(String query) throws IOException {
        JsonArray facets = new JsonArray();
        JsonArray typeFacet = new JsonArray();
        typeFacet.add("project_type:mod");
        facets.add(typeFacet);

        String url = API + "/search?limit=5&index=relevance&query=" + enc(query)
                + "&facets=" + enc(facets.toString());
        JsonObject root = HttpRequest.GET(url).getJson(JsonObject.class);
        JsonArray hits = root.has("hits") && root.get("hits").isJsonArray()
                ? root.getAsJsonArray("hits") : new JsonArray();
        if (hits.isEmpty()) {
            return null;
        }
        String lower = query.toLowerCase(Locale.ROOT);
        for (int i = 0; i < hits.size(); i++) {
            if (!hits.get(i).isJsonObject()) {
                continue;
            }
            JsonObject hit = hits.get(i).getAsJsonObject();
            String slug = hit.has("slug") ? hit.get("slug").getAsString() : "";
            String title = hit.has("title") ? hit.get("title").getAsString() : "";
            if (slug.equalsIgnoreCase(lower) || title.toLowerCase(Locale.ROOT).contains(lower)) {
                return hit;
            }
        }
        return hits.get(0).isJsonObject() ? hits.get(0).getAsJsonObject() : null;
    }

    // ==================== 下载到实例 ====================

    /// 把模组 / 资源包 / 光影下载到实例对应目录。
    /// `instanceId` 为空时落到当前选中实例；`directory` 非空则直接用它（用户在确认弹窗里
    /// 选过保存位置）；两者都没有才落到仓库根目录（和 HMCL 一致）。
    ///
    /// `fileName` 非空时覆盖原文件名——下载确认弹窗允许改名，比如把
    /// `sodium-fabric-0.6.13+mc1.21.4.jar` 改成 `sodium.jar`。
    void install(String type, String slug, String versionId, String instanceId,
                 @Nullable String fileName, @Nullable String directory) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null || addonType == RemoteAddon.Type.MODPACK) {
            pushStage(slug, "这个类型请走整合包安装", true, "wrong api", -1);
            return;
        }

        String taskId = slug + "@" + versionId;

        // 世界：slug=项目 id、versionId=文件 id，下回来的是个 zip，
        // 解压进 saves/ 就是存档目录，不走「放进 mods」那条路
        if (addonType == RemoteAddon.Type.WORLD) {
            pushStage(taskId, "正在解析世界存档…", false, null, -1);
            installCurseForgeWorld(slug, versionId, instanceId, taskId, directory);
            return;
        }
        pushStage(taskId, "正在解析版本…", false, null, -1);

        Task.runAsync(() -> {
            try {
                DownloadProvider provider = DownloadProviders.getDownloadProvider();

                // 已经知道具体版本了，直接查详情（一个对象，几十 KB），
                // 不用再拉整个项目的版本列表。
                // CF 和 Modrinth 是两套接口，靠 slug 是不是纯数字分流。
                AddonVersion version;
                String expectedSha1 = null;
                long expectedSize = -1;
                if (isCurseForgeSlug(slug)) {
                    CfFile cf = cfFile(slug, versionId);
                    version = new AddonVersion(cf.fileId(), cf.displayName(), cf.displayName(),
                            "release", "", List.of(), List.of(),
                            cf.url(), cf.fileName(), cf.length(), 0);
                    expectedSha1 = cf.sha1();
                    expectedSize = cf.length();
                    LOG.info("[addon] install cf " + slug + "/" + versionId
                            + " → " + cf.fileName() + " (" + cf.length() + " B)");
                } else {
                    version = fetchVersionById(slug, versionId);
                }

                Path dir = directory != null && !directory.isBlank()
                        ? Path.of(directory)
                        : targetDirectory(addonType, instanceId);
                Files.createDirectories(dir);

                String wanted = fileName != null && !fileName.isBlank() ? fileName : version.filename();
                String safe = safeFileName(wanted, taskId);
                // 用户手输的名字可能不带后缀，补上原文件的，否则游戏不认
                if (!safe.contains(".")) {
                    String original = safeFileName(version.filename(), "addon.jar");
                    int dot = original.lastIndexOf('.');
                    if (dot > 0) {
                        safe = safe + original.substring(dot);
                    }
                }
                String fileNameResolved = safe;
                Path target = dir.resolve(fileNameResolved);
                // 任务列表里显示的就是这个文件名，不是 slug（用户关心的是自己下到了什么）
                pushTitle(taskId, fileNameResolved);
                pushStage(taskId, "下载 " + fileNameResolved + " → " + dir, false, null, -1);

                final long expectSize = expectedSize;
                final String expectSha1 = expectedSha1;
                // CurseForge 的地址要先跟掉 302，见 resolveRedirect 的说明
                String fileUrl = isCurseForgeSlug(slug) ? resolveRedirect(version.fileUrl()) : version.fileUrl();
                FileDownloadTask download = buildDownload(provider, fileUrl, target);
                runWithProgress(download, taskId, () -> {
                    try {
                        verifyArchive(target);
                        verifyDownload(target, expectSize, expectSha1);
                    } catch (IOException e) {
                        // 包一层，让 runWithProgress 的收尾逻辑把它当失败处理
                        throw new RuntimeException(e.getMessage(), e);
                    }
                });
            } catch (Exception e) {
                LOG.warning("Failed to install addon " + slug + "@" + versionId, e);
                pushStage(taskId, "下载失败：" + e.getMessage(), true, String.valueOf(e), -1);
            }
        }).start();
    }

    /// 默认落盘目录（给下载确认弹窗显示用）。没有实例、也没有可用游戏目录时返回空串。
    String defaultTargetDirectory(String type, @Nullable String instanceId) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null) {
            return "";
        }
        try {
            return targetDirectory(addonType, instanceId).toAbsolutePath().toString();
        } catch (Exception e) {
            return "";
        }
    }

    /// 按版本 id 取单个版本。`versionId` 为空时退化成「拉最新一个」。
    private static AddonVersion fetchVersionById(String slug, @Nullable String versionId) throws IOException {
        if (versionId == null || versionId.isBlank()) {
            List<AddonVersion> all = fetchVersions(slug, null, null);
            if (all.isEmpty()) {
                throw new IOException("这个项目没有可下载的版本");
            }
            return all.get(0);
        }

        JsonObject v = HttpRequest.GET(API + "/version/" + enc(versionId)).getJson(JsonObject.class);
        String fileUrl = null;
        String filename = null;
        if (v.has("files") && v.get("files").isJsonArray()) {
            JsonArray files = v.getAsJsonArray("files");
            if (files.size() > 0 && files.get(0).isJsonObject()) {
                JsonObject file = files.get(0).getAsJsonObject();
                fileUrl = optString(file, "url");
                filename = optString(file, "filename");
            }
        }
        if (fileUrl == null || fileUrl.isBlank()) {
            throw new IOException("这个版本没有可下载的文件");
        }
        List<String> loaders = new ArrayList<>();
        if (v.has("loaders") && v.get("loaders").isJsonArray()) {
            for (JsonElement l : v.getAsJsonArray("loaders")) {
                if (l.isJsonPrimitive()) {
                    loaders.add(l.getAsString());
                }
            }
        }
        return new AddonVersion(
                optString(v, "id"),
                optString(v, "name"),
                optString(v, "version_number"),
                optString(v, "version_type"),
                optString(v, "date_published"),
                loaders,
                stringList(v, "game_versions"),
                fileUrl,
                filename,
                fileSize(v),
                intValue(v, "downloads"));
    }

    /// 构造下载任务。**不做哈希校验**，和 HMCL 的 `DownloadPage.download` 一致。
    ///
    /// 原因：`DownloadProvider` 会给 Modrinth 的 URL 插一批镜像候选
    /// （`mod.mcimirror.top` 之类），镜像上的文件有时和官方不是同一个二进制，
    /// 拿官方 sha1 去校验必然失败，用户看到的就是「下载失败：Incorrect checksum」。
    /// 加校验看起来更安全，实际只会让国内用户一条都下不来。
    /// 校验下载产物是不是一个真正的压缩包。
    ///
    /// 起因：Modrinth 的镜像（`mod.mcimirror.top`）在维护时会返回 200 +
    /// 一个「Service Temporarily Unavailable」的 HTML 页面。`FileDownloadTask`
    /// 只看状态码，于是把 2KB 的 HTML 当 jar 存了下来，界面还显示「完成」。
    ///
    /// 校验方式就是看头四个字节是不是 ZIP 的 `PK`（jar / zip / mrpack 都是）。
    private static void verifyArchive(Path file) throws IOException {
        if (!Files.isRegularFile(file)) {
            throw new IOException("下载后找不到文件：" + file.getFileName());
        }
        byte[] head = new byte[4];
        try (var in = Files.newInputStream(file)) {
            int read = in.read(head);
            if (read < 4) {
                deleteQuietly(file);
                throw new IOException("下载到的文件不完整（" + Files.size(file) + " 字节），可能是下载源临时故障");
            }
        }
        boolean isZip = head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4;
        if (!isZip) {
            long size = Files.size(file);
            deleteQuietly(file);
            throw new IOException("下载源返回的不是有效文件（" + size
                    + " 字节，疑似错误页），请稍后重试或换个下载源");
        }
    }

    private static FileDownloadTask buildDownload(DownloadProvider provider, String url, Path target) {
        return new FileDownloadTask(provider.getDownloadCandidates(url), target);
    }

    private static Path targetDirectory(RemoteAddon.Type type, @Nullable String instanceId) throws IOException {
        String sub = switch (type) {
            case MOD -> "mods";
            case RESOURCE_PACK -> "resourcepacks";
            case SHADER_PACK -> "shaderpacks";
            case WORLD -> "saves";
            default -> throw new IOException("不支持的目录类型：" + type);
        };

        HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
        Path base = repository != null ? repository.getBaseDirectory().toAbsolutePath() : null;

        HMCLGameInstance instance = findInstance(repository, instanceId);
        if (instance != null) {
            return instance.getRunDirectory().resolve(sub);
        }
        if (base == null) {
            throw new IOException("没有可用的游戏目录");
        }
        return base.resolve(sub);
    }

    @Nullable
    private static HMCLGameInstance findInstance(@Nullable HMCLGameRepository repository, @Nullable String instanceId) {
        if (repository == null) {
            return null;
        }
        try {
            if (instanceId != null && !instanceId.isBlank()) {
                return repository.findInstance(new GameInstanceID(instanceId));
            }
            return repository.getSelectedInstance();
        } catch (Exception e) {
            return null;
        }
    }

    // ==================== 整合包 ====================

    /// 在线整合包：先下 .mrpack，再交给 `ModpackHelper` 装。
    /// 不重写安装流程——整合包里面还要处理 overrides、依赖补全、实例隔离，
    /// HMCL 那套已经调好了。
    void installModpackRemote(String slug, String versionId, @Nullable String iconUrl, @Nullable String preferredName) {
        String taskId = "modpack:" + slug;

        Task.runAsync(() -> {
            Path temp = null;
            try {
                DownloadProvider provider = DownloadProviders.getDownloadProvider();

                AddonVersion version;
                String expectedSha1 = null;
                long expectedSize = -1;
                if (isCurseForgeSlug(slug)) {
                    CfFile cf = cfFile(slug, versionId);
                    version = new AddonVersion(cf.fileId(), cf.displayName(), cf.displayName(),
                            "release", "", List.of(), List.of(),
                            cf.url(), cf.fileName(), cf.length(), 0);
                    expectedSha1 = cf.sha1();
                    expectedSize = cf.length();
                    LOG.info("[addon] download cf modpack " + slug + "/" + versionId
                            + " → " + cf.fileName() + " (" + cf.length() + " B)");
                } else {
                    version = fetchVersionById(slug, versionId);
                }

                temp = Files.createTempFile("hmcl-modpack-", ".zip");
                pushStage(taskId, "正在下载整合包 " + version.number() + "…", false, null, -1);

                String packUrl = isCurseForgeSlug(slug) ? resolveRedirect(version.fileUrl()) : version.fileUrl();
                FileDownloadTask download = buildDownload(provider, packUrl, temp);
                final Path archive = temp;

                // 只挂进度，不收尾：下载只是第一步，装完才算完成。
                // 直接 runWithProgress 的话，下载一结束就会推 done=true。
                AtomicReference<Throwable> downloadError = attachProgress(download, taskId);
                final long expectSize = expectedSize;
                final String expectSha1 = expectedSha1;
                download.onDone().register(event -> {
                    if (event.isFailed()) {
                        Throwable cause = downloadError.get();
                        pushStage(taskId, "下载整合包失败：" + (cause != null ? cause : "未知错误"),
                                true, String.valueOf(cause), -1);
                        deleteQuietly(archive);
                        return;
                    }
                    // 整合包几百 MB，半截的包解出来是「装了一半的实例」，
                    // 比直接失败更难收拾 —— 所以下完先校验再解。
                    try {
                        verifyDownload(archive, expectSize, expectSha1);
                    } catch (IOException e) {
                        pushStage(taskId, "下载整合包失败：" + e.getMessage(), true, String.valueOf(e), -1);
                        deleteQuietly(archive);
                        return;
                    }
                    ModpackOrigin origin = new ModpackOrigin(
                            isCurseForgeSlug(slug) ? "curseforge" : "modrinth",
                            slug, version.versionId(),
                            displayVersion(version.number(), version.filename()),
                            modpackDisplayName(preferredName, version),
                            iconUrl);
                    Task.runAsync(() -> installModpackArchive(archive, iconUrl, preferredName, taskId, true, origin)).start();
                });
                download.executor().start();
            } catch (Exception e) {
                LOG.warning("Failed to fetch modpack " + slug, e);
                pushStage(taskId, "下载整合包失败：" + e.getMessage(), true, String.valueOf(e), -1);
                deleteQuietly(temp);
            }
        }).start();
    }

    /// 本地整合包 / 本地世界：文件已经由 `/api/upload` 落到临时目录，
    /// 这里负责装进实例。
    /// 装一个本地文件。
    ///
    /// @param deleteSource 装完是否删掉源文件。**只有上传来的临时文件可以删**：
    ///                     用户在「导入整合包」里选的是他自己磁盘上的文件，
    ///                     删掉就是事故。以前这个参数没有，两条路都删，实测把
    ///                     测试用的 zip 删了才发现。
    void installLocalFile(String kind, Path file, @Nullable String instanceId,
                          @Nullable String preferredName, boolean deleteSource) {
        String taskId = "local:" + file.getFileName();
        // 整合包这条路的删除时机由 installModpackArchive 接管（要等扫包的任务跑完），
        // 这里先记一份，避免 finally 里提前把 zip 删掉
        boolean[] deleteHere = {deleteSource};

        Task.runAsync(() -> {
            try {
                if ("modpack".equals(kind)) {
                    installModpackArchive(file, null, preferredName, taskId, deleteSource);
                    deleteHere[0] = false;
                } else if ("mod".equals(kind)) {
                    Path dir = targetDirectory(RemoteAddon.Type.MOD, instanceId);
                    Files.createDirectories(dir);
                    Path target = dir.resolve(safeFileName(file.getFileName().toString(), taskId));
                    pushStage(taskId, "正在放入 mods…", false, null, 0.5);
                    Files.copy(file, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    pushStage(taskId, "已放入 mods / " + target.getFileName(), true, null, 1);
                    // 装完顺手把缺的前置补上
                    autoInstallDependencies(instanceId);
                } else if ("world".equals(kind)) {
                    installWorldArchive(file, instanceId, taskId);
                } else if ("resourcepack".equals(kind) || "shader".equals(kind)) {
                    String sub = "shader".equals(kind) ? "shaderpacks" : "resourcepacks";
                    Path dir = targetDirectory(
                            "shader".equals(kind) ? RemoteAddon.Type.SHADER_PACK : RemoteAddon.Type.RESOURCE_PACK,
                            instanceId);
                    Files.createDirectories(dir);
                    Path target = dir.resolve(safeFileName(preferredName != null ? preferredName : file.getFileName().toString(), taskId));
                    pushStage(taskId, "正在复制到 " + sub + "…", false, null, 0.4);
                    Files.copy(file, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    pushStage(taskId, "已放入 " + dir.getFileName() + " / " + target.getFileName(), true, null, 1);
                } else {
                    pushStage(taskId, "不支持的导入类型：" + kind, true, "bad kind", -1);
                }
            } catch (Exception e) {
                LOG.warning("Failed to import local " + kind, e);
                pushStage(taskId, "导入失败：" + e.getMessage(), true, String.valueOf(e), -1);
            } finally {
                if (deleteHere[0]) {
                    deleteQuietly(file);
                }
            }
        }).start();
    }

    // ==================== 整合包来源与更新 ====================

    /// 记录整合包出处的文件，放在实例根目录（和 modpack.cfg 同级）。
    ///
    /// <p>不塞进 `modpack.cfg`：那是 HMCL 自己的格式，字段跟着上游版本变，
    /// 升级时容易被冲掉。单独一个点文件，只存我们自己要用的几件事。
    private static final String MODPACK_SOURCE_FILE = ".hopestar-modpack.json";

    /// 一次平台整合包安装的出处。
    record ModpackOrigin(String source, String projectId, String versionId,
                         String versionNumber, String name, @Nullable String iconUrl) {
    }

    /// 展示用的版本号。
    ///
    /// <p>CurseForge 的 `displayName` 经常就是文件名（`Fabulously.Optimized-6.5.0.zip`），
    /// 直接显示在「当前 / 有新版本」后面太丑，去掉压缩包后缀。
    private static String displayVersion(@Nullable String number, @Nullable String fileName) {
        String v = number == null ? "" : number.trim();
        if (v.isEmpty()) {
            return fileName == null ? "" : stripExtension(fileName);
        }
        String lower = v.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".zip") || lower.endsWith(".jar") || lower.endsWith(".mrpack")) {
            return stripExtension(v);
        }
        return v;
    }

    /// 单实例更新检查的缓存。实例页每次进都查一遍会连打 N 个请求，
    /// 平台那边有限流，隔十分钟查一次足够了。
    private record CachedUpdate(String json, long at) {
    }

    private final Map<String, CachedUpdate> modpackUpdateCache = new ConcurrentHashMap<>();
    private static final long MODPACK_UPDATE_TTL_MS = 10L * 60 * 1000;

    private static void writeModpackSource(Path instanceDir, ModpackOrigin origin) {
        if (instanceDir == null) {
            return;
        }
        try {
            JsonObject o = new JsonObject();
            o.addProperty("source", origin.source());
            o.addProperty("projectId", origin.projectId());
            o.addProperty("versionId", origin.versionId());
            o.addProperty("versionNumber", origin.versionNumber());
            o.addProperty("name", origin.name());
            o.addProperty("iconUrl", origin.iconUrl());
            o.addProperty("installedAt", System.currentTimeMillis());
            Files.createDirectories(instanceDir);
            Files.writeString(instanceDir.resolve(MODPACK_SOURCE_FILE),
                    JsonUtils.GSON.toJson(o), java.nio.charset.StandardCharsets.UTF_8);
            LOG.info("[modpack] 记录来源 " + instanceDir.getFileName() + " → "
                    + origin.source() + "/" + origin.projectId() + "@" + origin.versionId());
        } catch (Exception e) {
            LOG.warning("Failed to write modpack source", e);
        }
    }

    @Nullable
    private static JsonObject readModpackSource(@Nullable Path instanceDir) {
        if (instanceDir == null) {
            return null;
        }
        Path file = instanceDir.resolve(MODPACK_SOURCE_FILE);
        if (!Files.isRegularFile(file)) {
            return null;
        }
        try {
            return JsonUtils.GSON.fromJson(Files.readString(file), JsonObject.class);
        } catch (Exception e) {
            LOG.warning("Failed to read modpack source " + file, e);
            return null;
        }
    }

    /// 实例根目录 = modpack.cfg 的父目录。非整合包实例也能拿到 `versions/<id>`。
    @Nullable
    private static Path modpackInstanceDir(@Nullable HMCLGameInstance instance) {
        if (instance == null) {
            return null;
        }
        try {
            Path cfg = instance.getModpackConfigurationFile();
            return cfg == null ? null : cfg.getParent();
        } catch (Throwable t) {
            return null;
        }
    }

    /// 这个来源的整合包，当前实例该用哪个版本。
    ///
    /// <p>Modrinth 优先正式版，没有正式版才退回最新的；
    /// CurseForge 的 /files 默认按时间倒序，取第一条就行。
    @Nullable
    private static AddonVersion latestModpackVersion(String source, String projectId,
                                                     String gameVersion, String loader) {
        try {
            if ("curseforge".equals(source)) {
                List<AddonVersion> all = cfFiles(projectId, gameVersion, loader);
                return all.isEmpty() ? null : all.get(0);
            }
            List<AddonVersion> all = fetchVersions(projectId, gameVersion, loader);
            for (AddonVersion v : all) {
                if ("release".equalsIgnoreCase(v.type())) {
                    return v;
                }
            }
            return all.isEmpty() ? null : all.get(0);
        } catch (Exception e) {
            LOG.warning("Failed to fetch latest modpack version " + source + "/" + projectId, e);
            return null;
        }
    }

    /// 查一个实例的整合包有没有新版。结果缓存十分钟。
    String checkModpackUpdate(String instanceId) {
        return checkModpackUpdate(instanceId, false);
    }

    String checkModpackUpdate(String instanceId, boolean force) {
        CachedUpdate cached = modpackUpdateCache.get(instanceId);
        if (!force && cached != null && System.currentTimeMillis() - cached.at() < MODPACK_UPDATE_TTL_MS) {
            return cached.json();
        }
        String json = computeModpackUpdate(instanceId);
        modpackUpdateCache.put(instanceId, new CachedUpdate(json, System.currentTimeMillis()));
        return json;
    }

    private String computeModpackUpdate(String instanceId) {
        JsonObject out = new JsonObject();
        out.addProperty("instanceId", instanceId);
        out.addProperty("ok", false);
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            HMCLGameInstance instance = findInstance(repository, instanceId);
            if (instance == null) {
                out.addProperty("reason", "找不到这个实例");
                return JsonUtils.GSON.toJson(out);
            }
            JsonObject src = readModpackSource(modpackInstanceDir(instance));
            if (src == null) {
                // 手动导入 / 从别处拷来的实例：没有出处，查不了
                out.addProperty("reason", "no-source");
                return JsonUtils.GSON.toJson(out);
            }
            String source = optString(src, "source");
            String projectId = optString(src, "projectId");
            String currentId = optString(src, "versionId");
            String name = optString(src, "name");
            if (!name.isBlank()) {
                out.addProperty("name", name);
            }
            out.addProperty("source", source);
            out.addProperty("projectId", projectId);
            out.addProperty("currentVersionId", currentId);
            out.addProperty("currentVersion", optString(src, "versionNumber"));

            if (projectId.isBlank() || currentId.isBlank()) {
                // 拖进来的整合包只匹配到了「是哪个项目」，不知道是哪个版本，
                // 拿最新版一比必然是「有更新」，那是误报。
                out.addProperty("reason", "unknown-version");
                return JsonUtils.GSON.toJson(out);
            }

            String gameVersion = instanceGameVersion(instance);
            String loader = instanceLoader(instance);
            if (gameVersion.isBlank()) {
                out.addProperty("reason", "认不出这个实例的游戏版本，没法确认新版是否兼容");
                return JsonUtils.GSON.toJson(out);
            }

            AddonVersion latest = latestModpackVersion(source, projectId, gameVersion, loader);
            if (latest == null) {
                out.addProperty("reason", "平台上找不到适配 " + gameVersion + " 的版本");
                return JsonUtils.GSON.toJson(out);
            }

            boolean hasUpdate = !latest.versionId().equals(currentId);
            out.addProperty("ok", true);
            out.addProperty("hasUpdate", hasUpdate);
            out.addProperty("latestVersionId", latest.versionId());
            out.addProperty("latestVersion", displayVersion(latest.number(), latest.filename()));
            out.addProperty("latestDate", latest.date());
            out.addProperty("latestFile", latest.filename());
            out.addProperty("latestSize", latest.fileSize());
            out.addProperty("gameVersion", gameVersion);
            out.addProperty("loader", loader);
        } catch (Exception e) {
            out.addProperty("reason", String.valueOf(e.getMessage()));
        }
        return JsonUtils.GSON.toJson(out);
    }

    /// 所有实例的更新状态，查完推给前端。
    ///
    /// <p>**必须异步**：WebBridge 的方法都在 FX 线程上跑，这里要打平台接口，
    /// 同步做会把界面卡住好几秒。同理由前端不要在 apiCall 里等返回值。
    void checkAllModpackUpdates(boolean force) {
        Task.runAsync(() -> {
            JsonArray array = new JsonArray();
            try {
                HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
                if (repository != null) {
                    for (HMCLGameInstance instance : repository.getDisplayInstances().toList()) {
                        String id = String.valueOf(instance.getId());
                        if (readModpackSource(modpackInstanceDir(instance)) == null) {
                            continue;   // 没有来源记录的实例不参与，省一次请求
                        }
                        JsonObject one = JsonUtils.GSON.fromJson(checkModpackUpdate(id, force), JsonObject.class);
                        if (one != null) {
                            array.add(one);
                        }
                    }
                }
            } catch (Exception e) {
                LOG.warning("Failed to check modpack updates", e);
            }
            pushModpackUpdates(array);
        }).start();
    }

    /// 手动检查一个实例。结果里带 `manual` 标记，前端据此弹一句提示。
    void refreshModpackUpdate(String instanceId) {
        Task.runAsync(() -> {
            JsonArray array = new JsonArray();
            JsonObject one = JsonUtils.GSON.fromJson(checkModpackUpdate(instanceId, true), JsonObject.class);
            if (one != null) {
                one.addProperty("manual", true);
                array.add(one);
            }
            pushModpackUpdates(array);
        }).start();
    }

    private void pushModpackUpdates(JsonArray array) {
        String text = JsonUtils.GSON.toJson(array);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onModpackUpdates("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    /// 下载新版整合包并更新实例。
    ///
    /// <p>走的是 HMCL 的 `ModpackUpdateTask`：它先把整个实例目录备份一份，
    /// 更新失败会回滚。存档、设置这类不在整合包清单里的文件不会被碰；
    /// 清单里的文件会被新版覆盖 —— 这就是「更新」的语义。
    void updateModpack(String instanceId) {
        String taskId = "modpack-update:" + instanceId;
        Task.runAsync(() -> {
            Path temp = null;
            try {
                HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
                HMCLGameInstance instance = findInstance(repository, instanceId);
                if (instance == null) {
                    throw new IOException("找不到这个实例");
                }
                Path dir = modpackInstanceDir(instance);
                JsonObject src = readModpackSource(dir);
                if (src == null) {
                    throw new IOException("这个实例没有记录过安装来源，没法自动更新");
                }
                String source = optString(src, "source");
                String projectId = optString(src, "projectId");
                String currentId = optString(src, "versionId");
                if (projectId.isBlank()) {
                    throw new IOException("来源记录不完整，重新装一次整合包才能启用更新");
                }

                String gameVersion = instanceGameVersion(instance);
                String loader = instanceLoader(instance);
                if (gameVersion.isBlank()) {
                    throw new IOException("认不出这个实例的游戏版本");
                }

                AddonVersion latest = latestModpackVersion(source, projectId, gameVersion, loader);
                if (latest == null) {
                    throw new IOException("平台上找不到适配 " + gameVersion + " 的版本");
                }
                String latestLabel = displayVersion(latest.number(), latest.filename());
                if (latest.versionId().equals(currentId)) {
                    pushStage(taskId, "已经是最新版本 " + latestLabel, true, null, 1);
                    return;
                }

                pushStage(taskId, "下载 " + latestLabel + "…", false, null, -1);
                temp = Files.createTempFile("hmcl-modpack-update-", ".zip");
                final Path archive = temp;

                String url = "curseforge".equals(source)
                        ? resolveRedirect(latest.fileUrl()) : latest.fileUrl();
                FileDownloadTask download = buildDownload(DownloadProviders.getDownloadProvider(), url, archive);
                AtomicReference<Throwable> downloadError = attachProgress(download, taskId);

                final String newVersionId = latest.versionId();
                final String newVersionNumber = latestLabel;
                final String finalSource = source;
                download.onDone().register(event -> {
                    if (event.isFailed()) {
                        Throwable cause = downloadError.get();
                        pushStage(taskId, "下载失败：" + (cause != null ? cause : "未知错误"),
                                true, String.valueOf(cause), -1);
                        deleteQuietly(archive);
                        return;
                    }
                    Task.runAsync(() -> {
                        try {
                            verifyDownload(archive, latest.fileSize(), null);
                            runModpackUpdateTask(repository, instanceId, dir, archive, taskId,
                                    finalSource, projectId, newVersionId, newVersionNumber,
                                    optString(src, "name"), optString(src, "iconUrl"));
                        } catch (Exception e) {
                            LOG.warning("Failed to update modpack " + instanceId, e);
                            pushStage(taskId, "更新失败：" + e.getMessage(), true, String.valueOf(e), -1);
                            deleteQuietly(archive);
                        }
                    }).start();
                });
                download.executor().start();
            } catch (Exception e) {
                LOG.warning("Failed to start modpack update " + instanceId, e);
                pushStage(taskId, "更新失败：" + e.getMessage(), true, String.valueOf(e), -1);
                deleteQuietly(temp);
            }
        }).start();
    }

    private void runModpackUpdateTask(HMCLGameRepository repository, String instanceId,
                                      @Nullable Path instanceDir, Path archive, String taskId,
                                      String source, String projectId, String newVersionId,
                                      String newVersionNumber, String packName, String iconUrl) {
        try {
            HMCLGameInstance instance = repository.getInstance(new GameInstanceID(instanceId));
            ModpackConfiguration<?> configuration = instance.readModpackConfiguration();
            if (configuration == null) {
                // 没有 modpack.cfg 说明它不是「从整合包装出来的」，更新会把目录搅乱
                throw new IOException("这个实例缺少整合包配置（modpack.cfg），不能直接更新");
            }
            Task<?> task = ModpackHelper.getUpdateTask(
                    repository, archive, new GameInstanceID(instanceId), configuration, null);

            // 先挂「更新成功后写入新来源」：注册顺序决定回调顺序，
            // 后挂的（runWithProgress 的「完成」）要能读到新记录。
            task.onDone().register(event -> {
                deleteQuietly(archive);
                if (!event.isFailed()) {
                    writeModpackSource(instanceDir, new ModpackOrigin(source, projectId,
                            newVersionId, newVersionNumber, packName, iconUrl));
                    modpackUpdateCache.remove(instanceId);
                }
            });
            runWithProgress(task, taskId, () -> selectInstance(instanceId));
        } catch (org.jackhuang.hmcl.modpack.MismatchedModpackTypeException e) {
            // 同一个项目在两个平台都发了包时会出现：实例是 CurseForge 包，
            // 新下载的是 Modrinth 包，文件布局对不上，硬覆盖会把实例搅坏
            pushStage(taskId, "新版本和这个实例的整合包类型不一致（原来是 CurseForge 包，"
                    + "新版从 Modrinth 下载），不能直接覆盖。请重新安装一次整合包。",
                    true, "modpack type mismatch", -1);
            deleteQuietly(archive);
        } catch (Exception e) {
            LOG.warning("Failed to apply modpack update", e);
            pushStage(taskId, "更新失败：" + e.getMessage(), true, String.valueOf(e), -1);
            deleteQuietly(archive);
        }
    }

    // ==================== 已装资源更新 ====================

    /// 本地的一个待查文件。`sha1` 给 Modrinth，`fingerprint` 给 CurseForge。
    private record LocalAddon(String kind, RemoteAddon.Type type, Path file,
                              String fileName, String sha1) {
    }

    /// 平台反查命中的结果：属于哪个项目、本地这一版是什么。
    private record RemoteHit(String source, String projectId, String currentVersion,
                             String currentVersionId, String localDate) {
    }

    /// 检查实例里已装模组 / 资源包 / 光影的更新。
    ///
    /// <p>本地文件没有「我是哪个项目的哪一版」这种元数据（用户可能从任何地方
    /// 拷进来），只能靠指纹反查：Modrinth 认 SHA-1，CurseForge 认它自己的
    /// murmur2。命中项目后再拉一次版本列表，挑当前游戏版本 + 加载器下最新的一份。
    ///
    /// <p>结果从 {@code onAddonUpdates} 推回前端，不走同步返回——几十个模组
    /// 要打几十次接口，同步会把 FX 线程卡住。
    void checkAddonUpdates(String instanceId, @Nullable String kindsCsv) {
        Task.runAsync(() -> {
            JsonObject out = new JsonObject();
            try {
                HMCLGameInstance instance = findInstance(GameDirectoryManager.getSelectedRepository(), instanceId);
                if (instance == null) {
                    throw new IOException("找不到实例");
                }
                String gameVersion = instanceGameVersion(instance);
                String loader = instanceLoader(instance);

                List<String> kinds = new ArrayList<>();
                if (kindsCsv == null || kindsCsv.isBlank()) {
                    kinds.addAll(List.of("mod", "resourcepack", "shader"));
                } else {
                    for (String k : kindsCsv.split(",")) {
                        if (!k.isBlank()) {
                            kinds.add(k.trim());
                        }
                    }
                }

                // 1) 扫目录、算 SHA-1
                List<LocalAddon> local = new ArrayList<>();
                for (String kind : kinds) {
                    RemoteAddon.Type type = addonTypeOf(kind);
                    if (type == null) {
                        continue;
                    }
                    Path dir;
                    try {
                        dir = targetDirectory(type, instanceId);
                    } catch (Exception e) {
                        continue;
                    }
                    if (!Files.isDirectory(dir)) {
                        continue;
                    }
                    try (var stream = Files.list(dir)) {
                        for (Path p : stream.toList()) {
                            String name = p.getFileName().toString();
                            if (!Files.isRegularFile(p)) {
                                continue;
                            }
                            // 世界是目录；模组是 jar，资源包/光影是 zip
                            if (!name.endsWith(".jar") && !name.endsWith(".zip")) {
                                continue;
                            }
                            // 禁用中的文件不会加载，查它没有意义
                            if (name.endsWith(".disabled")) {
                                continue;
                            }
                            String sha1 = sha1Hex(p);
                            if (sha1 == null) {
                                continue;
                            }
                            local.add(new LocalAddon(kind, type, p, name, sha1));
                        }
                    }
                }

                JsonArray items = new JsonArray();
                int matched = 0;
                if (!local.isEmpty()) {
                    // 2) Modrinth：一次批量认领
                    List<String> hashes = new ArrayList<>();
                    for (LocalAddon a : local) {
                        hashes.add(a.sha1());
                    }
                    Map<String, JsonObject> mr = modrinthVersionsByHashes(hashes);

                    Map<String, RemoteHit> hits = new LinkedHashMap<>();
                    List<LocalAddon> left = new ArrayList<>();
                    for (LocalAddon a : local) {
                        JsonObject v = mr.get(a.sha1());
                        if (v == null) {
                            left.add(a);
                            continue;
                        }
                        hits.put(a.fileName(), new RemoteHit(
                                "modrinth",
                                optString(v, "project_id"),
                                optString(v, "version_number"),
                                optString(v, "id"),
                                optString(v, "date_published")));
                    }

                    // 3) 没认出来的再算 CurseForge 指纹（两遍读文件，别白算）
                    if (!left.isEmpty()) {
                        Map<Long, JsonObject> cf = curseFilesByFingerprints(left);
                        for (LocalAddon a : left) {
                            JsonObject file = cf.get(curseFingerprint(a.file()));
                            if (file == null) {
                                continue;
                            }
                            int modId = intValue(file, "modId");
                            hits.put(a.fileName(), new RemoteHit(
                                    "curseforge",
                                    String.valueOf(modId),
                                    optString(file, "displayName"),
                                    String.valueOf(intValue(file, "id")),
                                    optString(file, "fileDate")));
                        }
                    }
                    matched = hits.size();

                    // 4) 逐个项目问「当前版本下最新的是哪一版」
                    items = resolveLatest(instanceId, local, hits, gameVersion, loader);
                }

                out.addProperty("ok", true);
                out.addProperty("checked", local.size());
                out.addProperty("matched", matched);
                out.addProperty("gameVersion", gameVersion);
                out.addProperty("loader", loader);
                out.add("items", items);
            } catch (Throwable e) {
                LOG.warning("Failed to check addon updates of " + instanceId, e);
                out.addProperty("ok", false);
                out.addProperty("error", e.getMessage() == null ? String.valueOf(e) : e.getMessage());
                out.add("items", new JsonArray());
            }
            String text = JsonUtils.GSON.toJson(out);
            push.accept("window.__hmcl && window.__hmcl.onAddonUpdates("
                    + JsonUtils.GSON.toJson(text) + ")");
        }).start();
    }

    /// 对每个命中项查最新版本，能并发的部分开 4 个线程。
    ///
    /// <p>串行的话 20 个模组要 8–10 秒，用户会以为按钮没反应。
    /// 平台限流按 IP 算，4 并发远低于阈值。
    private static JsonArray resolveLatest(String instanceId, List<LocalAddon> local,
                                           Map<String, RemoteHit> hits,
                                           String gameVersion, String loader) {
        JsonArray items = new JsonArray();
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(4);
        List<java.util.concurrent.Future<JsonObject>> futures = new ArrayList<>();
        Set<String> seen = ConcurrentHashMap.newKeySet();

        for (LocalAddon a : local) {
            RemoteHit hit = hits.get(a.fileName());
            if (hit == null) {
                continue;
            }
            // 同一个项目装了多份（旧版没删）时只报一条，否则列表里会出现
            // 两行一模一样的「X → 新版」
            if (!seen.add(hit.source() + ":" + hit.projectId() + ":" + a.kind())) {
                continue;
            }
            futures.add(pool.submit(() -> {
                try {
                    return latestFor(a, hit, gameVersion, loader);
                } catch (Throwable e) {
                    LOG.info("[addon] update check skipped " + a.fileName() + ": " + e.getMessage());
                    return null;
                }
            }));
        }

        for (var future : futures) {
            try {
                JsonObject one = future.get(45, java.util.concurrent.TimeUnit.SECONDS);
                if (one != null) {
                    items.add(one);
                }
            } catch (Throwable ignored) {
                // 单个项目超时/失败不影响其它
            }
        }
        pool.shutdownNow();
        return items;
    }

    /// 一个文件的新版本。已经是最新（或当前版本没有可用构建）时返回 null。
    private static @Nullable JsonObject latestFor(LocalAddon local, RemoteHit hit,
                                                  String gameVersion, String loader) throws IOException {
        // 资源包和光影没有加载器概念，传 null 才不会被筛空
        String effectiveLoader = local.type() == RemoteAddon.Type.MOD ? loader : null;
        AddonVersion latest;
        if ("curseforge".equals(hit.source())) {
            List<AddonVersion> versions = cfFiles(hit.projectId(), gameVersion, effectiveLoader);
            if (versions.isEmpty()) {
                return null;
            }
            versions.sort(Comparator.comparing(AddonVersion::date).reversed());
            latest = versions.get(0);
        } else {
            List<AddonVersion> versions = fetchVersions(hit.projectId(), gameVersion, effectiveLoader);
            if (versions.isEmpty()) {
                return null;
            }
            latest = versions.get(0);
        }
        if (latest.versionId() == null || latest.versionId().equals(hit.currentVersionId())) {
            return null;
        }
        // 本地装的是比"最新"还新的测试版时不要提示降级：
        // 平台列表的第一条只保证是最近发布的，不保证比本地新。
        if (!hit.localDate().isBlank() && latest.date() != null && !latest.date().isBlank()
                && hit.localDate().compareTo(latest.date()) >= 0) {
            return null;
        }

        String name = local.fileName();
        if (local.type() == RemoteAddon.Type.MOD) {
            ModScanService.ModMeta meta = ModScanService.readMeta(local.file());
            if (meta != null && meta.name() != null && !meta.name().isBlank()) {
                name = meta.name();
            }
        } else {
            // 资源包/光影没有统一的元数据，去掉扩展名当名字就够了
            name = stripExtension(name);
        }

        JsonObject o = new JsonObject();
        o.addProperty("kind", local.kind());
        o.addProperty("file", local.fileName());
        o.addProperty("name", name);
        o.addProperty("source", hit.source());
        o.addProperty("projectId", hit.projectId());
        o.addProperty("versionId", latest.versionId());
        o.addProperty("currentVersion", prettyVersion(displayVersion(hit.currentVersion(), local.fileName())));
        o.addProperty("latestVersion", prettyVersion(displayVersion(latest.number(), latest.filename())));
        o.addProperty("fileName", latest.filename());
        o.addProperty("downloadUrl", latest.fileUrl());
        o.addProperty("size", latest.fileSize());
        o.addProperty("date", latest.date());
        o.addProperty("type", latest.type());
        return o;
    }

    /// 平台给的版本号常掺着游戏版本和加载器（`mc1.21.1-0.15.3-fabric`、
    /// `1.8.14-beta.1+1.21.1-fabric`），更新列表里只留给人看的那一段。
    private static String prettyVersion(String version) {
        if (version == null || version.isBlank()) {
            return "";
        }
        String v = version.trim();
        v = v.replaceFirst("(?i)^mc\\d+(\\.\\d+)+-", "");
        v = v.replaceFirst("(?i)\\+\\d+(\\.\\d+)+-(fabric|forge|neoforge|quilt)$", "");
        v = v.replaceFirst("(?i)-(fabric|forge|neoforge|quilt)$", "");
        return v;
    }

    private static @Nullable RemoteAddon.Type addonTypeOf(String kind) {
        return switch (kind == null ? "" : kind) {
            case "mod" -> RemoteAddon.Type.MOD;
            case "resourcepack" -> RemoteAddon.Type.RESOURCE_PACK;
            case "shader" -> RemoteAddon.Type.SHADER_PACK;
            default -> null;
        };
    }

    /// Modrinth 的批量指纹接口：`POST /version_files`，一次最多 100 个。
    private static Map<String, JsonObject> modrinthVersionsByHashes(List<String> hashes) throws IOException {
        Map<String, JsonObject> out = new LinkedHashMap<>();
        for (int i = 0; i < hashes.size(); i += 100) {
            List<String> chunk = hashes.subList(i, Math.min(i + 100, hashes.size()));
            JsonObject body = new JsonObject();
            JsonArray array = new JsonArray();
            chunk.forEach(array::add);
            body.add("hashes", array);
            body.addProperty("algorithm", "sha1");

            JsonObject resp = HttpRequest.POST(API + "/version_files")
                    .json(body)
                    .getJson(JsonObject.class);
            for (Map.Entry<String, JsonElement> e : resp.entrySet()) {
                if (e.getValue().isJsonObject()) {
                    out.put(e.getKey().toLowerCase(Locale.ROOT), e.getValue().getAsJsonObject());
                }
            }
        }
        return out;
    }

    /// CurseForge 的批量指纹接口，返回 fileId → 文件对象。
    private static Map<Long, JsonObject> curseFilesByFingerprints(List<LocalAddon> files) throws IOException {
        String key = CurseForgeRemoteAddonRepository.API_KEY;
        if (key == null || key.isBlank()) {
            return Map.of();
        }
        Map<Long, JsonObject> out = new LinkedHashMap<>();
        List<Long> fingerprints = new ArrayList<>();
        for (LocalAddon a : files) {
            fingerprints.add(curseFingerprint(a.file()));
        }
        for (int i = 0; i < fingerprints.size(); i += 500) {
            List<Long> chunk = fingerprints.subList(i, Math.min(i + 500, fingerprints.size()));
            JsonObject body = new JsonObject();
            JsonArray array = new JsonArray();
            chunk.forEach(array::add);
            body.add("fingerprints", array);

            // header() 返回的是基类 HttpRequest，必须放在 json() 之后，
            // 否则链式调用会在 header 那里丢掉 HttpEntityRequest 的 json 方法
            JsonObject resp = HttpRequest.POST(CF_API + "/v1/fingerprints")
                    .json(body)
                    .header("x-api-key", key)
                    .header("Accept", "application/json")
                    .getJson(JsonObject.class);
            if (!resp.has("data") || !resp.get("data").isJsonObject()) {
                continue;
            }
            JsonObject data = resp.getAsJsonObject("data");
            if (!data.has("exactMatches") || !data.get("exactMatches").isJsonArray()) {
                continue;
            }
            for (JsonElement e : data.getAsJsonArray("exactMatches")) {
                if (!e.isJsonObject()) {
                    continue;
                }
                JsonObject match = e.getAsJsonObject();
                if (!match.has("file") || !match.get("file").isJsonObject()) {
                    continue;
                }
                JsonObject file = match.getAsJsonObject("file");
                int fileId = intValue(file, "id");
                if (fileId > 0) {
                    out.put((long) fileId, file);
                }
            }
        }
        return out;
    }

    /// 把 fileId 换成指纹。
    ///
    /// <p>CurseForge 的指纹不对整个文件做哈希，而是 MurmurHash2（seed=1），
    /// 并且跳过空白字节（tab / LF / CR / 空格）。所以得读两遍：第一遍数
    /// 有效字节数（哈希初值要用），第二遍才算。jar 都是二进制，两遍读
    /// 只是多一次磁盘缓存命中，几十 MB 也就几十毫秒。
    private static long curseFingerprint(Path file) throws IOException {
        long length = 0;
        try (var in = Files.newInputStream(file)) {
            byte[] buf = new byte[65536];
            int read;
            while ((read = in.read(buf)) > 0) {
                for (int i = 0; i < read; i++) {
                    if (!isCurseWhitespace(buf[i])) {
                        length++;
                    }
                }
            }
        }

        final int m = 0x5bd1e995;
        int h = 1 ^ (int) length;
        byte[] quad = new byte[4];
        int fill = 0;
        try (var in = Files.newInputStream(file)) {
            byte[] buf = new byte[65536];
            int read;
            while ((read = in.read(buf)) > 0) {
                for (int i = 0; i < read; i++) {
                    byte b = buf[i];
                    if (isCurseWhitespace(b)) {
                        continue;
                    }
                    quad[fill++] = b;
                    if (fill == 4) {
                        int k = (quad[0] & 0xFF)
                                | ((quad[1] & 0xFF) << 8)
                                | ((quad[2] & 0xFF) << 16)
                                | ((quad[3] & 0xFF) << 24);
                        k *= m;
                        k ^= k >>> 24;
                        k *= m;
                        h *= m;
                        h ^= k;
                        fill = 0;
                    }
                }
            }
        }
        switch (fill) {
            case 3:
                h ^= (quad[2] & 0xFF) << 16;
            case 2:
                h ^= (quad[1] & 0xFF) << 8;
            case 1:
                h ^= (quad[0] & 0xFF);
                h *= m;
            default:
                break;
        }
        h ^= h >>> 13;
        h *= m;
        h ^= h >>> 15;
        return h & 0xFFFFFFFFL;
    }

    private static boolean isCurseWhitespace(byte b) {
        return b == 0x09 || b == 0x0A || b == 0x0D || b == 0x20;
    }

    /// 批量更新。前端已经挑好要更新的项，这里只负责下载 + 替换。
    ///
    /// <p>串行执行：同时下五个文件带宽和磁盘都抢，进度条也看不懂。
    /// 每项先下到 `<文件名>.part`，校验是有效压缩包才改名覆盖，最后删旧文件。
    void applyAddonUpdates(String instanceId, String itemsJson) {
        String taskId = "update:" + instanceId;
        List<JsonObject> items = new ArrayList<>();
        try {
            JsonElement parsed = com.google.gson.JsonParser.parseString(itemsJson);
            if (parsed.isJsonArray()) {
                for (JsonElement e : parsed.getAsJsonArray()) {
                    if (e.isJsonObject()) {
                        items.add(e.getAsJsonObject());
                    }
                }
            }
        } catch (Throwable e) {
            pushStage(taskId, "更新参数不合法", true, String.valueOf(e), -1);
            return;
        }
        if (items.isEmpty()) {
            return;
        }

        Task.runAsync(() -> {
            DownloadProvider provider = DownloadProviders.getDownloadProvider();
            int total = items.size();
            int updated = 0;
            JsonArray doneFiles = new JsonArray();
            JsonArray failedFiles = new JsonArray();

            for (int i = 0; i < total; i++) {
                JsonObject it = items.get(i);
                String label = optString(it, "name");
                if (label.isBlank()) {
                    label = optString(it, "file");
                }
                pushStage(taskId, "正在更新 " + label + "（" + (i + 1) + "/" + total + "）",
                        false, null, (double) i / total);

                Path temp = null;
                try {
                    RemoteAddon.Type type = addonTypeOf(optString(it, "kind"));
                    if (type == null) {
                        throw new IOException("未知的资源类型");
                    }
                    Path dir = targetDirectory(type, instanceId);
                    Files.createDirectories(dir);

                    String newName = safeFileName(optString(it, "fileName"), taskId);
                    String oldName = optString(it, "file");
                    String url = optString(it, "downloadUrl");
                    if (url.isBlank()) {
                        throw new IOException("没有下载地址");
                    }
                    // CurseForge 的直链是 302 到 mediafilez，且那边不认 Range
                    if ("curseforge".equals(optString(it, "source"))) {
                        url = resolveRedirect(url);
                    }

                    temp = dir.resolve(newName + ".part");
                    FileDownloadTask task = buildDownload(provider, url, temp);
                    attachProgress(task, taskId);
                    if (!downloadSync(task)) {
                        throw new IOException("下载失败");
                    }
                    verifyArchive(temp);
                    Files.move(temp, dir.resolve(newName),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING);

                    // 换了文件名才删旧的；同名的情况上面已经覆盖掉了
                    if (!newName.equals(oldName) && !oldName.isBlank()) {
                        Files.deleteIfExists(dir.resolve(oldName));
                        Files.deleteIfExists(dir.resolve(oldName + ".disabled"));
                    }
                    updated++;
                    doneFiles.add(newName);
                } catch (Throwable e) {
                    LOG.warning("Failed to update addon " + optString(it, "file"), e);
                    failedFiles.add(label + "：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
                    deleteQuietly(temp);
                }
            }

            int failed = failedFiles.size();
            pushStage(taskId, updated + " 个已更新" + (failed > 0 ? "，" + failed + " 个失败" : ""),
                    true, failed > 0 ? failedFiles.toString() : null, 1);

            JsonObject done = new JsonObject();
            done.addProperty("ok", failed == 0);
            done.addProperty("updated", updated);
            done.addProperty("failed", failed);
            done.add("files", doneFiles);
            done.add("errors", failedFiles);
            String text = JsonUtils.GSON.toJson(done);
            push.accept("window.__hmcl && window.__hmcl.onAddonUpdatesApplied("
                    + JsonUtils.GSON.toJson(text) + ")");
        }).start();
    }

    /// 等一个下载任务跑完。批量更新是串行的，用 latch 比回调套回调清楚。
    private static boolean downloadSync(FileDownloadTask task) throws InterruptedException {
        java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.atomic.AtomicBoolean ok =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        task.onDone().register(event -> {
            ok.set(!event.isFailed());
            latch.countDown();
        });
        task.executor().start();
        latch.await();
        return ok.get();
    }

    // ==================== 拖拽安装 ====================

    /// 已经发过安装请求的依赖 mod id。
    /// 依赖是异步装的，扫描窗口里它还不在 mods 目录，不去重会连发好几次。
    private final Set<String> depsInFlight = ConcurrentHashMap.newKeySet();

    /// 拖入的文件按识别结果落盘。
    void installDropped(String kind, Path file, @Nullable String instanceId) {
        if ("modpack".equals(kind)) {
            installDroppedModpack(file, instanceId);
            return;
        }
        installLocalFile(kind, file, instanceId, null, false);
    }

    /// 拖进来的整合包：先问两个平台「这是你们站上的哪个项目」，问到了就带上官方图标。
    void installDroppedModpack(Path archive, @Nullable String instanceId) {
        String taskId = "local:" + archive.getFileName();
        Task.runAsync(() -> {
            JsonObject match = DropService.matchModpack(archive, null);
            String iconUrl = null;
            String name = null;
            boolean ok = match.has("ok") && match.get("ok").getAsBoolean();
            if (ok) {
                iconUrl = match.get("iconUrl").getAsString();
                name = match.get("name").getAsString();
                if (iconUrl != null && !iconUrl.isBlank()) {
                    pushStage(taskId, "已匹配到平台项目：" + name, false, null, 0.1);
                }
            }
            final String finalIcon = iconUrl == null || iconUrl.isBlank() ? null : iconUrl;
            final String finalName = name == null || name.isBlank() ? null : name;
            // 拖进来的包只能匹配到「是哪个项目」，匹配不到具体版本号（versionId 空）。
            // 记下来是为了以后能提示「来源是 X 项目」，但更新检查会明确拒绝，
            // 否则拿最新版一比永远是「有更新」。
            final String matchSource = ok ? match.get("source").getAsString() : null;
            final String matchSlug = ok ? match.get("slug").getAsString() : null;
            final ModpackOrigin origin = ok && matchSlug != null && !matchSlug.isBlank()
                    ? new ModpackOrigin(matchSource, matchSlug, "", "", name, finalIcon)
                    : null;
            Platform.runLater(() -> installModpackArchive(archive, finalIcon, finalName, taskId, false, origin));
        }).start();
    }

    // ==================== 依赖自动补全 ====================

    /// 装完模组后自动补齐缺失的前置，最多三轮。
    /// 用延迟重扫而不是等任务完成：下载是异步的，`install()` 没有可等待的句柄；
    /// 扫描是幂等的，已装上的不会再报缺。
    void autoInstallDependencies(@Nullable String instanceId) {
        if (instanceId == null || instanceId.isBlank()) {
            return;
        }
        autoInstallDependencies(instanceId, 0);
    }

    private void autoInstallDependencies(String instanceId, int round) {
        if (round >= 3) {
            return;
        }
        Task.runAsync(() -> {
            int started = 0;
            try {
                HMCLGameInstance instance = findInstance(GameDirectoryManager.getSelectedRepository(), instanceId);
                if (instance == null) {
                    return;
                }
                String gameVersion = instanceGameVersion(instance);
                String loader = instanceLoader(instance);
                // 原版实例没有模组加载器：fabric-api 这类前置装进去也不会生效，
                // 只会在共享目录里留垃圾。要装模组得先加加载器，那个提示由 dropImport 给。
                if (loader.isEmpty()) {
                    LOG.info("[drop] instance " + instanceId + " is vanilla, skip dependency scan");
                    return;
                }
                LOG.info("[drop] scan instance " + instanceId + " game=" + gameVersion + " loader=" + loader);

                JsonObject scan = JsonUtils.GSON.fromJson(ModScanService.scan(instanceId), JsonObject.class);
                JsonArray missing = scan != null && scan.has("missing") && scan.get("missing").isJsonArray()
                        ? scan.getAsJsonArray("missing") : new JsonArray();

                // fabric-api 这类「一个项目包含一堆子模块」的前置，几个子模块会解析到
                // 同一个 slug 同一个版本。不按目标去重的话，一次扫描就会把同一个文件
                // 排进下载队列七八次（实测 7 次），既费流量又把任务条刷满。
                java.util.Set<String> planned = new java.util.HashSet<>();

                for (JsonElement e : missing) {
                    if (!e.isJsonObject()) {
                        continue;
                    }
                    String needs = e.getAsJsonObject().has("needs")
                            ? e.getAsJsonObject().get("needs").getAsString() : "";
                    if (needs.isBlank() || !depsInFlight.add(needs)) {
                        continue;
                    }
                    // 实例版本认不出来时，从前置的版本区间里猜（"0.8.13+mc1.21.1" -> 1.21.1）。
                    // 猜不到就跳过：装一个版本不对的模组，比不装更容易让游戏起不来。
                    String gv = gameVersion;
                    if (gv.isBlank()) {
                        String range = e.getAsJsonObject().has("range")
                                ? e.getAsJsonObject().get("range").getAsString() : "";
                        gv = guessGameVersionFromRange(range);
                    }
                    if (gv.isBlank()) {
                        depsInFlight.remove(needs);
                        LOG.info("[drop] instance game version unknown, skip dependency " + needs);
                        continue;
                    }
                    String slug = resolveSlugSync(needs);
                    if (slug == null) {
                        depsInFlight.remove(needs);
                        LOG.info("[drop] dependency " + needs + " not found on Modrinth, skipped");
                        continue;
                    }
                    String versionId = latestReleaseId(slug, gv, loader);
                    if (versionId == null) {
                        depsInFlight.remove(needs);
                        LOG.info("[drop] no release of " + slug + " for " + gv + "/" + loader);
                        continue;
                    }
                    String target = slug + "@" + versionId;
                    if (!planned.add(target)) {
                        LOG.info("[drop] dependency " + needs + " -> " + target + "（同一目标已排队，跳过）");
                        continue;
                    }
                    LOG.info("[drop] auto install dependency " + needs + " -> " + target);
                    install("mod", slug, versionId, instanceId, null, null);
                    started++;
                }
            } catch (Throwable t) {
                LOG.warning("Failed to auto install dependencies", t);
            }

            if (started > 0) {
                final int next = round + 1;
                java.util.concurrent.CompletableFuture.delayedExecutor(12, java.util.concurrent.TimeUnit.SECONDS)
                        .execute(() -> autoInstallDependencies(instanceId, next));
            }
        }).start();
    }

    /// mod id -> Modrinth slug 的同步版本。
    @Nullable
    private static String resolveSlugSync(String modId) {
        try {
            String id = modId.trim();
            if (id.isEmpty()) {
                return null;
            }
            // Fabric 模组的依赖写的是 Fabric API 的**子模块** id
            // （fabric-rendering-fluids-v1 这种）。它们在 Modrinth 上不是独立项目，
            // 直接查必然 404 —— 统一落到 fabric-api，否则装一个依赖 Fabric API 的模组
            // 会报五六条「找不到」，看起来像坏了。
            if (id.startsWith("fabric-") || id.startsWith("fabric_")) {
                return "fabric-api";
            }
            JsonObject project = null;
            try {
                project = HttpRequest.GET(API + "/project/" + enc(id)).getJson(JsonObject.class);
            } catch (Exception ignored) {
                // mod id 和 slug 不一致时这里 404，正常
            }
            if (project == null || !project.has("slug") || project.get("slug").isJsonNull()) {
                project = searchProject(id);
            }
            if (project == null || !project.has("slug") || project.get("slug").isJsonNull()) {
                return null;
            }
            return project.get("slug").getAsString();
        } catch (Throwable t) {
            return null;
        }
    }

    /// 这个项目最新一个正式版（release）。
    @Nullable
    private static String latestReleaseId(String slug, String gameVersion, String loader) {
        try {
            List<AddonVersion> all = fetchVersions(slug, gameVersion, loader);
            for (AddonVersion v : all) {
                if ("release".equalsIgnoreCase(v.type())) {
                    return v.versionId();
                }
            }
            return all.isEmpty() ? null : all.get(0).versionId();
        } catch (Throwable t) {
            return null;
        }
    }

    /// 从版本区间里猜游戏版本。
    ///
    /// <p>模组的依赖写法五花八门：`0.8.13+mc1.21.1`、`~1.21`、`>=1.20.1`。
    /// 只有带 `mc` 前缀的那种能确定是游戏版本，其余不敢猜 —— `>=0.5.0` 那是
    /// 模组自己的版本号，拿来当游戏版本会装错东西。
    @Nullable
    private static String guessGameVersionFromRange(String range) {
        if (range == null || range.isBlank()) {
            return "";
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("mc(\\d+\\.\\d+(?:\\.\\d+)?)")
                .matcher(range.toLowerCase(Locale.ROOT));
        return m.find() ? m.group(1) : "";
    }

    /// 实例的游戏版本。
    ///
    /// <p>优先问组件解析（真实实例都有值）；解析不出来时退回实例 id 里那串数字 ——
    /// `1.21.1` / `1.21.1-fabric` 都能提出 `1.21.1`。这一步是必要的兜底：
    /// 版本为空会让下游的版本过滤整体失效，装上来的是「最新版」（可能是给
    /// 未来某个游戏版本的），比不装更糟。
    private static String instanceGameVersion(HMCLGameInstance instance) {
        try {
            String v = instance.getComponentVersion(org.jackhuang.hmcl.game.GameComponentType.GAME);
            if (v != null && !v.isBlank()) {
                return v;
            }
        } catch (Throwable ignored) {
        }
        try {
            String id = String.valueOf(instance.getId());
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("(\\d+\\.\\d+(?:\\.\\d+)?)").matcher(id);
            return m.find() ? m.group(1) : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /// 这个实例装了模组加载器没有。原版实例拖 jar 进去不会生效，前端要提示一句。
    boolean hasModLoader(@Nullable String instanceId) {
        if (instanceId == null || instanceId.isBlank()) {
            return false;
        }
        try {
            HMCLGameInstance instance = findInstance(GameDirectoryManager.getSelectedRepository(), instanceId);
            return instance != null && !instanceLoader(instance).isEmpty();
        } catch (Throwable e) {
            return false;
        }
    }

    private static String instanceLoader(HMCLGameInstance instance) {
        try {
            for (org.jackhuang.hmcl.game.GameComponentType type : org.jackhuang.hmcl.game.GameComponentType.MOD_LOADERS) {
                String v = instance.getComponentVersion(type);
                if (v != null) {
                    var loaderType = type.getModLoaderType();
                    return loaderType != null ? loaderType.name().toLowerCase(Locale.ROOT) : type.name();
                }
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    private void installModpackArchive(Path archive, @Nullable String iconUrl,
                                       @Nullable String preferredName, String taskId) {
        installModpackArchive(archive, iconUrl, preferredName, taskId, false);
    }

    /// @param tempDownload 这个包是不是刚下到临时目录的（是的话装完删掉）。
    ///                     用户从磁盘选的文件传 false —— 删了就是事故。
    ///
    /// <p>注意删除**必须挂在任务完成之后**：`runWithProgress` 只是把任务挂上进度条
    /// 然后立刻返回（它不阻塞），在 finally 里删就等于边解压边删文件，
    /// 任务跑到 `MinecraftInstanceTask` 时直接 NoSuchFileException，
    /// 留下一个装了一半的实例目录。实测复现过。
    private void installModpackArchive(Path archive, @Nullable String iconUrl,
                                       @Nullable String preferredName, String taskId,
                                       boolean tempDownload) {
        installModpackArchive(archive, iconUrl, preferredName, taskId, tempDownload, null);
    }

    /// @param origin 平台来源。非空时在装完后写进实例目录，供「检查更新」用。
    private void installModpackArchive(Path archive, @Nullable String iconUrl,
                                       @Nullable String preferredName, String taskId,
                                       boolean tempDownload, @Nullable ModpackOrigin origin) {
        // 任务已经拿着这个 zip 在跑了 —— finally 里就不能再删
        boolean[] handedOff = {false};
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            if (repository == null) {
                throw new IOException("没有可用的游戏目录");
            }

            Modpack modpack;
            try {
                modpack = ModpackHelper.readModpackManifest(archive);
            } catch (ManuallyCreatedModpackException e) {
                // 手动打包的整合包（没有 manifest，只有 .minecraft 结构）
                String name = uniqueInstanceId(repository,
                        preferredName != null ? preferredName : stripExtension(archive.getFileName().toString()));
                pushStage(taskId, "按手动整合包装载：" + name, false, null, 0.2);
                Task<?> manual = ModpackHelper.getInstallManuallyCreatedModpackTask(archive, name);
                if (tempDownload) {
                    handedOff[0] = true;
                    manual.onDone().register(event -> deleteQuietly(archive));
                }
                if (origin != null) {
                    manual.onDone().register(event -> {
                        if (event.isFailed()) {
                            return;
                        }
                        try {
                            Path dir = modpackInstanceDir(repository.getInstance(new GameInstanceID(name)));
                            writeModpackSource(dir, origin);
                        } catch (Exception ex) {
                            LOG.warning("Failed to record modpack source for " + name, ex);
                        }
                    });
                }
                runWithProgress(manual, taskId, () -> selectInstance(name));
                return;
            }

            String wanted = preferredName != null && !preferredName.isBlank()
                    ? preferredName
                    : modpack.getName();
            String id = uniqueInstanceId(repository, wanted);

            pushStage(taskId, "开始安装整合包 " + id + "…", false, null, 0.2);
            Task<?> task = ModpackHelper.getInstallTask(
                    repository, archive, new GameInstanceID(id), modpack, iconUrl, null);
            if (tempDownload) {
                handedOff[0] = true;
                task.onDone().register(event -> deleteQuietly(archive));
            }
            if (origin != null) {
                // 装完才写：中途失败不该留下「有出处」的假记录
                task.onDone().register(event -> {
                    if (event.isFailed()) {
                        return;
                    }
                    try {
                        Path dir = modpackInstanceDir(repository.getInstance(new GameInstanceID(id)));
                        writeModpackSource(dir, origin);
                    } catch (Exception e) {
                        LOG.warning("Failed to record modpack source for " + id, e);
                    }
                });
            }
            runWithProgress(task, taskId, () -> selectInstance(id));
        } catch (org.jackhuang.hmcl.modpack.UnsupportedModpackException e) {
            // 既没有清单、也找不到 .minecraft 结构：多半是普通压缩包
            LOG.warning("Not a modpack: " + archive, e);
            pushStage(taskId, "这个压缩包里既没有整合包清单，也没有 .minecraft 目录，不是整合包",
                    true, "unsupported modpack", -1);
        } catch (Exception e) {
            LOG.warning("Failed to install modpack archive", e);
            pushStage(taskId, "整合包安装失败：" + e.getMessage(), true, String.valueOf(e), -1);
        } finally {
            // 只删「下载到临时目录」的那份；用户自己选的文件动都不动。
            // 任务已经接手的话交给它的完成回调删。
            if (tempDownload && !handedOff[0]) {
                deleteQuietly(archive);
            }
        }
    }

    /// 世界存档是 .zip，里面顶层就是 level.dat 那一堆文件。
    /// 解压到 saves/<存档名>/。
    private void installWorldArchive(Path archive, @Nullable String instanceId, String taskId) throws IOException {
        installWorldArchive(archive, instanceId, taskId, null, null);
    }

    /// @param preferredName 非空时用它当存档目录名。在线下载的包落在
    ///        `hmcl-world-123456.zip` 这种临时文件上，直接拿文件名会得到
    ///        `hmcl-world-123456` 这样的存档，用户根本认不出是哪个地图。
    private void installWorldArchive(Path archive, @Nullable String instanceId, String taskId,
                                     @Nullable String preferredName, @Nullable Path directory) throws IOException {
        Path saves = directory != null ? directory : targetDirectory(RemoteAddon.Type.WORLD, instanceId);
        Files.createDirectories(saves);

        String base = preferredName != null && !preferredName.isBlank()
                ? preferredName
                : stripExtension(archive.getFileName().toString());
        String name = uniqueSaveName(saves, base);
        Path dest = saves.resolve(name);

        pushStage(taskId, "正在解压世界存档…", false, null, 0.3);
        Files.createDirectories(dest);

        int count;
        try {
            count = extractWorld(archive, dest, name, taskId);
        } catch (Exception e) {
            // 解到一半失败：把半成品删掉。留着空壳的话，下次导入同名世界
            // 会被去重成「名字 (2)」，用户看到多出来一个空存档。
            try { deleteRecursively(dest); } catch (IOException ignored) { }
            throw e;
        }

        if (!Files.isRegularFile(dest.resolve("level.dat"))) {
            throw new IOException("压缩包里没有 level.dat，不是有效的世界存档");
        }

        pushStage(taskId, "已导入世界「" + name + "」（" + count + " 个文件）", true, null, 1);
    }

    private int extractWorld(Path archive, Path dest, String name, String taskId) throws IOException {
        // 先按 UTF-8 读。Windows 上打的 zip 经常是 GBK 而且不带 UTF-8 标记，
        // ZipInputStream 会抛「malformed input off : 0, length : 4」——
        // 那不是包坏了，是编码不对。这种就清空重来，换 GBK 再解一次。
        try {
            return extractWorldWith(archive, dest, java.nio.charset.StandardCharsets.UTF_8, name, taskId);
        } catch (IllegalArgumentException e) {
            LOG.info("[addon] world zip is not UTF-8, retrying with GBK: " + e.getMessage());
            try {
                deleteRecursively(dest);
            } catch (IOException ignored) {
                // 清不掉就让后面的解压自己覆盖，不在这里中断
            }
            Files.createDirectories(dest);
            return extractWorldWith(archive, dest, java.nio.charset.Charset.forName("GBK"), name, taskId);
        }
    }

    private int extractWorldWith(Path archive, Path dest, java.nio.charset.Charset charset,
                                 String name, String taskId) throws IOException {
        int count = 0;
        try (ZipInputStream zis = new ZipInputStream(Files.newInputStream(archive), charset)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                // 防目录穿越：resolve 之后必须还在 dest 里面
                Path target = dest.resolve(entry.getName()).normalize();
                if (!target.startsWith(dest)) {
                    throw new IOException("压缩包里有非法路径：" + entry.getName());
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(zis, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    count++;
                }
                zis.closeEntry();
            }
        }

        // 有些世界包在根上加了一层目录（`MyWorld/level.dat`），直接解压出来
        // 游戏里就看不到存档。判断不能靠猜名字——包里的目录名常常和 zip 文件名
        // 不一样，所以只看「dest 下是否恰好只有一个子目录，且它有 level.dat」。
        if (!Files.isRegularFile(dest.resolve("level.dat"))) {
            Path onlyChild = null;
            int childCount = 0;
            try (var list = Files.list(dest)) {
                for (Path child : list.toList()) {
                    childCount++;
                    onlyChild = child;
                }
            }
            if (childCount == 1 && onlyChild != null
                    && Files.isDirectory(onlyChild)
                    && Files.isRegularFile(onlyChild.resolve("level.dat"))) {
                pushStage(taskId, "调整目录结构…", false, null, 0.8);
                Path temp = dest.resolveSibling(name + "__tmp");
                Files.move(onlyChild, temp);
                deleteRecursively(dest);
                Files.move(temp, dest);
            }
        }

        return count;
    }

    // ==================== 内部工具 ====================

    // ==================== 进度 ====================
    //
    // 下面几个都是 `TaskProgress` 的薄封装。`pushStage` 有四十多处调用、
    // `runWithProgress` 十几处，统一改名只会制造噪音，留着当门面。

    private AtomicReference<Throwable> attachProgress(Task<?> task, String taskId) {
        return progress.attach(task, taskId);
    }

    private void runWithProgress(Task<?> task, String taskId, Runnable onSuccess) {
        progress.run(task, taskId, onSuccess);
    }

    private void pushStage(String id, String stage, boolean done, @Nullable String error, double percent) {
        progress.stage(id, stage, done, error, percent);
    }

    private static String shortStage(@Nullable String raw) {
        return TaskProgress.shorten(raw);
    }

    private void selectInstance(String id) {
        try {
            HMCLGameRepository repository = GameDirectoryManager.getSelectedRepository();
            if (repository != null) {
                repository.refresh();
                repository.setSelectedInstance(repository.getInstance(new GameInstanceID(id)));
            }
        } catch (Exception e) {
            LOG.warning("Failed to select instance " + id, e);
        }
        push.accept("window.__hmcl && window.__hmcl.onInstallFinished("
                + JsonUtils.GSON.toJson(id) + ")");
    }
    /// 给任务起个名字（文件名 / 版本名）。只发一次，前端记住后用于列表标题。
    ///
    /// 单独发而不用 pushStage 的参数，是因为 pushStage 在下载过程中会被高频调用，
    /// 每次多带一个字符串没必要；标题在整个任务里是不变的。
    private void pushTitle(String taskId, String title) {
        if (taskId == null || title == null || title.isBlank()) {
            return;
        }
        JsonObject json = new JsonObject();
        json.addProperty("id", taskId);
        json.addProperty("title", title);
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallTitle("
                + JsonUtils.GSON.toJson(text) + ")"));
    }


    /// 类型枚举 → 前端用的字符串，`parseType` 的反函数。
    private static String typeNameOf(RemoteAddon.Type type) {
        return switch (type) {
            case MOD -> "mod";
            case MODPACK -> "modpack";
            case RESOURCE_PACK -> "resourcepack";
            case SHADER_PACK -> "shader";
            case WORLD -> "world";
            case CUSTOMIZATION -> "customization";
        };
    }

    private static RemoteAddon.Type parseType(@Nullable String type) {
        if (type == null) {
            return null;
        }
        return switch (type.toLowerCase(Locale.ROOT)) {
            case "mod" -> RemoteAddon.Type.MOD;
            case "modpack" -> RemoteAddon.Type.MODPACK;
            case "resourcepack" -> RemoteAddon.Type.RESOURCE_PACK;
            case "shader", "shaderpack" -> RemoteAddon.Type.SHADER_PACK;
            case "world" -> RemoteAddon.Type.WORLD;
            default -> null;
        };
    }

    /// 实例名去重：`名字`、`名字 (2)`、`名字 (3)`…
    /// 整合包实例该叫什么名字。
    ///
    /// <p>调用方没给名字时不能直接退回 `version.name` —— Modrinth 上这个字段
    /// 经常就是 "1.0.4" 这样的纯版本号，装完实例列表里一排数字，认不出是哪个包。
    /// 退而求其次用包文件名（`Mine-In-Abyss-1.0.4.zip`），至少带着整合包的名字。
    private static String modpackDisplayName(@Nullable String preferredName, AddonVersion version) {
        if (preferredName != null && !preferredName.isBlank()) {
            return preferredName;
        }
        String file = version.filename();
        if (file != null && !file.isBlank()) {
            String base = stripExtension(file);
            if (!base.isBlank()) {
                return base;
            }
        }
        return version.name();
    }

    private static String uniqueInstanceId(HMCLGameRepository repository, @Nullable String rawName) {
        String base = sanitizeName(rawName == null || rawName.isBlank() ? "整合包" : rawName);
        if (repository.findInstance(new GameInstanceID(base)) == null) {
            return base;
        }
        for (int i = 2; i < 1000; i++) {
            String candidate = base + " (" + i + ")";
            if (repository.findInstance(new GameInstanceID(candidate)) == null) {
                return candidate;
            }
        }
        return base + "-" + System.currentTimeMillis();
    }

    private static String uniqueSaveName(Path saves, String rawName) throws IOException {
        String base = sanitizeName(rawName);
        if (!Files.exists(saves.resolve(base))) {
            return base;
        }
        for (int i = 2; i < 1000; i++) {
            String candidate = base + " (" + i + ")";
            if (!Files.exists(saves.resolve(candidate))) {
                return candidate;
            }
        }
        return base + "-" + System.currentTimeMillis();
    }

    /// 实例名会直接变成目录名，去掉 Windows 不允许的字符
    private static String sanitizeName(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned)) {
            cleaned = "未命名";
        }
        if (cleaned.length() <= 96) {
            return cleaned;
        }
        // 截断要切主名、留扩展名。CurseForge 的文件名经常六七十个字符，
        // 直接按长度切会把 `.jar` 切掉，放进 mods 游戏不认。
        int dot = cleaned.lastIndexOf('.');
        if (dot > 0 && cleaned.length() - dot <= 8) {
            String ext = cleaned.substring(dot);
            return cleaned.substring(0, 96 - ext.length()) + ext;
        }
        return cleaned.substring(0, 96);
    }

    private static String safeFileName(String fileName, String fallback) {
        String name = Path.of(fileName).getFileName().toString();
        if (name.isBlank()) {
            name = sanitizeName(fallback) + ".jar";
        }
        return sanitizeName(name);
    }

    private static String stripExtension(String fileName) {
        int dot = fileName.lastIndexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    private static void deleteQuietly(@Nullable Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
        }
    }

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        try (var walk = Files.walk(path)) {
            for (Path p : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(p);
            }
        }
    }
}
