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

import org.jackhuang.hmcl.Metadata;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 下载页图标的磁盘缓存。
///
/// <p>Modrinth 的图标放在 `cdn.modrinth.com`，国内经常连不上，而公共图片代理
/// （wsrv.nl）能取到。但走代理每次都要重新拉一遍，翻页来回就重复请求。
/// 这里在本地存一份，**一次成功之后永久可用**。
///
/// <p>占用控制（这是设计要求，缓存不能越用越大）：
/// <ul>
///   <li>单个文件上限 256KB —— 图标正常几十 KB，超过的不缓存</li>
///   <li>总量上限 12MB，超过就按最后访问时间删最旧的，直到降到 75%</li>
///   <li>条目数上限 800，同上</li>
///   <li>启动时扫一次目录，之后在内存里维护计数，不用每次 stat</li>
/// </ul>
/// 按 20KB 一个图标估算，12MB 大约能放 600 个，正常翻几十页的项目也用不完。
final class IconCache {

    private static final Path DIR = Metadata.HMCL_USER_HOME.resolve("web-icons");

    private static final long MAX_TOTAL_BYTES = 12L * 1024 * 1024;
    private static final long MAX_FILE_BYTES = 256 * 1024;
    private static final int MAX_FILES = 800;

    /// 一次 HTTP 读的上限，防止代理返回一个大文件把内存吃了
    private static final int READ_LIMIT = (int) MAX_FILE_BYTES + 1024;

    /// 单个请求的超时。cdn.modrinth.com 在国内是「连得上但不回包」的状态，
    /// 超时设长了每个图标都要白等；3.5 秒足够判断，之后换代理。
    private static final int TIMEOUT_MS = 3500;

    /// 直连失败过一次之后，后续直接走代理——不然每个图标都要先等 6 秒超时
    private static volatile boolean directFailed = false;

    private static final String[] PROXIES = {
            "https://wsrv.nl/?url=",
            "https://images.weserv.nl/?url="
    };

    private static final IconCache INSTANCE = new IconCache();

    static IconCache getInstance() {
        return INSTANCE;
    }

    private long totalBytes;
    private int fileCount;

    private IconCache() {
        scan();
    }

    /// 启动时统计现有缓存。几百个文件的目录元数据，几十毫秒。
    private void scan() {
        try {
            Files.createDirectories(DIR);
            try (Stream<Path> files = Files.list(DIR)) {
                for (Path file : files.toList()) {
                    if (!Files.isRegularFile(file)) {
                        continue;
                    }
                    fileCount++;
                    totalBytes += Files.size(file);
                }
            }
            LOG.info("[icon-cache] " + fileCount + " 个文件，" + (totalBytes / 1024) + " KB");
            evictIfNeeded();
        } catch (Exception e) {
            LOG.warning("[icon-cache] 扫描缓存目录失败", e);
        }
    }

    /// 读缓存，没有就返回 null。
    byte[] load(String url) {
        Path file = fileOf(url);
        if (!Files.isRegularFile(file)) {
            return null;
        }
        try {
            // 不在这里更新 mtime：每次读都写盘的话，翻一页 20 个图标就是 20 次写。
            // 淘汰按「写入时间」排序，对图标这种一次写多次读的场景够用了。
            return Files.readAllBytes(file);
        } catch (IOException e) {
            return null;
        }
    }

    void save(String url, byte[] data) {
        if (data == null || data.length == 0 || data.length > MAX_FILE_BYTES) {
            return;
        }
        Path file = fileOf(url);
        try {
            Files.createDirectories(DIR);
            Path temp = Files.createTempFile(DIR, "icon-", ".tmp");
            Files.write(temp, data);
            // 先写临时文件再原子替换：避免并发写同一个文件时读到半个
            Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
            totalBytes += data.length;
            fileCount++;
            evictIfNeeded();
        } catch (IOException e) {
            LOG.warning("[icon-cache] 写入失败 " + file, e);
        }
    }

