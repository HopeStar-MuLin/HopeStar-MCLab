import io

p = 'E:/MCLab/HMCL/HMCL/src/main/java/org/jackhuang/hmcl/ui/web/AddonService.java'
s = io.open(p, encoding='utf-8').read()

# ------------------------------------------------------------------ 1. 常量与类型

old = """    private static final int PAGE_SIZE = 20;"""

new = """    private static final int PAGE_SIZE = 20;

    /// Modrinth 的 HTTP API。**不走 `RemoteAddonRepository`**，原因见 `fetchSearch` 的注释。
    private static final String API = "https://api.modrinth.com/v2";

    /// 一个可下载的版本。从 Modrinth 的 JSON 直接解出来，不经过 HMCL 的
    /// `RemoteAddon.Version`——那套要走 `RemoteAddonRepository`，会把整个项目的
    /// 全部版本拉下来（Fabric API 有 1217 个，1MB），再在本地过滤。
    private record AddonVersion(String versionId, String name, String number, String type,
                                String date, String fileUrl, String filename) {
    }"""

assert old in s
s = s.replace(old, new, 1)


# ------------------------------------------------------------------ 2. search 改直连

old_search = """        Task.runAsync(() -> {
            try {
                DownloadProvider provider = DownloadProviders.getDownloadProvider();
                RemoteAddonRepository repo = RemoteAddon.Source.MODRINTH.getRepository();
                RemoteAddonRepository.SortType sortType = parseSort(sort);

                RemoteAddonRepository.SearchResult result = repo.search(
                        provider, addonType,
                        gameVersion == null || gameVersion.isBlank() ? "" : gameVersion,
                        null, Math.max(0, page), PAGE_SIZE,
                        query == null ? "" : query,
                        sortType, RemoteAddonRepository.SortOrder.DESC);

                List<RemoteAddon> items = result.results().toList();
                pushSearch(type, items, null,
                        new int[]{Math.max(0, page), result.totalPages()});
            } catch (Exception e) {
                LOG.warning("Addon search failed: " + type + " / " + query, e);
                pushSearch(type, null, e, null);
            }
        }).start();
    }"""

new_search = """        Task.runAsync(() -> {
            long started = System.currentTimeMillis();
            try {
                JsonObject root = fetchSearch(addonType, gameVersion, query, page, sort);
                int totalHits = root.has("total_hits") ? root.get("total_hits").getAsInt() : 0;
                int totalPages = totalHits <= 0 ? 0 : (int) Math.ceil((double) totalHits / PAGE_SIZE);
                LOG.info("[addon] search " + type + " q=" + query + " page=" + page
                        + " hits=" + totalHits + " in " + (System.currentTimeMillis() - started) + "ms");
                pushSearchJson(type, root.getAsJsonArray("hits"), null,
                        Math.max(0, page), totalPages);
            } catch (Exception e) {
                LOG.warning("Addon search failed: " + type + " / " + query, e);
                pushSearchJson(type, null, e, Math.max(0, page), 0);
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
    private static JsonObject fetchSearch(RemoteAddon.Type type, @Nullable String gameVersion,
                                          @Nullable String query, int page, @Nullable String sort) throws IOException {
        String projectType = switch (type) {
            case MOD -> "mod";
            case MODPACK -> "modpack";
            case RESOURCE_PACK -> "resourcepack";
            case SHADER_PACK -> "shader";
            default -> null;
        };
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

        String url = API + "/search"
                + "?limit=" + PAGE_SIZE
                + "&offset=" + (Math.max(0, page) * PAGE_SIZE)
                + "&index=" + sortIndex(sort)
                + "&query=" + enc(query == null ? "" : query)
                + "&facets=" + enc(facets.toString());

        return HttpRequest.GET(url).getJson(JsonObject.class);
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
    }"""

assert old_search in s
s = s.replace(old_search, new_search, 1)


# ------------------------------------------------------------------ 3. pushSearch 改成吃 hits

