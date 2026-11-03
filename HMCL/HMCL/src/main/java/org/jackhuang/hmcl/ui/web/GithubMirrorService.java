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
import com.google.gson.JsonParser;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// GitHub 文件加速：镜像站列表、测速选优、URL 改写。
///
/// <p>三类调用方共用这一份逻辑：
/// <ul>
///   <li>百宝箱的「GitHub 文件加速」板块（手动选镜像下载）；</li>
///   <li>启动器的检查更新（下载更新包时自动走最优镜像）；</li>
///   <li>壳的 Java 引导下载（只在拿不到镜像时回落到直连）。</li>
/// </ul>
///
/// <p>测速是**并行**的，固定 4 路：镜像站大多在境外，串行测十个光等超时就要一分多钟。
///
/// <p>结果落盘到 `config/github-mirror.json`，下次启动直接用上次的最优，
/// 不用等测完才开始下载。
final class GithubMirrorService {

    /// 测速用的探针。选 octocat/Hello-World 的 master 归档：
    /// 仓库极老、几乎不可能被删，体积只有几百字节，能干净地量出「建连 + 首字节」。
    private static final String PROBE =
            "https://github.com/octocat/Hello-World/archive/refs/heads/master.zip";

    /// 最多取 256 KB 估算吞吐。再大就开始吃带宽，测速本身变成负担。
    private static final int PROBE_BYTES = 256 * 1024;

    private static final Path CONFIG =
            Metadata.HMCL_LOCAL_HOME.resolve("config").resolve("github-mirror.json");