    /// 超限时按最后修改时间删最旧的，降到 75% 就停。
    private void evictIfNeeded() {
        if (totalBytes <= MAX_TOTAL_BYTES && fileCount <= MAX_FILES) {
            return;
        }

        long targetBytes = MAX_TOTAL_BYTES * 3 / 4;
        int targetFiles = MAX_FILES * 3 / 4;

        List<Path> files = new ArrayList<>();
        try (Stream<Path> stream = Files.list(DIR)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".bin"))
                    .forEach(files::add);
        } catch (IOException e) {
            LOG.warning("[icon-cache] 清理时无法列目录", e);
            return;
        }

        files.sort(Comparator.comparingLong(IconCache::lastModified));

        int removed = 0;
        long freed = 0;
        for (Path file : files) {
            if (totalBytes - freed <= targetBytes && fileCount - removed <= targetFiles) {
                break;
            }
            try {
                long size = Files.size(file);
                Files.deleteIfExists(file);
                freed += size;
                removed++;
            } catch (IOException ignored) {
            }
        }

        totalBytes -= freed;
        fileCount -= removed;
        if (removed > 0) {
            LOG.info("[icon-cache] 清理 " + removed + " 个旧图标，释放 " + (freed / 1024)
                    + " KB，现在 " + fileCount + " 个 / " + (totalBytes / 1024) + " KB");
        }
    }

    private static long lastModified(Path file) {
        try {
            return Files.getLastModifiedTime(file).toMillis();
        } catch (IOException e) {
            return 0;
        }
    }

    private static Path fileOf(String url) {
        return DIR.resolve(hash(url) + ".bin");
    }

    private static String hash(String url) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] digest = md.digest(url.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest).substring(0, 32);
        } catch (Exception e) {
            return Integer.toHexString(url.hashCode());
        }
    }

    // ==================== 下载 ====================

    /// 拿图标的字节。缓存 → 直连 → 图片代理。
    byte[] resolve(String url) {
        byte[] cached = load(url);
        if (cached != null) {
            return cached;
        }

        byte[] fetched = fetch(url);
        if (fetched != null) {
            save(url, fetched);
        }
        return fetched;
    }

    private static byte[] fetch(String url) {
        if (!directFailed) {
            byte[] direct = httpGet(url, true);
            if (direct != null) {
                return direct;
            }
            // 记下来：这个网络下 cdn 直连不通，后面的请求直接走代理
            directFailed = true;
            LOG.info("[icon-cache] 直连失败，后续图标改走图片代理");
        }

        String bare = url.replaceFirst("^https?://", "");
        String encoded = URLEncoder.encode(bare, StandardCharsets.UTF_8);
        for (String proxy : PROXIES) {
            byte[] data = httpGet(proxy + encoded, false);
            if (data != null) {
                return data;
            }
        }
        return null;
    }

    /// 请求并读字节。拿到的必须是图片，HTML 错误页（镜像维护时常返回 200 + 网页）要拒掉。
    private static byte[] httpGet(String url, boolean isDirect) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "HMCL-Web/1.0");
            conn.setRequestProperty("Accept", "image/*");

            if (conn.getResponseCode() != 200) {
                return null;
            }

            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int total = 0;
                int read;
                while ((read = in.read(buffer)) > 0) {
                    total += read;
                    if (total > READ_LIMIT) {
                        return null; // 太大，不当图标用
                    }
                    out.write(buffer, 0, read);
                }
                byte[] data = out.toByteArray();
                return looksLikeImage(data) ? data : null;
            }
        } catch (Exception e) {
            if (isDirect) {
                LOG.info("[icon-cache] 直连失败 " + url + " : " + e.getClass().getSimpleName());
            }
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /// 看魔数判断是不是图片。代理和镜像都可能返回 200 + HTML。
    static boolean looksLikeImage(byte[] data) {
        if (data == null || data.length < 12) {
            return false;
        }
        // PNG
        if ((data[0] & 0xFF) == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G') {
            return true;
        }
        // JPEG
        if ((data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) {
            return true;
        }
        // GIF
        if (data[0] == 'G' && data[1] == 'I' && data[2] == 'F') {
            return true;
        }
        // WEBP: RIFF....WEBP
        if (data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F') {
            return true;
        }
        // SVG（有些项目图标是 svg，代理会原样返回）
        if (data[0] == '<') {
            return true;
        }
        return false;
    }

    /// 按魔数给 Content-Type。浏览器不看也能显示，但给了更规范。
    static String contentTypeOf(byte[] data) {
        if (data == null || data.length < 12) {
            return "application/octet-stream";
        }
        if ((data[0] & 0xFF) == 0x89 && data[1] == 'P') {
            return "image/png";
        }
        if ((data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) {
            return "image/jpeg";
        }
        if (data[0] == 'G' && data[1] == 'I') {
            return "image/gif";
        }
        if (data[0] == 'R' && data[1] == 'I') {
            return "image/webp";
        }
        if (data[0] == '<') {
            return "image/svg+xml";
        }
        return "application/octet-stream";
    }
}