old_push = """    private void pushSearch(String type, @Nullable List<RemoteAddon> items, @Nullable Exception error, @Nullable int[] paging) {
        JsonObject root = new JsonObject();
        root.addProperty("type", type);
        root.addProperty("page", paging == null ? 0 : paging[0]);
        root.addProperty("totalPages", paging == null ? 0 : paging[1]);

        if (error != null) {
            root.addProperty("error", error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
            root.add("items", new JsonArray());
        } else {
            JsonArray array = new JsonArray();
            for (RemoteAddon addon : items) {
                JsonObject o = new JsonObject();
                // slug 同时是 Modrinth 的项目 id：/v2/project/{slug}/version 两种都能用
                o.addProperty("slug", addon.slug());
                o.addProperty("title", addon.title());
                o.addProperty("description", addon.description());
                o.addProperty("author", addon.author());
                o.addProperty("iconUrl", addon.iconUrl());
                o.addProperty("pageUrl", addon.pageUrl());
                JsonArray cats = new JsonArray();
                if (addon.categories() != null) {
                    // 全带上：Modrinth 的 categories 里既有内容分类（库 / 优化）
                    // 也有加载器（Fabric / Forge），HMCL 的卡片就是这么显示的
                    addon.categories().stream().limit(8).forEach(cats::add);
                }
                o.add("categories", cats);
                array.add(o);
            }
            root.add("items", array);
        }"""

new_push = """    private void pushSearchJson(String type, @Nullable JsonArray hits, @Nullable Exception error,
                                int page, int totalPages) {
        JsonObject root = new JsonObject();
        root.addProperty("type", type);
        root.addProperty("page", page);
        root.addProperty("totalPages", totalPages);

        if (error != null) {
            root.addProperty("error", error.getMessage() == null
                    ? error.getClass().getSimpleName() : error.getMessage());
            root.add("items", new JsonArray());
        } else {
            JsonArray array = new JsonArray();
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
                    o.addProperty("iconUrl", optString(hit, "icon_url"));
                    o.addProperty("pageUrl", optString(hit, "project_url"));
                    JsonArray cats = new JsonArray();
                    if (hit.has("display_categories") && hit.get("display_categories").isJsonArray()) {
                        // display_categories 里既有内容分类（库 / 优化）也有加载器
                        // （Fabric / Forge），HMCL 的卡片就是全列出来的
                        JsonArray raw = hit.getAsJsonArray("display_categories");
                        for (int i = 0; i < raw.size() && i < 8; i++) {
                            cats.add(raw.get(i).getAsString());
                        }
                    }
                    o.add("categories", cats);
                    array.add(o);
                }
            }
            root.add("items", array);
        }"""

assert old_push in s
s = s.replace(old_push, new_push, 1)


# ------------------------------------------------------------------ 4. versions 改直连 + 服务端过滤

old_versions = """        Task.runAsync(() -> {
            try {
                DownloadProvider provider = DownloadProviders.getDownloadProvider();
                RemoteAddonRepository repo = RemoteAddon.Source.MODRINTH.getRepository();

                List<RemoteAddon.Version> all = repo.getRemoteVersionsById(provider, slug).toList();
                LOG.info("[addon] versions " + slug + " total=" + all.size()
                        + " gv=" + gameVersion + " loader=" + loader);
                List<RemoteAddon.Version> filtered = new ArrayList<>();
                for (RemoteAddon.Version v : all) {
                    if (!matchesGameVersion(v, gameVersion)) {
                        continue;
                    }
                    if (!matchesLoader(v, loader)) {
                        continue;
                    }
                    filtered.add(v);
                }
                // 新的在前。Modrinth 返回的顺序不保证，自己排一次
                filtered.sort(Comparator.comparing(RemoteAddon.Version::datePublished).reversed());

                LOG.info("[addon] versions " + slug + " filtered=" + filtered.size());
                pushVersions(type, slug, filtered, null);
            } catch (Throwable e) {
                // Throwable：这里出过 Error（不是 Exception）被静默吞掉的情况，
                // 前端就会永远停在「正在拉取版本…」
                LOG.warning("Failed to load versions of " + slug, e);
                pushVersions(type, slug, null, e instanceof Exception ex ? ex : new Exception(String.valueOf(e)));
            }
        }).start();
    }"""

