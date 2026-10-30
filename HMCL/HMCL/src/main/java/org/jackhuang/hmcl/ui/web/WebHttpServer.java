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
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import javafx.application.Platform;
import org.jackhuang.hmcl.util.gson.JsonUtils;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/// 把 {@link WebBridge} 的 49 个 public 方法以 HTTP 暴露给前端。
///
/// 只绑 `127.0.0.1`，端口由系统分配（`:0`），实际端口写进临时目录的 `hmcl-web-ui.port`
/// 并同时打到 stdout，供 Tauri 壳读取后拼初始化 URL。不用固定端口是为了避开占用，
/// 也让每次启动的地址不同，减少被同机其它程序扫到的机会。
///
/// 两条通道方向相反：
/// - JS -> Java：`POST /api/{method}`，body 是参数数组，反射调 WebBridge
/// - Java -> JS：`GET /events` 的 SSE 长连接，每条消息 `{"js": "..."}`，前端 `eval` 掉
///
/// 之所以走 SSE 而不是 WebSocket：单向推送，用不上双向；SSE 是纯文本、可断线重连、
/// 不需要握手升级，在 WebView2 里比 WebSocket 少一层状态。
public final class WebHttpServer implements WebChannel, AutoCloseable {

    /// 端口回传文件，放临时目录，壳进程轮询它拿端口
    public static final String PORT_FILE_NAME = "hmcl-web-ui.port";
    public static final String PORT_STDOUT_PREFIX = "WEB_HTTP_PORT=";

    /// 同步调用（getState 这类要返回值的）等 FX 线程的上限
    private static final long CALL_TIMEOUT_SECONDS = 20;

    private final HttpServer server;
    private final ExecutorService executor;
    private final Map<String, Method> api = new ConcurrentHashMap<>();
    private final Map<String, SseClient> clients = new ConcurrentHashMap<>();

    /// 校验头。壳进程启动时注入随机串，其它本机程序拿不到（除非读进程参数）
    private final String token;

    private volatile WebBridge bridge;

    private WebHttpServer(HttpServer server, ExecutorService executor, String token) {
        this.server = server;
        this.executor = executor;
        this.token = token;
    }

