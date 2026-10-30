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
import java.util.List;
import java.util.Locale;
import java.util.Map;
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

    AddonService(Consumer<String> push) {
        this.push = push;
    }

    // ==================== 搜索 ====================

    /// `reqId` 是前端发来的请求序号，只做原样回传。
    /// 类别是芯片，用户常常连点两下：两个请求同时在路上，谁先回来不一定，
    /// 后回来的那个会把新结果盖成旧结果。前端拿 reqId 一比就能丢掉过期响应。
    void search(String type, String gameVersion, String query, int page, String sort, String loader,
                @Nullable String category, @Nullable String reqId) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null) {
            pushSearchJson(type, reqId, null, new IllegalArgumentException("不支持的资源类型：" + type), 0, 0);
            return;
        }
        // Modrinth 没有 world（只有 mod / modpack / resourcepack / shader /
        // minecraft_java_server），世界全部在 CurseForge，classId=17
        if (addonType == RemoteAddon.Type.WORLD) {
            searchCurseForgeWorld(gameVersion, query, page, sort, category, reqId);
            return;
        }

        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                JsonObject root = fetchSearch(addonType, gameVersion, query, page, sort, loader, category);
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

    /// 拉 `GET /v2/tag/category`，按当前资源类型筛出来，再按接口给的 `header`
    /// 分组推给前端。
    ///
    /// 分类**不做本地硬编码**：Modrinth 会加新类别（`adventure` / `quests` 都是后加的），
    /// 写死一份表就会永远缺。接口返回的 `name` 字段本身就是 slug，`header` 是
    /// 它建议的分组（`categories` / `features` / `resolutions` / `performance impact`），
    /// 前端只负责把 slug 翻成中文。
    void categories(String type) {
        RemoteAddon.Type addonType = parseType(type);
        if (addonType == null) {
            pushCategories(type, new JsonArray(), null);
            return;
        }
        if (addonType == RemoteAddon.Type.WORLD) {
            pushCurseForgeWorldCategories();
            return;
        }

        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                JsonArray groups = buildCategoryGroups(addonType);
                LOG.info("[addon] categories " + type + " → " + groups.size() + " 组，用时 "
                        + (System.currentTimeMillis() - started) + "ms");
                pushCategories(type, groups, null);
            } catch (Exception e) {
                LOG.warning("Failed to load categories of " + type, e);
                pushCategories(type, new JsonArray(), e);
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

        JsonArray out = new JsonArray();
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

    private void pushCategories(String type, JsonArray groups, @Nullable Exception error) {
        JsonObject root = new JsonObject();
        root.addProperty("type", type);
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

    /// 世界分类（/v1/categories?classId=17，就二十来个）。
    /// 缓存 6 小时——每次开页面都拉一遍纯属浪费，而且它几乎不变。
    private static volatile Map<Integer, String> cfWorldCategoryCache;
    private static volatile long cfWorldCategoryAt;

    private static Map<Integer, String> cfWorldCategories() {
        Map<Integer, String> cached = cfWorldCategoryCache;
        if (cached != null && System.currentTimeMillis() - cfWorldCategoryAt < 6 * 3600_000L) {
            return cached;
        }
        try {
            JsonObject root = cfGet("/v1/categories?gameId=432&classId=" + CF_CLASS_WORLD);
            Map<Integer, String> map = new java.util.LinkedHashMap<>();
            if (root.has("data") && root.get("data").isJsonArray()) {
                for (JsonElement e : root.getAsJsonArray("data")) {
                    if (e.isJsonObject()) {
                        JsonObject c = e.getAsJsonObject();
                        map.put(intValue(c, "id"), optString(c, "name"));
                    }
                }
            }
            cfWorldCategoryCache = map;
            cfWorldCategoryAt = System.currentTimeMillis();
            return map;
        } catch (Exception e) {
            LOG.warning("Failed to load CurseForge world categories", e);
            return cached != null ? cached : Map.of();
        }
    }

    private void pushCurseForgeWorldCategories() {
        Task.runAsync(() -> {
            try {
                JsonArray items = new JsonArray();
                cfWorldCategories().forEach((id, name) -> {
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
                pushCategories("world", groups, null);
            } catch (Exception e) {
                pushCategories("world", new JsonArray(), e);
            }
        }).start();
    }

    private void searchCurseForgeWorld(String gameVersion, String query, int page,
                                       @Nullable String sort, @Nullable String category,
                                       @Nullable String reqId) {
        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                StringBuilder path = new StringBuilder("/v1/mods/search?gameId=432&classId=" + CF_CLASS_WORLD);
                path.append("&index=").append(Math.max(0, page) * PAGE_SIZE);
                path.append("&pageSize=").append(PAGE_SIZE);
                path.append("&sortField=").append(cfSortField(sort));
                path.append("&sortOrder=desc");
                if (query != null && !query.isBlank()) {
                    path.append("&searchFilter=").append(enc(query));
                }
                if (gameVersion != null && !gameVersion.isBlank()) {
                    path.append("&gameVersion=").append(enc(gameVersion));
                }
                // 类别是多选，CF 只吃一个 categoryId。取第一个就够了，
                // 世界的类别本来就粗（生存 / 跑酷 / 解谜 / 建筑…）
                if (category != null) {
                    for (String part : category.split(",")) {
                        String id = part.trim();
                        if (id.matches("\\d+")) {
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

                Map<Integer, String> catNames = cfWorldCategories();
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
                            String name = catNames.get(intValue(ce.getAsJsonObject(), "id"));
                            if (name != null) {
                                cats.add(name);
                            }
                        }
                    }
                    o.add("categories", cats);
                    hits.add(o);
                }

                LOG.info("[addon] search world q=" + query + " page=" + page
                        + " hits=" + total + " in " + (System.currentTimeMillis() - started) + "ms");
                pushSearchJson("world", reqId, hits, null, Math.max(0, page), totalPages);
            } catch (Exception e) {
                LOG.warning("CurseForge world search failed", e);
                pushSearchJson("world", reqId, null, e, Math.max(0, page), 0);
            }
        }).start();
    }

    /// 世界的「版本」就是这个项目挂着的若干 zip。
    private static List<AddonVersion> cfWorldFiles(String projectId) throws IOException {
        JsonObject root = cfGet("/v1/mods/" + enc(projectId) + "/files?pageSize=50");
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
                    List.of(),
                    stringList(f, "gameVersions"),
                    url,
                    name,
                    longValue(f, "fileLength"),
                    0));
        }
        return out;
    }

    /// CurseForge 的 CDN 直链规则：files/{id/1000}/{id%1000}/{文件名}。
    /// 少数文件 API 不给 downloadUrl（作者关掉了第三方分发），只能按这个拼。
    private static String cfCdnUrl(int fileId, String fileName) {
        return "https://edge.forgecdn.net/files/" + (fileId / 1000) + "/" + (fileId % 1000) + "/" + enc(fileName);
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

                DownloadProvider provider = DownloadProviders.getDownloadProvider();
                FileDownloadTask download = buildDownload(provider, url, tmp);
                // 用户在确认弹窗里挑过位置就用它；没挑就落到实例的 saves
                Path saves = directory != null && !directory.isBlank() ? Path.of(directory) : null;
                runWithProgress(download, taskId, () -> {
                    try {
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

        // 世界：slug 是 CurseForge 的项目数字 id，一个项目下挂着若干 zip
        if (addonType == RemoteAddon.Type.WORLD) {
            Task.runAsync(() -> {
                try {
                    List<AddonVersion> items = cfWorldFiles(slug);
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
                List<AddonVersion> items = fetchVersions(slug, gameVersion, loader);
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

                // 已经知道具体版本了，直接查 /v2/version/{id}（一个对象，几十 KB），
                // 不用再拉整个项目的版本列表
                AddonVersion version = fetchVersionById(slug, versionId);

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

                FileDownloadTask download = buildDownload(provider, version.fileUrl(), target);
                runWithProgress(download, taskId, () -> {
                    try {
                        verifyArchive(target);
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

                AddonVersion version = fetchVersionById(slug, versionId);

                temp = Files.createTempFile("hmcl-modpack-", ".zip");
                pushStage(taskId, "正在下载整合包 " + version.number() + "…", false, null, -1);

                FileDownloadTask download = buildDownload(provider, version.fileUrl(), temp);
                final Path archive = temp;

                // 只挂进度，不收尾：下载只是第一步，装完才算完成。
                // 直接 runWithProgress 的话，下载一结束就会推 done=true。
                AtomicReference<Throwable> downloadError = attachProgress(download, taskId);
                download.onDone().register(event -> {
                    if (event.isFailed()) {
                        Throwable cause = downloadError.get();
                        pushStage(taskId, "下载整合包失败：" + (cause != null ? cause : "未知错误"),
                                true, String.valueOf(cause), -1);
                        deleteQuietly(archive);
                        return;
                    }
                    Task.runAsync(() -> installModpackArchive(archive, iconUrl, preferredName, taskId, true)).start();
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

        Task.runAsync(() -> {
            try {
                if ("modpack".equals(kind)) {
                    installModpackArchive(file, null, preferredName, taskId);
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
                if (deleteSource) {
                    deleteQuietly(file);
                }
            }
        }).start();
    }

    private void installModpackArchive(Path archive, @Nullable String iconUrl,
                                       @Nullable String preferredName, String taskId) {
        installModpackArchive(archive, iconUrl, preferredName, taskId, false);
    }

    /// @param tempDownload 这个包是不是刚下到临时目录的（是的话装完删掉）。
    ///                     用户从磁盘选的文件传 false —— 删了就是事故。
    private void installModpackArchive(Path archive, @Nullable String iconUrl,
                                       @Nullable String preferredName, String taskId,
                                       boolean tempDownload) {
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
            // 只删「下载到临时目录」的那份；用户自己选的文件动都不动
            if (tempDownload) {
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

    /// 跑任务并把进度接到前端。和 `DownloadService.runWithProgress` 同一套逻辑，
    /// 单独留一份是为了两个 service 互不依赖。
    /// 只把子任务的名字和进度接到前端，不管收尾。
    ///
    /// 返回一个容器装「失败原因」：`TaskExecutor.getException()` 在部分失败路径上
    /// 是 null（比如 FileDownloadTask 内部捕获后只置了 failed 标记），
    /// 只有 `TaskListener.onFailed` 能稳定拿到 throwable。
    private AtomicReference<Throwable> attachProgress(Task<?> task, String taskId) {
        AtomicReference<Throwable> lastError = new AtomicReference<>();
        TaskExecutor executor = task.executor();
        executor.addTaskListener(new TaskListener() {
            @Override
            public void onFailed(Task<?> sub, Throwable throwable) {
                lastError.compareAndSet(null, throwable);
            }

            @Override
            public void onRunning(Task<?> sub) {
                String stage = shortStage(sub.getName());
                if (!stage.isEmpty()) {
                    pushStage(taskId, stage, false, null, -1);
                }
                try {
                    sub.progressProperty().addListener((obs, oldValue, newValue) -> {
                        double p = newValue.doubleValue();
                        if (p >= 0 && p <= 1) {
                            pushStage(taskId, stage, false, null, p);
                        }
                    });
                } catch (Exception ignored) {
                    // 挂不上进度不影响下载本身
                }
            }
        });
        return lastError;
    }

    private void runWithProgress(Task<?> task, String taskId, Runnable onSuccess) {
        AtomicReference<Throwable> lastError = attachProgress(task, taskId);

        task.onDone().register(event -> Platform.runLater(() -> {
            if (event.isFailed()) {
                Throwable cause = lastError.get();
                pushStage(taskId, "失败：" + (cause != null ? cause : "未知错误"),
                        true, String.valueOf(cause), -1);
                return;
            }
            if (onSuccess != null) {
                try {
                    onSuccess.run();
                } catch (Exception e) {
                    // 下载任务本身报成功，但产物不对（镜像返回 200 + 错误页）。
                    // 这种情况不能算完成，要把文件删掉并如实报错。
                    pushStage(taskId, "失败：" + e.getMessage(), true, String.valueOf(e), -1);
                    return;
                }
            }
            pushStage(taskId, "完成", true, null, 1);
        }));

        task.executor().start();
    }

    /// 失败任务的 name 常常是整段堆栈，直接推给前端会在进度条上刷出一屏
    /// `org.jackhuang.hmcl...`。只取第一行，再限长。
    private static String shortStage(@Nullable String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.strip();
        int newline = text.indexOf('\n');
        if (newline > 0) {
            text = text.substring(0, newline).strip();
        }
        if (text.length() > 140) {
            text = text.substring(0, 140) + "…";
        }
        return text;
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


    private void pushStage(String id, String stage, boolean done, @Nullable String error, double percent) {
        JsonObject json = new JsonObject();
        json.addProperty("id", id);
        json.addProperty("stage", stage);
        json.addProperty("done", done);
        json.addProperty("error", error);
        json.addProperty("kind", "install");
        json.addProperty("percent", percent);
        LOG.info("[addon] " + (id == null ? "-" : id) + " | " + stage
                + (percent >= 0 ? " | " + Math.round(percent * 100) + "%" : "")
                + (done ? " | done" : "") + (error != null ? " | " + error : ""));
        String text = JsonUtils.GSON.toJson(json);
        Platform.runLater(() -> push.accept("window.__hmcl && window.__hmcl.onInstallStage("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    @Nullable
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
        return cleaned.length() > 64 ? cleaned.substring(0, 64) : cleaned;
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
