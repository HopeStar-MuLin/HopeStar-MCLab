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
import com.google.gson.JsonObject;
import javafx.application.Platform;
import org.jackhuang.hmcl.task.Task;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jetbrains.annotations.NotNullByDefault;
import org.jetbrains.annotations.Nullable;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 主页动态（Mojang 启动器内容接口）与正文阅读。
///
/// <p>从 [WebBridge] 拆出来的第二块：只有 HTTP + 两处 `onNews` 推送。
@NotNullByDefault
public final class NewsApi {

    private static final String PATCH_NOTES_URL = "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
    private static final String CONTENT_BASE = "https://launchercontent.mojang.com";
    /// 新闻点击跳这里。contentPath 是给启动器自己解析用的 .json，
    /// 不是给人看的页面，别拿它当链接。
    private static final String MINECRAFT_ARTICLE_BASE = "https://www.minecraft.net/zh-hans/article/";

    private final BridgeHost host;

    private volatile String newsJson;
    private volatile boolean newsLoading;

    NewsApi(BridgeHost host) {
        this.host = host;
    }

    private void pushNews(String json) {
        host.execute("window.__hmcl && window.__hmcl.onNews(" + JsonUtils.GSON.toJson(json) + ")");
    }

    // ==================== 动态（Mojang 官方更新日志） ====================

    public void requestNews() {
        if (newsJson != null) {
            pushNews(newsJson);
            return;
        }
        if (newsLoading) {
            return;
        }
        newsLoading = true;

        Task.runAsync(() -> {
            String json;
            try {
                json = fetchPatchNotes();
                // 只缓存成功结果：失败时不写缓存，下次进主页会重试。
                // 否则国内网络一次超时，这个启动器就永远显示「动态加载失败」。
                newsJson = json;
            } catch (Exception e) {
                LOG.warning("Failed to fetch patch notes", e);
                JsonObject error = new JsonObject();
                error.addProperty("error", e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName());
                json = JsonUtils.GSON.toJson(error);
            }
            newsLoading = false;
            String payload = json;
            Platform.runLater(() -> pushNews(payload));
        }).start();
    }

    private static String fetchPatchNotes() throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(PATCH_NOTES_URL))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", "HMCL-WebUI")
                .GET()
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new IOException("HTTP " + response.statusCode());
        }
        JsonObject root = JsonUtils.fromNonNullJson(response.body(), JsonObject.class);
        JsonArray entries = root.getAsJsonArray("entries");
        if (entries == null) {
            throw new IOException("empty entries");
        }

        JsonArray items = new JsonArray();
        int count = 0;
        for (var element : entries) {
            if (count++ >= 8) {
                break;
            }
            JsonObject entry = element.getAsJsonObject();
            JsonObject item = new JsonObject();
            item.addProperty("title", optString(entry, "title"));
            item.addProperty("summary", optString(entry, "shortText"));
            item.addProperty("date", optString(entry, "date"));
            String contentPath = optString(entry, "contentPath");

            // 官方 JSON 里没有网页地址，contentPath 指回 launchercontent 的 .json 文件。
            // 直接把它给浏览器，用户看到的就是一屏 JSON——这不是「新闻页面」。
            // 用 id 拼 minecraft.net 的文章地址：快照 id 形如 26-4-snapshot-6，
            // 官网 slug 是 minecraft-26-4-snapshot-6。
            String id = optString(entry, "id");
            String slug = id;
            if (!slug.isEmpty() && !slug.startsWith("minecraft-")) {
                slug = "minecraft-" + slug;
            }
            String articleUrl;
            if (!slug.isEmpty()) {
                articleUrl = MINECRAFT_ARTICLE_BASE + slug;
            } else if (!contentPath.isEmpty()) {
                articleUrl = MINECRAFT_ARTICLE_BASE + contentPath.replaceAll("\\.json$", "");
            } else {
                articleUrl = MINECRAFT_ARTICLE_BASE;
            }
            item.addProperty("url", articleUrl);
            // 正文（HTML）在 `https://launchercontent.mojang.com/v2/` + contentPath
            item.addProperty("contentPath", contentPath);
            item.addProperty("type", optString(entry, "type"));

            JsonObject image = entry.getAsJsonObject("image");
            if (image != null && image.has("url")) {
                item.addProperty("image", CONTENT_BASE + image.get("url").getAsString());
            }
            items.add(item);
        }

        JsonObject result = new JsonObject();
        result.add("items", items);
        return JsonUtils.GSON.toJson(result);
    }

    /// Mojang 的正文都在 `v2/` 下，contentPath 是相对路径（`javaPatchNotes/xxx.json`）。
    private static final String NEWS_CONTENT_BASE = "https://launchercontent.mojang.com/v2/";

    private final Map<String, String> newsDetailCache = new ConcurrentHashMap<>();

    /// 打开一条动态的正文。抓回来的是 HTML 片段，清洗交给前端做（那边有 DOM）。
    public void openNews(String contentPath) {
        if (contentPath == null || contentPath.isBlank()) {
            return;
        }
        String cached = newsDetailCache.get(contentPath);
        if (cached != null) {
            pushNewsDetail(cached, null);
            return;
        }

        pushNewsDetail(null, "loading");
        Task.runAsync(() -> {
            try {
                String json = fetchNewsDetail(contentPath);
                if (newsDetailCache.size() > 30) {
                    newsDetailCache.clear();
                }
                newsDetailCache.put(contentPath, json);
                Platform.runLater(() -> pushNewsDetail(json, null));
            } catch (Exception e) {
                LOG.warning("Failed to fetch news detail " + contentPath, e);
                String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                Platform.runLater(() -> pushNewsDetail(null, msg));
            }
        }).start();
    }

    private static String fetchNewsDetail(String contentPath) throws Exception {
        String path = contentPath.startsWith("/") ? contentPath.substring(1) : contentPath;
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .followRedirects(HttpClient.Redirect.NORMAL)
                .build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(NEWS_CONTENT_BASE + path))
                .timeout(Duration.ofSeconds(15))
                .header("User-Agent", "HMCL-WebUI")
                .GET()
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() / 100 != 2) {
            throw new IOException("HTTP " + response.statusCode());
        }

        JsonObject root = JsonUtils.fromNonNullJson(response.body(), JsonObject.class);
        String body = optString(root, "body");

        // 正文里的图片是站内相对路径，补成绝对地址，否则在壳里就是一片裂图
        body = body.replace("src=\"/", "src=\"https://launchercontent.mojang.com/");

        JsonObject out = new JsonObject();
        out.addProperty("title", optString(root, "title"));
        out.addProperty("version", optString(root, "version"));
        out.addProperty("type", optString(root, "type"));
        out.addProperty("body", body);
        JsonObject image = root.getAsJsonObject("image");
        if (image != null && image.has("url")) {
            out.addProperty("image", CONTENT_BASE + image.get("url").getAsString());
        }
        return JsonUtils.GSON.toJson(out);
    }

    private void pushNewsDetail(@Nullable String json, @Nullable String error) {
        JsonObject root = new JsonObject();
        if (error != null) {
            root.addProperty("loading", "loading".equals(error));
            root.addProperty("error", "loading".equals(error) ? "" : error);
        }
        if (json != null) {
            root.add("detail", JsonUtils.fromNonNullJson(json, JsonObject.class));
        }
        host.execute("window.__hmcl && window.__hmcl.onNewsDetail("
                + JsonUtils.GSON.toJson(JsonUtils.GSON.toJson(root)) + ")");
    }

    private static String optString(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
    }
}