    /// 启动并返回实例。requestedPort 传 0 让系统分配。
    public static WebHttpServer start(int requestedPort, String token) throws IOException {
        // 只监听回环，不对外暴露
        HttpServer s = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), requestedPort), 0);
        ExecutorService pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "hmcl-web-http");
            t.setDaemon(true);
            return t;
        });
        s.setExecutor(pool);

        WebHttpServer self = new WebHttpServer(s, pool, token);
        s.createContext("/", self::route);
        s.start();

        int port = s.getAddress().getPort();
        // 两条回传路径都铺：stdout 给人看，文件给壳读
        System.out.println(PORT_STDOUT_PREFIX + port);
        try {
            Path f = Path.of(System.getProperty("java.io.tmpdir"), PORT_FILE_NAME);
            Files.writeString(f, Integer.toString(port), StandardCharsets.UTF_8);
        } catch (IOException e) {
            System.err.println("无法写入端口文件: " + e);
        }
        startParentWatchdog();
        return self;
    }

    /// 壳进程消失就自杀。
    ///
    /// <p>壳正常关窗会走 `/api/quit`，但被任务管理器结束、崩溃、或者被调试器杀掉时
    /// 走不到那一步，Java 这边就成了孤儿——实测连续调试一晚上能留下十几个
    /// `java.exe`，每个几百 MB，最后把机器的可用内存吃到 Gradle 都被 OOM 杀掉。
    ///
    /// <p>父进程 pid 由壳通过 `-Dhmcl.web.parent=<pid>` 传进来；JavaFX 直接启动
    /// （不经过壳）时没有这个属性，看门狗不启动。
    private static void startParentWatchdog() {
        String raw = System.getProperty("hmcl.web.parent");
        if (raw == null || raw.isBlank()) {
            return;
        }
        long parentPid;
        try {
            parentPid = Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            return;
        }

        Thread t = new Thread(() -> {
            // 父进程刚启动时可能还没完全就绪，先给一小段宽限
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                return;
            }
            while (true) {
                if (ProcessHandle.of(parentPid).map(ProcessHandle::isAlive).orElse(false)) {
                    try {
                        Thread.sleep(2000);
                    } catch (InterruptedException e) {
                        return;
                    }
                } else {
                    System.err.println("[web] 壳进程 " + parentPid + " 已退出，核心跟随退出");
                    Runtime.getRuntime().halt(0);
                }
            }
        }, "hmcl-parent-watchdog");
        t.setDaemon(true);
        t.start();
    }

    public int port() {
        return server.getAddress().getPort();
    }

    public void setBridge(WebBridge bridge) {
        this.bridge = bridge;
        buildApiTable(bridge);
    }

    /// 反射表：只收 public、非 static、非 Object 自带的方法，且参数只支持基本类型和 String
    private void buildApiTable(WebBridge b) {
        api.clear();
        for (Method m : b.getClass().getMethods()) {
            if (Modifier.isStatic(m.getModifiers())) continue;
            if (m.getDeclaringClass() == Object.class) continue;
            if (m.getParameterCount() > 8) continue;

            boolean ok = true;
            for (Class<?> t : m.getParameterTypes()) {
                if (!isSupported(t)) { ok = false; break; }
            }
            if (!ok) continue;

            api.put(m.getName(), m);
        }
        System.out.println("WEB_HTTP_API " + api.size() + " methods");
    }

    private static boolean isSupported(Class<?> t) {
        return t == String.class || t == int.class || t == Integer.class
                || t == long.class || t == Long.class
                || t == double.class || t == Double.class
                || t == float.class || t == Float.class
                || t == boolean.class || t == Boolean.class;
    }

    // ==================== 路由 ====================

    private void route(HttpExchange ex) {
        try {
            // 前端是 tauri:// 或 http://tauri.localhost，跨源到 127.0.0.1 必须放行
            var h = ex.getResponseHeaders();
            h.add("Access-Control-Allow-Origin", "*");
            h.add("Access-Control-Allow-Headers", "content-type, x-hmcl-token");
            h.add("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            // Chrome 的 Private Network Access：页面在 tauri.localhost（公开地址空间），
            // 请求 127.0.0.1（本地）时，subresource（img / script）会先发 preflight，
            // 响应必须显式允许，否则 <img> 会立刻 error（fetch 反而宽松些）。
            h.add("Access-Control-Allow-Private-Network", "true");

            if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
                ex.sendResponseHeaders(204, -1);
                return;
            }

            String path = ex.getRequestURI().getPath();

            if ("/health".equals(path)) {
                reply(ex, 200, "{\"ok\":true,\"bridge\":" + (bridge != null) + "}");
                return;
            }

            // 壳进程在窗口关闭时调这个，让核心走正常退出流程
            if ("/api/quit".equals(path)) {
                if (!checkToken(ex)) { reply(ex, 403, "{\"ok\":false,\"error\":\"bad token\"}"); return; }
                // 必须先起退出线程再回响应：壳发完 POST 就把 socket 关了，
                // 这里写响应会抛 "insufficient bytes written to stream"，
                // 一旦把退出那一行放在 reply 之后，就永远走不到 —— Java 只能被壳 kill，
                // 日志不压缩、旧日志不裁剪、配置可能丢最后几次修改（实测踩过）。
                new Thread(WebUIShell::requestExit, "hmcl-quit").start();
                try {
                    reply(ex, 200, "{\"ok\":true}");
                } catch (Throwable ignored) {
                    // 对端已经断开，这个响应本来也没人收
                }
                return;
            }

            if ("/events".equals(path)) {
                if (!checkToken(ex)) { reply(ex, 403, "{\"ok\":false,\"error\":\"bad token\"}"); return; }
                handleEvents(ex);
                return;
            }

            // 图标代理 + 磁盘缓存。前端把 cdn.modrinth.com 的地址丢过来，
            // 后端负责直连/走图片代理并缓存，见 IconCache。
            if ("/icon".equals(path)) {
                if (!checkToken(ex)) { reply(ex, 403, "{\"ok\":false,\"error\":\"bad token\"}"); return; }
                handleIcon(ex);
                return;
            }

            // 大文件上传（整合包 / 世界存档）。走原始 body 而不是 JSON，
            // 几百 MB 的包转成 base64 会先把内存吃光。
            if (path.startsWith("/api/upload/")) {
                if (!checkToken(ex)) { reply(ex, 403, "{\"ok\":false,\"error\":\"bad token\"}"); return; }
                if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                    reply(ex, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                    return;
                }
                handleUpload(ex, path.substring("/api/upload/".length()));
                return;
            }

            if (path.startsWith("/api/")) {
                if (!checkToken(ex)) { reply(ex, 403, "{\"ok\":false,\"error\":\"bad token\"}"); return; }
                if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
                    reply(ex, 405, "{\"ok\":false,\"error\":\"use POST\"}");
                    return;
                }
                handleApi(ex, path.substring(5));
                return;
            }

            reply(ex, 404, "{\"ok\":false,\"error\":\"not found\"}");
        } catch (Throwable t) {
            t.printStackTrace();
            try { reply(ex, 500, "{\"ok\":false,\"error\":" + JsonUtils.GSON.toJson(String.valueOf(t)) + "}"); }
            catch (IOException ignored) { }
        } finally {
            ex.close();
        }
    }

    private boolean checkToken(HttpExchange ex) {
        if (token == null || token.isEmpty()) {
            return true; // 开发模式不校验
        }
        String got = ex.getRequestHeaders().getFirst("X-HMCL-Token");
        if (got == null) {
            // 兼容 SSE：EventSource 不能带自定义头，走 query
            String q = ex.getRequestURI().getQuery();
            if (q != null) {
                for (String kv : q.split("&")) {
                    int i = kv.indexOf('=');
                    if (i > 0 && "token".equals(kv.substring(0, i))) {
                        got = kv.substring(i + 1);
                    }
                }
            }
        }
        return token.equals(got);
    }

    // ==================== JS -> Java ====================

    private void handleApi(HttpExchange ex, String method) throws IOException {
        String body = readBody(ex);
        JsonArray args;
        try {
            JsonElement el = body.isEmpty() ? JsonNull.INSTANCE : JsonParser.parseString(body);
            args = el.isJsonArray() ? el.getAsJsonArray() : new JsonArray();
        } catch (Exception e) {
            reply(ex, 400, "{\"ok\":false,\"error\":\"bad json\"}");
            return;
        }

        WebBridge b = bridge;
        if (b == null) {
            reply(ex, 503, "{\"ok\":false,\"error\":\"bridge not ready\"}");
            return;
        }

        Method m = api.get(method);
        if (m == null) {
            reply(ex, 404, "{\"ok\":false,\"error\":\"no such method: " + method + "\"}");
            return;
        }

        Object[] values;
        try {
            values = coerceArgs(m, args);
        } catch (Exception e) {
            reply(ex, 400, "{\"ok\":false,\"error\":" + JsonUtils.GSON.toJson(String.valueOf(e)) + "}");
            return;
        }

        // WebBridge 的所有方法都假定在 FX 线程，HTTP handler 不在，必须切
        try {
            Object result = onFxThread(() -> m.invoke(b, values));
            JsonObject out = new JsonObject();
            out.addProperty("ok", true);
            if (result != null) {
                out.add("data", JsonUtils.GSON.toJsonTree(result));
            }
            reply(ex, 200, JsonUtils.GSON.toJson(out));
        } catch (Throwable t) {
            Throwable cause = t instanceof InvocationTargetException && t.getCause() != null ? t.getCause() : t;
            cause.printStackTrace();
            JsonObject out = new JsonObject();
            out.addProperty("ok", false);
            out.addProperty("error", String.valueOf(cause));
            reply(ex, 500, JsonUtils.GSON.toJson(out));
        }
    }

    private Object onFxThread(FxCall call) throws Throwable {
        if (Platform.isFxApplicationThread()) {
            return call.run();
        }
        CountDownLatch latch = new CountDownLatch(1);
        Object[] holder = new Object[1];
        Throwable[] error = new Throwable[1];
        Platform.runLater(() -> {
            try {
                holder[0] = call.run();
            } catch (Throwable t) {
                error[0] = t;
            } finally {
                latch.countDown();
            }
        });
        if (!latch.await(CALL_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw new IOException("FX 线程超过 " + CALL_TIMEOUT_SECONDS + " 秒未响应");
        }
        if (error[0] != null) {
            throw error[0];
        }
        return holder[0];
    }

    @FunctionalInterface
    private interface FxCall {
        Object run() throws Throwable;
    }

    private static Object[] coerceArgs(Method m, JsonArray args) {
        Class<?>[] types = m.getParameterTypes();
        Object[] out = new Object[types.length];
        for (int i = 0; i < types.length; i++) {
            JsonElement el = i < args.size() ? args.get(i) : JsonNull.INSTANCE;
            out[i] = coerce(el, types[i]);
        }
        return out;
    }

    private static Object coerce(JsonElement el, Class<?> t) {
        if (t == String.class) {
            return el.isJsonNull() ? null : el.getAsString();
        }
        boolean nul = el.isJsonNull();
        if (t == int.class || t == Integer.class) return nul ? 0 : el.getAsInt();
        if (t == long.class || t == Long.class) return nul ? 0L : el.getAsLong();
        if (t == double.class || t == Double.class) return nul ? 0d : el.getAsDouble();
        if (t == float.class || t == Float.class) return nul ? 0f : el.getAsFloat();
        if (t == boolean.class || t == Boolean.class) return !nul && el.getAsBoolean();
        return null;
    }

    // ==================== Java -> JS ====================

    @Override
    public void eval(String script) {
        if (script == null || clients.isEmpty()) {
            return;
        }

        // 必须拼成单行。
        // SSE 的 data 字段遇到裸换行就断消息，而 JsonUtils.GSON 开了 pretty printing，
        // 直接把 Map 序列化会得到三行 JSON——前端只收到第一行的 "{"，JSON.parse 失败，
        // 消息被静默丢弃。这里用 toJson(String) 单独转义脚本，再套固定骨架，保证单行。
        String payload = "data: {\"js\":" + JsonUtils.GSON.toJson(script) + "}\n\n";

        for (SseClient c : clients.values()) {
            c.send(payload);
        }
    }

    private void handleEvents(HttpExchange ex) throws IOException {
        var h = ex.getResponseHeaders();
        h.add("Content-Type", "text/event-stream; charset=utf-8");
        h.add("Cache-Control", "no-cache, no-transform");
        h.add("Connection", "keep-alive");
        h.add("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0); // 0 = chunked，长度未知

        OutputStream out = ex.getResponseBody();
        SseClient client = new SseClient(out);
        clients.put(Long.toString(System.nanoTime()), client);
        try {
            // 首帧立刻发一个 hello，让前端确认通道可用，不用等第一条业务消息
            client.send("data: {\"hello\":true}\n\n");
            client.pump(); // 阻塞直到断开
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        } finally {
            clients.values().remove(client);
        }
    }

    /// 一个 SSE 连接。写操作串行化——多个 eval 可能从不同线程进来
    private static final class SseClient {
        private final OutputStream out;
        private final BlockingQueue<String> queue = new LinkedBlockingQueue<>();

        SseClient(OutputStream out) {
            this.out = out;
        }

        void send(String payload) {
            queue.offer(payload);
        }

        /// 取一条发一条。客户端断开时 write 抛异常，退出循环
        void pump() throws InterruptedException {
            while (true) {
                String msg = queue.take();
                try {
                    out.write(msg.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                } catch (IOException e) {
                    return;
                }
            }
        }
    }

    // ==================== 工具 ====================

    /// 图标：`GET /icon?u=<URL 编码的原地址>&token=...`
    ///
    /// 走本地 HTTP 而不是让页面直接请求 cdn，有两个好处：
    /// 1. 一次取到就落盘，之后离线也能显示（见 IconCache）
    /// 2. cdn 直连不通时可以转给图片代理，前端不用关心
    private void handleIcon(HttpExchange ex) throws IOException {
        Map<String, String> query = parseQuery(ex.getRequestURI().getRawQuery());
        String url = query.get("u");
        if (url == null || url.isBlank()) {
            reply(ex, 400, "{\"ok\":false,\"error\":\"missing u\"}");
            return;
        }

        byte[] data;
        try {
            data = IconCache.getInstance().resolve(url);
        } catch (Throwable t) {
            LOG.warning("[icon] 取图标失败 " + url, t);
            data = null;
        }

        if (data == null) {
            // 404 会让前端的 <img> 触发 error，正好走字母占位
            replyBinary(ex, 404, new byte[0], "image/png");
            return;
        }
        replyBinary(ex, 200, data, IconCache.contentTypeOf(data));
    }

    private static void replyBinary(HttpExchange ex, int code, byte[] data, String contentType) throws IOException {
        ex.getResponseHeaders().add("Content-Type", contentType);
        if (code == 200 && data.length > 0) {
            // 让 WebView 自己也缓存一周，减少本地 HTTP 的往返
            ex.getResponseHeaders().add("Cache-Control", "public, max-age=604800");
        }
        if (data.length == 0) {
            ex.sendResponseHeaders(code, -1);
            return;
        }
        ex.sendResponseHeaders(code, data.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(data);
        }
    }

    /// 接收一个文件流，落到临时目录后交给 `WebBridge.importLocal`。
    ///
    /// 前端用 `fetch(url, {body: file})` 直接把 File 当 body 传上来，
    /// 是流式的，不受文件大小限制。query 里带 kind / instanceId / name。
    private void handleUpload(HttpExchange ex, String kind) throws IOException {
        WebBridge b = bridge;
        if (b == null) {
            reply(ex, 503, "{\"ok\":false,\"error\":\"bridge not ready\"}");
            return;
        }

        Map<String, String> query = parseQuery(ex.getRequestURI().getRawQuery());
        String instanceId = query.get("instanceId");
        String rawName = query.get("name");

        String defaultExt = "modpack".equals(kind) || "world".equals(kind) || "resourcepack".equals(kind) ? ".zip" : ".zip";
        Path temp;
        try {
            temp = Files.createTempFile("hmcl-upload-", defaultExt);
        } catch (IOException e) {
            reply(ex, 500, "{\"ok\":false,\"error\":" + JsonUtils.GSON.toJson(String.valueOf(e)) + "}");
            return;
        }

        long size;
        try (InputStream in = ex.getRequestBody()) {
            Files.copy(in, temp, StandardCopyOption.REPLACE_EXISTING);
            size = Files.size(temp);
        } catch (IOException e) {
            try { Files.deleteIfExists(temp); } catch (IOException ignored) { }
            reply(ex, 500, "{\"ok\":false,\"error\":" + JsonUtils.GSON.toJson(String.valueOf(e)) + "}");
            return;
        }

        // 保留原始扩展名，整合包解析要看后缀（.zip / .mrpack）
        String finalName = rawName != null && !rawName.isBlank() ? rawName : temp.getFileName().toString();
        Path named = temp.resolveSibling(finalName.replaceAll("[\\/:*?\"<>|]", "_"));
        try {
            Files.move(temp, named, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            named = temp;
        }

        LOG.info("[upload] " + kind + " ← " + finalName + " (" + size + " bytes) → " + named);

        b.importLocal(kind, named.toAbsolutePath().toString(), instanceId, rawName);
        reply(ex, 200, "{\"ok\":true,\"size\":" + size + "}");
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        Map<String, String> map = new LinkedHashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) {
            return map;
        }
        for (String kv : rawQuery.split("&")) {
            int i = kv.indexOf('=');
            if (i <= 0) {
                continue;
            }
            try {
                map.put(URLDecoder.decode(kv.substring(0, i), StandardCharsets.UTF_8),
                        URLDecoder.decode(kv.substring(i + 1), StandardCharsets.UTF_8));
            } catch (Exception ignored) {
            }
        }
        return map;
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody(); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            in.transferTo(bos);
            return bos.toString(StandardCharsets.UTF_8);
        }
    }

    private static void reply(HttpExchange ex, int code, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(bytes);
        }
    }

    @Override
    public void close() {
        for (SseClient c : new ArrayList<>(clients.values())) {
            c.send("data: {\"bye\":true}\n\n");
        }
        clients.clear();
        server.stop(0);
        executor.shutdownNow();
    }
}