new_versions = """        Task.runAsync(() -> {
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

    /// 拉版本列表，**过滤交给服务端做**。
    ///
    /// `GET /v2/project/{slug}/version` 支持 `game_versions` 和 `loaders` 两个查询参数。
    /// 之前是先拉全量再本地过滤：Fabric API 有 1217 个版本、1MB JSON、5 秒；
    /// 带上参数之后只剩 21 条、25KB、2.8 秒。
    private static List<AddonVersion> fetchVersions(String slug, @Nullable String gameVersion,
                                                    @Nullable String loader) throws IOException {
        StringBuilder url = new StringBuilder(API + "/project/" + enc(slug) + "/version");
        List<String> params = new ArrayList<>();
        if (gameVersion != null && !gameVersion.isBlank()) {
            params.add("game_versions=" + enc("[\"" + gameVersion + "\"]"));
        }
        if (loader != null && !loader.isBlank() && !"vanilla".equalsIgnoreCase(loader)) {
            params.add("loaders=" + enc("[\"" + loader + "\"]"));
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

            out.add(new AddonVersion(
                    optString(v, "id"),
                    optString(v, "name"),
                    optString(v, "version_number"),
                    optString(v, "version_type"),
                    optString(v, "date_published"),
                    fileUrl,
                    filename));
        }
        // 新的在前。API 的默认顺序不保证
        out.sort(Comparator.comparing(AddonVersion::date).reversed());
        return out;
    }"""

assert old_versions in s
s = s.replace(old_versions, new_versions, 1)


# ------------------------------------------------------------------ 5. pushVersions 签名

old_pv = """    private void pushVersions(String type, String slug, @Nullable List<RemoteAddon.Version> items, @Nullable Exception error) {"""

new_pv = """    private void pushVersions(String type, String slug, @Nullable List<AddonVersion> items, @Nullable Exception error) {"""

assert old_pv in s
s = s.replace(old_pv, new_pv, 1)

old_pv_body = """            JsonArray array = new JsonArray();
            for (RemoteAddon.Version v : items) {
                JsonObject o = new JsonObject();
                o.addProperty("versionId", v.versionId());
                o.addProperty("name", v.name());
                o.addProperty("version", v.version());
                o.addProperty("type", v.versionType() == null ? "release" : v.versionType().name().toLowerCase(Locale.ROOT));
                o.addProperty("date", v.datePublished() == null ? "" : v.datePublished().toString());
                o.addProperty("filename", v.file() == null ? "" : v.file().filename());
                JsonArray loaders = new JsonArray();
                if (v.loaders() != null) {
                    v.loaders().stream()
                            .map(AddonLoader::name)
                            .filter(n -> n != null)
                            .distinct().limit(4)
                            .forEach(loaders::add);
                }
                o.add("loaders", loaders);
                array.add(o);
            }
            root.add("items", array);"""

new_pv_body = """            JsonArray array = new JsonArray();
            for (AddonVersion v : items) {
                JsonObject o = new JsonObject();
                o.addProperty("versionId", v.versionId());
                o.addProperty("name", v.name());
                o.addProperty("version", v.number());
                o.addProperty("type", v.type() == null || v.type().isBlank() ? "release" : v.type());
                o.addProperty("date", v.date());
                o.addProperty("filename", v.filename());
                o.add("loaders", new JsonArray());
                array.add(o);
            }
            root.add("items", array);"""

assert old_pv_body in s
s = s.replace(old_pv_body, new_pv_body, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('part 1 ok')