    private static final HttpClient CLIENT = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(8))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    /// 内置镜像。`prefix` 直接拼在原始 GitHub 链接前面：
    /// `https://gh-proxy.com/` + `https://github.com/...`。
    ///
    /// <p>`direct` 永远排第一：所有镜像都挂了的时候，直连是最后的兜底。
    /// 内置镜像。`prefix` 直接拼在原始 GitHub 链接前面。
    ///
    /// <p>列表来源是 moretools 的 GitHub 代理合集（114 个），按「常见站点优先」排序：
    /// 前几个活跃度最高，全量测速时用户能先看到有用的结果，不至于干等两分钟。
    /// 公益站随时会死，测速那一步就是用来筛掉它们的。
    ///
    /// <p>`direct` 永远排第一：所有镜像都挂了的时候，直连是最后的兜底。
    private static final List<Mirror> BUILTIN;

    static {
        // 用静态块逐条 add，而不是 List.of(一百多个参数)：
        // 单行出错时编译器的行号能指到具体某个镜像，不用在长参数列表里数逗号。
        List<Mirror> list = new ArrayList<>();
        list.add(new Mirror("direct", "直连 GitHub", ""));
        list.add(new Mirror("gh-proxy.com", "gh-proxy.com", "https://gh-proxy.com/"));
        list.add(new Mirror("ghproxy.net", "ghproxy.net", "https://ghproxy.net/"));
        list.add(new Mirror("ghfast.top", "ghfast.top", "https://ghfast.top/"));
        list.add(new Mirror("gh.llkk.cc", "gh.llkk.cc", "https://gh.llkk.cc/"));
        list.add(new Mirror("hub.gitmirror.com", "hub.gitmirror.com", "https://hub.gitmirror.com/"));
        list.add(new Mirror("gh-proxy.net", "gh-proxy.net", "https://gh-proxy.net/"));
        list.add(new Mirror("github.cnxiaobai.com", "github.cnxiaobai.com", "https://github.cnxiaobai.com/"));
        list.add(new Mirror("www.5555.cab", "www.5555.cab", "https://www.5555.cab/"));
        list.add(new Mirror("git.tangbai.cc", "git.tangbai.cc", "https://git.tangbai.cc/"));
        list.add(new Mirror("gh.ddlc.top", "gh.ddlc.top", "https://gh.ddlc.top/"));
        list.add(new Mirror("ghproxy.xiaopa.cc", "ghproxy.xiaopa.cc", "https://ghproxy.xiaopa.cc/"));
        list.add(new Mirror("ghproxy.cfd", "ghproxy.cfd", "https://ghproxy.cfd/"));
        list.add(new Mirror("ghproxy.cc", "ghproxy.cc", "https://ghproxy.cc/"));
        list.add(new Mirror("ghproxy.monkeyray.net", "ghproxy.monkeyray.net", "https://ghproxy.monkeyray.net/"));
        list.add(new Mirror("cf.ghproxy.cc", "cf.ghproxy.cc", "https://cf.ghproxy.cc/"));
        list.add(new Mirror("gitproxy.mrhjx.cn", "gitproxy.mrhjx.cn", "https://gitproxy.mrhjx.cn/"));
        list.add(new Mirror("gh.xxooo.cf", "gh.xxooo.cf", "https://gh.xxooo.cf/"));
        list.add(new Mirror("github.xxlab.tech", "github.xxlab.tech", "https://github.xxlab.tech/"));
        list.add(new Mirror("ghproxy.1888866.xyz", "ghproxy.1888866.xyz", "https://ghproxy.1888866.xyz/"));
        list.add(new Mirror("github.mlmle.cn", "github.mlmle.cn", "https://github.mlmle.cn/"));
        list.add(new Mirror("fastgit.cc", "fastgit.cc", "https://fastgit.cc/"));
        list.add(new Mirror("gh.1k.ink", "gh.1k.ink", "https://gh.1k.ink/"));
        list.add(new Mirror("github.boringhex.top", "github.boringhex.top", "https://github.boringhex.top/"));
        list.add(new Mirror("y.whereisdoge.work", "y.whereisdoge.work", "https://y.whereisdoge.work/"));
        list.add(new Mirror("ghproxy.imciel.com", "ghproxy.imciel.com", "https://ghproxy.imciel.com/"));
        list.add(new Mirror("gh.jdck.fun", "gh.jdck.fun", "https://gh.jdck.fun/"));
        list.add(new Mirror("xiaomo-station.top", "xiaomo-station.top", "https://xiaomo-station.top/"));
        list.add(new Mirror("gh.monlor.com", "gh.monlor.com", "https://gh.monlor.com/"));
        list.add(new Mirror("g.blfrp.cn", "g.blfrp.cn", "https://g.blfrp.cn/"));
        list.add(new Mirror("gh.con.sh", "gh.con.sh", "https://gh.con.sh/"));
        list.add(new Mirror("gh.b52m.cn", "gh.b52m.cn", "https://gh.b52m.cn/"));
        list.add(new Mirror("github.dpik.top", "github.dpik.top", "https://github.dpik.top/"));
        list.add(new Mirror("github.geekery.cn", "github.geekery.cn", "https://github.geekery.cn/"));
        list.add(new Mirror("gh.halonice.com", "gh.halonice.com", "https://gh.halonice.com/"));
        list.add(new Mirror("github.limoruirui.com", "github.limoruirui.com", "https://github.limoruirui.com/"));
        list.add(new Mirror("git.yylx.win", "git.yylx.win", "https://git.yylx.win/"));
        list.add(new Mirror("github.tbedu.top", "github.tbedu.top", "https://github.tbedu.top/"));
        list.add(new Mirror("ghproxy.vansour.top", "ghproxy.vansour.top", "https://ghproxy.vansour.top/"));
        list.add(new Mirror("tvv.tw", "tvv.tw", "https://tvv.tw/"));
        list.add(new Mirror("ghproxy.xzhouqd.com", "ghproxy.xzhouqd.com", "https://ghproxy.xzhouqd.com/"));
        list.add(new Mirror("github-proxy.memory-echoes.cn", "github-proxy.memory-echoes.cn", "https://github-proxy.memory-echoes.cn/"));
        list.add(new Mirror("gh.catmak.name", "gh.catmak.name", "https://gh.catmak.name/"));
        list.add(new Mirror("hub.ddayh.com", "hub.ddayh.com", "https://hub.ddayh.com/"));
        list.add(new Mirror("github.ruojian.space", "github.ruojian.space", "https://github.ruojian.space/"));
        list.add(new Mirror("ghproxy.cxkpro.top", "ghproxy.cxkpro.top", "https://ghproxy.cxkpro.top/"));
        list.add(new Mirror("ghp.keleyaa.com", "ghp.keleyaa.com", "https://ghp.keleyaa.com/"));
        list.add(new Mirror("github-proxy.lixxing.top", "github-proxy.lixxing.top", "https://github-proxy.lixxing.top/"));
        list.add(new Mirror("gh.padao.fun", "gh.padao.fun", "https://gh.padao.fun/"));
        list.add(new Mirror("gp.871201.xyz", "gp.871201.xyz", "https://gp.871201.xyz/"));
        list.add(new Mirror("gh.wsmdn.dpdns.org", "gh.wsmdn.dpdns.org", "https://gh.wsmdn.dpdns.org/"));
        list.add(new Mirror("ggg.clwap.dpdns.org", "ggg.clwap.dpdns.org", "https://ggg.clwap.dpdns.org/"));
        list.add(new Mirror("gh.dpik.top", "gh.dpik.top", "https://gh.dpik.top/"));
        list.add(new Mirror("gp.zkitefly.eu.org", "gp.zkitefly.eu.org", "https://gp.zkitefly.eu.org/"));
        list.add(new Mirror("gh.bugdey.us.kg", "gh.bugdey.us.kg", "https://gh.bugdey.us.kg/"));
        list.add(new Mirror("code-hub-hk.freexy.top", "code-hub-hk.freexy.top", "https://code-hub-hk.freexy.top/"));
        list.add(new Mirror("github.chenc.dev", "github.chenc.dev", "https://github.chenc.dev/"));
        list.add(new Mirror("ghfile.geekertao.top", "ghfile.geekertao.top", "https://ghfile.geekertao.top/"));
        list.add(new Mirror("kenyu.ggff.net", "kenyu.ggff.net", "https://kenyu.ggff.net/"));
        list.add(new Mirror("gh.nxnow.top", "gh.nxnow.top", "https://gh.nxnow.top/"));
        list.add(new Mirror("github.bullb.net", "github.bullb.net", "https://github.bullb.net/"));
        list.add(new Mirror("gitproxy.197545.xyz", "gitproxy.197545.xyz", "https://gitproxy.197545.xyz/"));
        list.add(new Mirror("gitproxy.127731.xyz", "gitproxy.127731.xyz", "https://gitproxy.127731.xyz/"));
        list.add(new Mirror("gitproxy1.127731.xyz", "gitproxy1.127731.xyz", "https://gitproxy1.127731.xyz/"));
        list.add(new Mirror("jiashu.1win.eu.org", "jiashu.1win.eu.org", "https://jiashu.1win.eu.org/"));
        list.add(new Mirror("ghproxy.mf-dust.dpdns.org", "ghproxy.mf-dust.dpdns.org", "https://ghproxy.mf-dust.dpdns.org/"));
        list.add(new Mirror("j.1lin.dpdns.org", "j.1lin.dpdns.org", "https://j.1lin.dpdns.org/"));
        list.add(new Mirror("gh.jasonzeng.dev", "gh.jasonzeng.dev", "https://gh.jasonzeng.dev/"));
        list.add(new Mirror("proxy.baguoyuyan.com", "proxy.baguoyuyan.com", "https://proxy.baguoyuyan.com/"));
        list.add(new Mirror("github.1ms.xx.kg", "github.1ms.xx.kg", "https://github.1ms.xx.kg/"));
        list.add(new Mirror("gh.198962.xyz", "gh.198962.xyz", "https://gh.198962.xyz/"));
        list.add(new Mirror("github.880824.xyz", "github.880824.xyz", "https://github.880824.xyz/"));
        list.add(new Mirror("ghps.cc", "ghps.cc", "https://ghps.cc/"));
        list.add(new Mirror("30006000.xyz", "30006000.xyz", "https://30006000.xyz/"));
        list.add(new Mirror("github.tianrld.top", "github.tianrld.top", "https://github.tianrld.top/"));
        list.add(new Mirror("getgit.love8yun.eu.org", "getgit.love8yun.eu.org", "https://getgit.love8yun.eu.org/"));
        list.add(new Mirror("github.788787.xyz", "github.788787.xyz", "https://github.788787.xyz/"));
        list.add(new Mirror("ghm.078465.xyz", "ghm.078465.xyz", "https://ghm.078465.xyz/"));
        list.add(new Mirror("github-proxy.com", "github-proxy.com", "https://github-proxy.com/"));
        list.add(new Mirror("proxy.yaoyaoling.net", "proxy.yaoyaoling.net", "https://proxy.yaoyaoling.net/"));
        list.add(new Mirror("ghproxy.sakuramoe.dev", "ghproxy.sakuramoe.dev", "https://ghproxy.sakuramoe.dev/"));
        list.add(new Mirror("ghproxy.053000.xyz", "ghproxy.053000.xyz", "https://ghproxy.053000.xyz/"));
        list.add(new Mirror("gh.chjina.com", "gh.chjina.com", "https://gh.chjina.com/"));
        list.add(new Mirror("git.zeas.cc", "git.zeas.cc", "https://git.zeas.cc/"));
        list.add(new Mirror("ghpxy.hwinzniej.top", "ghpxy.hwinzniej.top", "https://ghpxy.hwinzniej.top/"));
        list.add(new Mirror("gh.echofree.xyz", "gh.echofree.xyz", "https://gh.echofree.xyz/"));
        list.add(new Mirror("github.zzrbk.xyz", "github.zzrbk.xyz", "https://github.zzrbk.xyz/"));
        list.add(new Mirror("git.669966.xyz", "git.669966.xyz", "https://git.669966.xyz/"));
        list.add(new Mirror("github.ihnic.com", "github.ihnic.com", "https://github.ihnic.com/"));
        list.add(new Mirror("gh.996986.xyz", "gh.996986.xyz", "https://gh.996986.xyz/"));
        list.add(new Mirror("gh.idayer.com", "gh.idayer.com", "https://gh.idayer.com/"));
        list.add(new Mirror("github.ednovas.xyz", "github.ednovas.xyz", "https://github.ednovas.xyz/"));
        list.add(new Mirror("gh.chalin.tk", "gh.chalin.tk", "https://gh.chalin.tk/"));
        list.add(new Mirror("j.1win.ggff.net", "j.1win.ggff.net", "https://j.1win.ggff.net/"));
        list.add(new Mirror("github.lsdfxdk.nyc.mn", "github.lsdfxdk.nyc.mn", "https://github.lsdfxdk.nyc.mn/"));
        list.add(new Mirror("gh.aaa.team", "gh.aaa.team", "https://gh.aaa.team/"));
        list.add(new Mirror("github.crdz.eu.org", "github.crdz.eu.org", "https://github.crdz.eu.org/"));
        list.add(new Mirror("gh.shiina-rimo.cafe", "gh.shiina-rimo.cafe", "https://gh.shiina-rimo.cafe/"));
        list.add(new Mirror("ghproxy.mirror.skybyte.me", "ghproxy.mirror.skybyte.me", "https://ghproxy.mirror.skybyte.me/"));
        list.add(new Mirror("git.40609891.xyz", "git.40609891.xyz", "https://git.40609891.xyz/"));
        list.add(new Mirror("github.oterea.top", "github.oterea.top", "https://github.oterea.top/"));
        list.add(new Mirror("gh.noki.icu", "gh.noki.icu", "https://gh.noki.icu/"));
        list.add(new Mirror("gh.39.al", "gh.39.al", "https://gh.39.al/"));
        list.add(new Mirror("ghproxy.cn", "ghproxy.cn", "https://ghproxy.cn/"));
        list.add(new Mirror("down.npee.cn", "down.npee.cn", "https://down.npee.cn/"));
        list.add(new Mirror("github.kkproxy.dpdns.org", "github.kkproxy.dpdns.org", "https://github.kkproxy.dpdns.org/"));
        list.add(new Mirror("free.cn.eu.org", "free.cn.eu.org", "https://free.cn.eu.org/"));
        list.add(new Mirror("git.951959483.xyz", "git.951959483.xyz", "https://git.951959483.xyz/"));
        list.add(new Mirror("git.820828.xyz", "git.820828.xyz", "https://git.820828.xyz/"));
        list.add(new Mirror("ghproxy.fangkuai.fun", "ghproxy.fangkuai.fun", "https://ghproxy.fangkuai.fun/"));
        list.add(new Mirror("github.cn86.dev", "github.cn86.dev", "https://github.cn86.dev/"));
        list.add(new Mirror("github.zjzzy.cloudns.org", "github.zjzzy.cloudns.org", "https://github.zjzzy.cloudns.org/"));
        list.add(new Mirror("ghb.nilive.top", "ghb.nilive.top", "https://ghb.nilive.top/"));
        list.add(new Mirror("gitproxy.click", "gitproxy.click", "https://gitproxy.click/"));
        list.add(new Mirror("proxy.atoposs.com", "proxy.atoposs.com", "https://proxy.atoposs.com/"));
        BUILTIN = List.copyOf(list);
    }

    /// 一个镜像站。
    record Mirror(String id, String name, String prefix) {
        boolean direct() {
            return prefix == null || prefix.isBlank();
        }
    }

    /// 一次测速的结果。失败时 `error` 里是给人看的一句话。
    record Result(String id, String name, boolean ok, long ttfbMs, long speedKbps, String error) {
        /// 排序用。首字节为主，吞吐为辅：镜像的瓶颈通常在建连和排队，
        /// 真正拉大文件时才会用到带宽。
        long score() {
            if (!ok) {
                return Long.MAX_VALUE;
            }
            long speedPenalty = speedKbps > 0 ? Math.max(0, 800 / speedKbps) : 400;
            return ttfbMs + speedPenalty;
        }
    }

    /// 同一时刻只允许一轮测速在跑。
    private static final java.util.concurrent.atomic.AtomicBoolean RUNNING =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    private GithubMirrorService() {
    }

    // ==================== 列表 ====================

    /// 内置 + 用户在配置里追加的镜像。
    static List<Mirror> all() {
        List<Mirror> out = new ArrayList<>(BUILTIN);
        JsonObject config = readConfig();
        if (config != null && config.has("custom") && config.get("custom").isJsonArray()) {
            for (JsonElement element : config.getAsJsonArray("custom")) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject item = element.getAsJsonObject();
                String id = optString(item, "id");
                String name = optString(item, "name");
                String prefix = optString(item, "prefix");
                if (id.isBlank() || prefix.isBlank()) {
                    continue;
                }
                // 重名就跳过，别让自定义项把内置的顶掉
                boolean exists = out.stream().anyMatch(m -> m.id().equals(id));
                if (!exists) {
                    out.add(new Mirror(id, name.isBlank() ? id : name, prefix));
                }
            }
        }
        return out;
    }

    static Mirror find(String id) {
        if (id == null || id.isBlank()) {
            return null;
        }
        return all().stream().filter(m -> m.id().equals(id)).findFirst().orElse(null);
    }

    // ==================== 改写 ====================

    /// 这个链接能不能加速。只认 GitHub 的几类地址：
    /// release 附件、raw 文件、仓库归档、gist。
    ///
    /// <p>jsDelivr 之类的 CDN 已经自己处理过，再套一层前缀会变成无效链接。
    static boolean canAccelerate(String url) {
        if (url == null || url.isBlank()) {
            return false;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("https://") && !lower.startsWith("http://")) {
            return false;
        }
        return lower.contains("github.com/") || lower.contains("githubusercontent.com/");
    }

    /// 按镜像改写链接。直连或空前缀原样返回。
    static String rewrite(String url, String mirrorId) {
        if (!canAccelerate(url)) {
            return url;
        }
        Mirror mirror = find(mirrorId);
        if (mirror == null || mirror.direct()) {
            return url;
        }
        return mirror.prefix() + url;
    }

    /// 用上次测出来的最优镜像改写。没测过就用直连。
    static String rewriteBest(String url) {
        return rewrite(url, bestId());
    }

    // ==================== 测速 ====================

    /// 测所有镜像。滑动窗口并发：完成一个补一个，不等整批。
    ///
    /// <p>114 个站如果按「一批 4 个等最慢的」来分组，会被几个超时的站反复拖住；
    /// 滑动窗口下总耗时约等于「总数 / 并发 × 平均响应」，快一倍以上。
    ///
    /// @param listener 每测完一个就回调一次，前端可以逐条亮起，不用干等
    static JsonObject test(int parallel, java.util.function.Consumer<Result> listener) {
        // 手动测速和自动测速可能撞上。两个 4 路并发一起跑会把带宽打满，
        // 测出来全是自己的噪声 —— 后来那个直接返回现有结果。
        if (!RUNNING.compareAndSet(false, true)) {
            JsonObject busy = status();
            busy.addProperty("busy", true);
            return busy;
        }
        try {
            return runTest(parallel, listener);
        } finally {
            RUNNING.set(false);
        }
    }

    private static JsonObject runTest(int parallel, java.util.function.Consumer<Result> listener) {
        List<Mirror> mirrors = all();
        int workers = Math.max(2, Math.min(6, parallel <= 0 ? 4 : parallel));
        ExecutorService pool = Executors.newFixedThreadPool(workers, runnable -> {
            Thread thread = new Thread(runnable, "github-mirror-probe");
            thread.setDaemon(true);
            return thread;
        });

        List<Result> results = new ArrayList<>();
        java.util.concurrent.CompletionService<Result> completion =
                new java.util.concurrent.ExecutorCompletionService<>(pool);
        int next = 0;
        try {
            for (int i = 0; i < workers && next < mirrors.size(); i++) {
                Mirror mirror = mirrors.get(next++);
                completion.submit(() -> probe(mirror));
            }
            while (results.size() < mirrors.size()) {
                Result result;
                try {
                    result = completion.take().get();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    result = new Result("unknown", "未知", false, -1, 0, shortMessage(e));
                }
                results.add(result);
                if (listener != null) {
                    try {
                        listener.accept(result);
                    } catch (Throwable ignored) {
                        // 回调抛异常不能打断测速
                    }
                }
                if (next < mirrors.size()) {
                    Mirror mirror = mirrors.get(next++);
                    completion.submit(() -> probe(mirror));
                }
            }
        } finally {
            pool.shutdownNow();
        }

        results.sort(Comparator.comparingLong(Result::score));
        saveResults(results);
        return toJson(results);
    }

    private static Result probe(Mirror mirror) {
        String url = mirror.direct() ? PROBE : mirror.prefix() + PROBE;
        long start = System.nanoTime();
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(6))
                    .header("User-Agent", Metadata.NAME + "/" + Metadata.VERSION)
                    .header("Range", "bytes=0-" + (PROBE_BYTES - 1))
                    .GET()
                    .build();
            HttpResponse<InputStream> response =
                    CLIENT.send(request, HttpResponse.BodyHandlers.ofInputStream());
            long ttfb = (System.nanoTime() - start) / 1_000_000;

            int code = response.statusCode();
            if (code < 200 || code >= 400) {
                closeQuietly(response.body());
                return new Result(mirror.id(), mirror.name(), false, -1, 0, "HTTP " + code);
            }

            String contentType = response.headers().firstValue("content-type").orElse("");
            if (contentType.toLowerCase(Locale.ROOT).contains("text/html")) {
                // 不少镜像在出错时返回 200 + 一张 HTML 错误页，光看状态码会误判成可用
                closeQuietly(response.body());
                return new Result(mirror.id(), mirror.name(), false, -1, 0, "返回的是网页，不是文件");
            }

            long bytes = 0;
            try (InputStream in = response.body()) {
                byte[] buffer = new byte[32 * 1024];
                int n;
                while (bytes < PROBE_BYTES && (n = in.read(buffer)) > 0) {
                    bytes += n;
                }
            }
            long totalMs = Math.max(1, (System.nanoTime() - start) / 1_000_000);
            long speedKbps = bytes > 0 ? (bytes / 1024) * 1000 / totalMs : 0;
            return new Result(mirror.id(), mirror.name(), true, ttfb, speedKbps, "");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Result(mirror.id(), mirror.name(), false, -1, 0, "被中断");
        } catch (Throwable e) {
            long elapsed = (System.nanoTime() - start) / 1_000_000;
            String message = shortMessage(e);
            // 超时单独说清楚：用户看到「10 秒无响应」比看到一堆异常类名好懂
            if (elapsed >= 5500) {
                message = "6 秒无响应";
            }
            return new Result(mirror.id(), mirror.name(), false, -1, 0, message);
        }
    }

    // ==================== 状态与持久化 ====================

    /// 给前端的完整状态：镜像列表 + 上次测速结果 + 当前最优。
    static JsonObject status() {
        JsonObject config = readConfig();
        JsonArray results = new JsonArray();
        String best = "direct";
        long testedAt = 0;
        if (config != null) {
            if (config.has("results") && config.get("results").isJsonArray()) {
                results = config.getAsJsonArray("results");
            }
            best = optString(config, "best");
            if (config.has("testedAt") && config.get("testedAt").isJsonPrimitive()) {
                try {
                    testedAt = config.get("testedAt").getAsLong();
                } catch (Exception ignored) {
                    testedAt = 0;
                }
            }
        }
        if (best.isBlank()) {
            best = "direct";
        }

        JsonObject out = new JsonObject();
        out.add("mirrors", mirrorList());
        out.add("results", results);
        out.addProperty("best", best);
        out.addProperty("testedAt", testedAt);
        out.addProperty("probe", PROBE);
        return out;
    }

    /// 上次测出来最优的那个镜像 id。
    static String bestId() {
        JsonObject config = readConfig();
        String best = config == null ? "" : optString(config, "best");
        if (best.isBlank()) {
            return "direct";
        }
        // 配置里可能留着已经被删掉的自定义镜像
        return find(best) == null ? "direct" : best;
    }

    /// 手动指定镜像。保留上次测速结果，只改 `best`。
    static JsonObject pick(String id) {
        JsonObject out = new JsonObject();
        Mirror mirror = find(id);
        if (mirror == null) {
            out.addProperty("ok", false);
            out.addProperty("error", "没有这个镜像");
            return out;
        }
        JsonObject config = readConfig();
        if (config == null) {
            config = new JsonObject();
        }
        config.addProperty("best", mirror.id());
        config.addProperty("pickedAt", System.currentTimeMillis());
        writeConfig(config);
        out.addProperty("ok", true);
        out.addProperty("best", mirror.id());
        out.addProperty("name", mirror.name());
        return out;
    }

    private static void saveResults(List<Result> results) {
        JsonArray array = new JsonArray();
        // 结果已经按分数排过序，第一个可用就是最优。
        // 不能写成「best 还是默认值就覆盖」——直连排第一时会被后面的镜像顶掉。
        String best = null;
        for (Result result : results) {
            JsonObject item = new JsonObject();
            item.addProperty("id", result.id());
            item.addProperty("name", result.name());
            item.addProperty("ok", result.ok());
            item.addProperty("ttfb", result.ttfbMs());
            item.addProperty("speed", result.speedKbps());
            item.addProperty("error", result.error());
            array.add(item);
            if (result.ok() && best == null) {
                best = result.id();
            }
        }
        if (best == null) {
            best = "direct";
        }

        JsonObject out = new JsonObject();
        out.add("results", array);
        out.addProperty("best", best);
        out.addProperty("testedAt", System.currentTimeMillis());
        writeConfig(out);
    }

    private static JsonObject readConfig() {
        try {
            if (!Files.isRegularFile(CONFIG)) {
                return null;
            }
            String text = Files.readString(CONFIG, StandardCharsets.UTF_8);
            JsonElement parsed = JsonParser.parseString(text);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (Exception e) {
            LOG.warning("Failed to read github mirror config", e);
            return null;
        }
    }

    private static void writeConfig(JsonObject json) {
        try {
            Files.createDirectories(CONFIG.getParent());
            Files.writeString(CONFIG, JsonUtils.GSON.toJson(json), StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.warning("Failed to save github mirror config", e);
        }
    }

    private static JsonObject toJson(List<Result> results) {
        JsonObject out = new JsonObject();
        JsonArray array = new JsonArray();
        // 结果已经按分数排过序，第一个可用就是最优。
        // 不能写成「best 还是默认值就覆盖」——直连排第一时会被后面的镜像顶掉。
        String best = null;
        for (Result result : results) {
            JsonObject item = new JsonObject();
            item.addProperty("id", result.id());
            item.addProperty("name", result.name());
            item.addProperty("ok", result.ok());
            item.addProperty("ttfb", result.ttfbMs());
            item.addProperty("speed", result.speedKbps());
            item.addProperty("error", result.error());
            array.add(item);
            if (result.ok() && best == null) {
                best = result.id();
            }
        }
        if (best == null) {
            best = "direct";
        }
        out.add("results", array);
        // 测速结果也要带上完整镜像列表：前端拿它重建下拉框，
        // 少了这一段，测完一次下拉就会被清空。
        out.add("mirrors", mirrorList());
        out.addProperty("best", best);
        out.addProperty("testedAt", System.currentTimeMillis());
        return out;
    }

    /// 给前端的镜像清单（id / 名字 / 是不是直连）。
    private static JsonArray mirrorList() {
        JsonArray list = new JsonArray();
        for (Mirror mirror : all()) {
            JsonObject item = new JsonObject();
            item.addProperty("id", mirror.id());
            item.addProperty("name", mirror.name());
            item.addProperty("direct", mirror.direct());
            list.add(item);
        }
        return list;
    }

    // ==================== 工具 ====================

    private static String optString(JsonObject object, String key) {
        if (object == null || !object.has(key) || !object.get(key).isJsonPrimitive()) {
            return "";
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return "";
        }
    }

    private static String shortMessage(Throwable e) {
        if (e instanceof java.net.http.HttpTimeoutException) {
            return "连接超时";
        }
        if (e instanceof java.net.ConnectException) {
            return "连不上";
        }
        if (e instanceof java.net.UnknownHostException) {
            return "域名解析失败";
        }
        if (e instanceof javax.net.ssl.SSLException) {
            return "TLS 握手失败（可能被干扰）";
        }
        String message = e.getMessage();
        if (message == null || message.isBlank()) {
            message = e.getClass().getSimpleName();
        }
        int newline = message.indexOf('\n');
        if (newline > 0) {
            message = message.substring(0, newline);
        }
        return message.length() > 80 ? message.substring(0, 80) + "…" : message;
    }

    private static void closeQuietly(InputStream in) {
        try {
            in.close();
        } catch (IOException ignored) {
            // 关流失败不影响结果
        }
    }
}