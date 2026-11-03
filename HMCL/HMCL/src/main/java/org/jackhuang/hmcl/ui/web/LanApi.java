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
import javafx.application.Platform;
import org.jackhuang.hmcl.Metadata;
import org.jackhuang.hmcl.auth.Account;
import org.jackhuang.hmcl.setting.Accounts;
import org.jackhuang.hmcl.terracotta.TerracottaNodeList;
import org.jackhuang.hmcl.util.gson.JsonUtils;
import org.jackhuang.hmcl.util.io.SystemTrust;
import org.jackhuang.hmcl.util.io.TarGz;
import org.jetbrains.annotations.Nullable;

import javax.net.ssl.SSLContext;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import javax.net.ssl.HttpsURLConnection;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

/// 多人联机：托管「陶瓦联机（Terracotta）」。
///
/// <p>一句话原则：**只调用，不修改**。陶瓦自己是完整的联机实现，我们做的事只有三件：
/// <ol>
///   <li>需要时从官方发布页下载它（不随发行版分发）；</li>
///   <li>用 `--hmcl &lt;文件&gt;` 把它拉起来 —— 它会把本地 HTTP 端口写进这个文件；</li>
///   <li>对着 `http://127.0.0.1:&lt;port&gt;/state/*` 发请求，把开房 / 加入 / 退出的结果
///       画在启动器里。</li>
/// </ol>
///
/// <p>不 patch 二进制、不改它的配置文件、不解析它的输出、不用它的窗口。
/// 界面上凡是提到这块功能的地方都写着「Terracotta | 陶瓦联机」。
public final class LanApi {

    /// 记住用户选的程序路径。放在 data/config 下，和别的配置一起备份。
    private static final Path CONFIG = Metadata.HMCL_USER_HOME.resolve("config/lan.json");

    /// 下载下来的模块放这儿，和用户手动选的路径互不干扰
    private static final Path TOOLS = Metadata.HMCL_USER_HOME.resolve("tools/terracotta");

    private static final String RELEASES_API =
            "https://api.github.com/repos/burningtnt/Terracotta/releases/latest";

    /// 从文件名里抠版本号：`terracotta-0.4.2-windows-x86_64.exe`
    private static final Pattern VERSION = Pattern.compile("(\\d+\\.\\d+\\.\\d+)");

    private final BridgeHost host;

    /// 下载任务和关机钩子都跑在别的线程上，拿不到实例字段，走这份静态引用。
    @Nullable
    private static volatile BridgeHost bridge;

    /// 下载任务在右上角列表里的 id。前端按它归组，进度按钮也认它。
    private static final String TASK_ID = "terracotta";

    /// 关机钩子只挂一次。`LanApi` 随 WebBridge 构造，重建窗口时不该重复注册。
    private static final java.util.concurrent.atomic.AtomicBoolean HOOK_REGISTERED =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    /// 陶瓦启动器的进程句柄。
    ///
    /// 只拿来兜底杀进程 —— 它把端口写进文件之后自己就退出（真正的服务在另一个进程里），
    /// 用 `isAlive()` 判断「核心在不在」会把正常启动判成秒退。
    @Nullable
    private static volatile Process launcher;
    private static volatile long startedAt;

    /// 陶瓦把端口写在这个目录下的 `http` 文件里，退出时连目录一起删
    @Nullable
    private static Path coreDir;
    /// 端口文件。每次启动换新目录，不会读到上一轮的旧内容
    @Nullable
    private static volatile Path portFile;
    /// 拿到端口之前是 -1
    private static volatile int corePort = -1;
    /// 最近一次 `/state` 成功应答的时刻。超过 5 秒没应答就当核心没了
    private static volatile long lastSeenAt;
    /// 启动进行中（端口还没出来）。超时或失败后置 false
    private static volatile boolean startingUp;
    /// 陶瓦 `/state` 的最新快照，轮询线程负责刷新
    @Nullable
    private static volatile JsonObject lastState;
    @Nullable
    private static volatile Thread poller;

    /// 下载解包是后台线程跑的，前端每两秒轮询一次状态看进度
    private static final AtomicBoolean INSTALLING = new AtomicBoolean(false);
    private static volatile double installProgress = 0;
    private static volatile String installError = "";
    /// 核心起来了但没拿到端口 / 已经退出，用一句话说清原因
    private static volatile String startError = "";

    LanApi(BridgeHost host) {
        this.host = host;
        bridge = host;

        // 关启动器时把核心一起收掉。陶瓦的服务进程独立在后台跑，
        // 不主动结束就会一直占着端口，下次启动变成 secondary mode。
        //
        // 只注册一次：`LanApi` 跟着 WebBridge 建，窗口重建时不该多挂一个钩子。
        if (HOOK_REGISTERED.compareAndSet(false, true)) {
            Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                if (corePort > 0 || launcher != null) {
                    LOG.info("[lan] launcher exiting, stopping core");
                    lanStop();
                }
            }, "terracotta-shutdown"));
        }
    }

    // ---------------- 下载任务推送 ----------------

    /// 把进度挪到右上角那个统一的任务列表里。
    ///
    /// 原来联机模块自己维护一套「下载中 x%」，只在联机页可见；用户在别的页面
    /// 根本不知道后台在下载什么。现在和游戏版本、模组安装走同一条通道，
    /// 进度、失败重试、暂停图标都由任务面板统一负责。
    private static void pushTaskTitle() {
        JsonObject payload = new JsonObject();
        payload.addProperty("id", TASK_ID);
        payload.addProperty("title", "联机模块（陶瓦联机）");
        push("onInstallTitle", payload);
    }

    private static void pushTaskStage(String stage, double percent, boolean done, @Nullable String error) {
        JsonObject payload = new JsonObject();
        payload.addProperty("id", TASK_ID);
        payload.addProperty("stage", stage);
        payload.addProperty("done", done);
        payload.addProperty("error", error == null ? "" : error);
        payload.addProperty("kind", "install");
        payload.addProperty("percent", percent);
        // 单个文件，没有文件计数
        payload.addProperty("filesDone", -1);
        payload.addProperty("filesTotal", -1);
        push("onInstallStage", payload);
    }

    /// 推一段 JS 给页面。下载跑在后台线程，必须回到 FX 线程再交给宿主。
    private static void push(String callback, JsonObject payload) {
        BridgeHost target = bridge;
        if (target == null) {
            return;
        }
        String text = JsonUtils.GSON.toJson(payload);
        Platform.runLater(() -> target.execute("window.__hmcl && window.__hmcl." + callback + "("
                + JsonUtils.GSON.toJson(text) + ")"));
    }

    // ---------------- 状态 ----------------

    /// 核心在不在跑。
    ///
    /// 判据是「端口拿到了 + 最近五秒内 `/state` 有应答」，不是进程句柄。
    /// 陶瓦的进程模型是「启动器写完端口就退出、服务另起一个」，拿 `isAlive()`
    /// 判断会把已经跑起来的核心判成秒退 —— 这正是之前一直起不来的原因。
    private static boolean coreRunning() {
        return corePort > 0 && System.currentTimeMillis() - lastSeenAt < 5000;
    }

    /// 前端进页面拉一次，核心跑起来之后每两秒拉一次。
    ///
    /// 返回里的 `core` 就是陶瓦自己吐的那份状态 JSON（`state` 字段是状态名：
    /// `waiting` / `host-scanning` / `host-ok` / `guest-starting` / `guest-ok` / `exception` …），
    /// 我们只额外套一层「程序在不在 / 核心跑没跑 / 下载进度」。
    public String lanState() {
        JsonObject root = new JsonObject();
        root.addProperty("ok", true);

        String path = readPath();
        boolean exists = path != null && Files.isRegularFile(Path.of(path));
        if (!exists) {
            Path bundled = findInstalled();
            if (bundled != null) {
                path = bundled.toString();
                exists = true;
            }
        }

        root.addProperty("path", path == null ? "" : path);
        root.addProperty("exists", exists);
        root.addProperty("version", exists ? versionOf(Path.of(path)) : "");

        boolean running = coreRunning();
        root.addProperty("running", running);
        root.addProperty("pid", running ? launcherPid() : 0);
        root.addProperty("startedAt", running ? startedAt : 0);
        root.addProperty("port", corePort);
        root.addProperty("starting", startingUp && !running);
        root.addProperty("startError", startError);

        root.addProperty("installing", INSTALLING.get());
        root.addProperty("progress", Math.round(installProgress));
        root.addProperty("installError", installError);
        root.addProperty("player", playerName());

        // 核心起来了但还没吐出状态：给前端一个稳定的空壳，省得每处判空
        JsonObject state = lastState;
        if (state == null) {
            state = new JsonObject();
            state.addProperty("state", "waiting");
        }
        root.add("core", state);
        return root.toString();
    }

    /// 启动器进程的 pid，前端只在「运行中」时用来展示。拿不到给 0。
    private static long launcherPid() {
        Process p = launcher;
        return p != null && p.isAlive() ? p.pid() : 0;
    }

    // ---------------- 程序来源 ----------------

    /// 选程序。取消返回 `cancel: true`，前端据此什么都不做。
    public String lanPick() {
        String picked = host.pickFile("选择 Terracotta 程序",
                "Terracotta (terracotta*.exe)|terracotta*.exe|可执行文件 (*.exe)|*.exe");
        if (picked == null || picked.isBlank()) {
            JsonObject cancel = new JsonObject();
            cancel.addProperty("ok", false);
            cancel.addProperty("cancel", true);
            return cancel.toString();
        }

        Path exe = Path.of(picked);
        if (!Files.isRegularFile(exe)) {
            return error("这个文件读不到：" + picked);
        }

        try {
            writePath(exe.toString());
        } catch (IOException e) {
            LOG.warning("[lan] cannot save config", e);
            return error("记不住路径：" + e.getMessage());
        }
        return lanState();
    }

    /// 下载联机模块。同步返回，真正的活在后台线程里干，进度靠轮询。
    public String lanInstall() {
        if (INSTALLING.get()) {
            return lanState();
        }
        INSTALLING.set(true);
        installProgress = 0;
        installError = "";

        Thread worker = new Thread(LanApi::doInstall, "terracotta-install");
        worker.setDaemon(true);
        worker.start();
        return lanState();
    }

    /// 忘掉已选的程序（换了一台机器 / 删了文件之后用）。
    public void lanForget() {
        try {
            Files.deleteIfExists(CONFIG);
        } catch (IOException e) {
            LOG.warning("[lan] cannot delete config", e);
        }
    }

    // ---------------- 核心：起停与状态 ----------------

    /// 拉起联机核心。
    ///
    /// 参数 `--hmcl <文件>` 是陶瓦给启动器留的接口：它启动后把本地 HTTP 端口写进这个文件，
    /// 之后所有操作都走 `http://127.0.0.1:<port>/state/*`，**不需要它的窗口，也不改它一个字节**。
    ///
    /// 进程模型要注意：启动器写完端口就退出，真正的服务在另一个进程里。所以这里只管把
    /// 进程拉起来，能不能用由端口和 `/state` 说了算。
    public String lanStart() {
        if (coreRunning()) {
            return lanState();
        }

        String path = readPath();
        if (path == null || path.isBlank()) {
            Path bundled = findInstalled();
            path = bundled == null ? null : bundled.toString();
        }
        if (path == null || path.isBlank()) {
            return error("当前联机模块未加载，点击「下载联机模块」加载。");
        }

        Path exe;
        try {
            exe = Path.of(path);
        } catch (RuntimeException e) {
            // 配置文件里存了非法路径（盘符没了、含非法字符）：Path.of 抛的是
            // InvalidPathException，不是 IOException，原来会直接冒到上层变成一句 500
            return error("程序路径无效：" + path + "。点「下载联机模块」重新装一份。");
        }
        if (!Files.isRegularFile(exe)) {
            return error("程序不见了：" + path + "。重新下载一次，或者去发布页手动下载。");
        }

        try {
            Path dir = Files.createTempDirectory("hopestar-terracotta-");
            Path file = dir.resolve("http");
            coreDir = dir;
            portFile = file;
            corePort = -1;
            lastSeenAt = 0;
            lastState = null;
            startError = "";
            startingUp = true;
            startedAt = System.currentTimeMillis();

            ProcessBuilder builder = new ProcessBuilder(exe.toString(), "--hmcl", file.toString());
            Path workDir = exe.getParent();
            if (workDir != null) {
                // 工作目录设在 exe 旁边：它会在同目录写配置和日志
                builder.directory(workDir.toFile());
            }
            // 它自己的输出没用；接管道不读会把缓冲区撑满卡死，直接丢弃
            builder.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            builder.redirectError(ProcessBuilder.Redirect.DISCARD);

            launcher = builder.start();
            LOG.info("[lan] launched " + exe + " pid=" + launcher.pid() + " hmcl=" + file);

            startPoller();
            return lanState();
        } catch (IOException e) {
            LOG.warning("[lan] cannot start " + exe, e);
            startingUp = false;
            startError = describe(e);
            return error(startError);
        }
    }

    /// 创建房间（陶瓦那边叫 scanning：先扫局域网世界，再开房）。
    ///
    /// `public_nodes` 是公共中继节点，来自陶瓦官方的节点列表；拿不到就空着，
    /// 直连成功率会低一些，但不影响本地流程。
    public String lanHost() {
        List<String[]> query = new ArrayList<>();
        query.add(new String[]{"player", playerName()});
        for (String node : publicNodes()) {
            query.add(new String[]{"public_nodes", node});
        }
        return action("/state/scanning", query);
    }

    /// 用房间码加入。
    public String lanJoin(String room) {
        if (room == null || room.isBlank()) {
            return error("先填房间码。");
        }
        List<String[]> query = new ArrayList<>();
        query.add(new String[]{"room", room.trim()});
        query.add(new String[]{"player", playerName()});
        for (String node : publicNodes()) {
            query.add(new String[]{"public_nodes", node});
        }
        return action("/state/guesting", query);
    }

    /// 退出房间，回到待机。
    public String lanIdle() {
        return action("/state/ide", List.of());
    }

    /// 停核心。
    ///
    /// 两条路一起走：先结束启动器句柄，再按端口反查那个真正在监听的进程。
    /// 只做前者的话，服务进程会留在后台占着端口，下次启动就变成 secondary mode。
    public static void lanStop() {
        stopPoller();
        int port = corePort;
        corePort = -1;
        lastSeenAt = 0;
        lastState = null;
        startedAt = 0;
        startingUp = false;
        startError = "";

        stopProcessQuietly();
        killByPort(port);

        Path dir = coreDir;
        coreDir = null;
        portFile = null;
        if (dir != null) {
            try {
                Files.deleteIfExists(dir.resolve("http"));
                Files.deleteIfExists(dir);
            } catch (IOException e) {
                LOG.warning("[lan] cannot clean temp dir", e);
            }
        }
    }

    /// 核心被强杀前调这个。
    ///
    /// 父进程看门狗用的是 `Runtime.halt(0)`，而 halt **不执行 shutdown hook**，
    /// 所以构造里注册的那个钩子在这条路径上跑不到 —— 陶瓦会一直挂在后台。
    /// 这里手动收一遍，异常一律吞掉：这已经是退出流程的最后一站，不能因为清理失败
    /// 把进程卡住。
    public static void shutdownQuietly() {
        try {
            lanStop();
        } catch (Throwable e) {
            LOG.warning("[lan] shutdown cleanup failed", e);
        }
    }

    // ---------------- 内部：HTTP ----------------

    private String action(String path, List<String[]> query) {
        if (!coreRunning()) {
            return error("联机核心没在跑。先点「启动联机核心」。");
        }
        StringBuilder url = new StringBuilder("http://127.0.0.1:").append(corePort).append(path);
        boolean first = true;
        for (String[] pair : query) {
            url.append(first ? '?' : '&')
                    .append(URLEncoder.encode(pair[0], StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(pair[1], StandardCharsets.UTF_8));
            first = false;
        }
        try {
            httpGet(url.toString());
            return lanState();
        } catch (Exception e) {
            LOG.warning("[lan] action failed: " + url, e);
            return error("操作没成功：" + e.getMessage());
        }
    }

    /// 关启动器进程，不碰目录、不碰端口状态。
    private static void stopProcessQuietly() {
        Process p = launcher;
        launcher = null;
        if (p != null && p.isAlive()) {
            p.destroy();
            try {
                if (!p.waitFor(3, TimeUnit.SECONDS)) {
                    p.destroyForcibly();
                    LOG.info("[lan] force killed launcher pid=" + p.pid());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /// 按监听端口反查 PID 并结束。
    ///
    /// 陶瓦的服务进程不是 `ProcessBuilder` 直接起的那个，`destroy()` 够不着它。
    /// 端口是我们唯一确实知道的锚点，从这儿反查最靠谱。Windows 走 netstat + taskkill，
    /// 别的平台走 lsof + kill。
    private static void killByPort(int port) {
        if (port <= 0) {
            return;
        }
        boolean windows = System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
        List<String> find = windows
                ? List.of("cmd", "/c", "netstat -ano -p tcp | findstr LISTENING | findstr :" + port)
                : List.of("sh", "-c", "lsof -nP -iTCP:" + port + " -sTCP:LISTEN -t");
        try {
            Process query = new ProcessBuilder(find).redirectErrorStream(true).start();
            String out = new String(query.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            if (!query.waitFor(3, TimeUnit.SECONDS)) {
                query.destroyForcibly();
            }
            for (String line : out.split("\\R")) {
                String[] parts = line.strip().split("\\s+");
                if (parts.length < 2) {
                    continue;
                }
                // netstat 的 PID 在最后一列，lsof -t 每行只有一个 PID
                String pid = parts[parts.length - 1];
                if (!pid.matches("\\d+") || pid.equals("0")) {
                    continue;
                }
                Process kill = new ProcessBuilder(windows
                        ? List.of("taskkill", "/F", "/PID", pid)
                        : List.of("kill", "-9", pid)).start();
                if (!kill.waitFor(3, TimeUnit.SECONDS)) {
                    kill.destroyForcibly();
                }
                LOG.info("[lan] killed pid=" + pid + " holding port " + port);
            }
        } catch (Exception e) {
            LOG.warning("[lan] cannot kill process holding port " + port, e);
        }
    }

    /// 后台线程：等端口、读状态。
    ///
    /// 端口文件是唯一可靠的起点 —— 启动器进程把端口写进去之后就退了。
    /// 25 秒拿不到才算失败：冷启动要解压和校验，慢一点正常，卡死要能报出来。
    private static void startPoller() {
        stopPoller();
        Thread thread = new Thread(() -> {
            long deadline = System.currentTimeMillis() + 25_000;
            while (!Thread.currentThread().isInterrupted()) {
                if (corePort <= 0) {
                    int port = readPortFile();
                    if (port > 0) {
                        corePort = port;
                        startingUp = false;
                        LOG.info("[lan] core port=" + port);
                    } else if (System.currentTimeMillis() > deadline) {
                        startError = "联机核心起不来：25 秒内没拿到端口。换一个版本试试，或者去发布页看看有没有更新。";
                        startingUp = false;
                        LOG.warning("[lan] no port file within 25s");
                        stopProcessQuietly();
                        break;
                    }
                } else {
                    try {
                        String body = httpGet("http://127.0.0.1:" + corePort + "/state");
                        lastState = JsonParser.parseString(body).getAsJsonObject();
                        lastSeenAt = System.currentTimeMillis();
                    } catch (Exception e) {
                        // 核心可能正在退出：状态先留着，超过 5 秒没应答由 coreRunning() 判死
                    }
                }

                try {
                    Thread.sleep(corePort > 0 ? 1000 : 200);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "terracotta-state");
        thread.setDaemon(true);
        poller = thread;
        thread.start();
    }

    /// 读端口文件。文件可能正写到一半，解析失败就当没读到。
    private static int readPortFile() {
        Path file = portFile;
        if (file == null || !Files.isRegularFile(file)) {
            return -1;
        }
        try {
            JsonObject object = JsonParser.parseString(
                    Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            return object.get("port").getAsInt();
        } catch (Exception ignored) {
            return -1;
        }
    }

    private static void stopPoller() {
        Thread t = poller;
        poller = null;
        if (t != null) {
            t.interrupt();
        }
    }

    /// 本地接口用的客户端。陶瓦在 127.0.0.1 上，不需要证书。
    ///
    /// 必须是单例：`HttpClient` 内部带连接池和 selector 线程，每次 `new` 都多一套。
    /// 状态轮询一秒一次，之前每轮都新建，跑几分钟就能堆出几百个线程。
    private static final class LocalClient {
        static final HttpClient INSTANCE = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    /// 外网用的客户端，走 JDK + 系统证书库合并出来的信任锚。同样必须复用。
    private static final class RemoteClient {
        static final HttpClient INSTANCE = build();

        private static HttpClient build() {
            HttpClient.Builder builder = HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(20))
                    .followRedirects(HttpClient.Redirect.NORMAL);
            SSLContext context = SystemTrust.context();
            if (context != null) {
                builder.sslContext(context);
            }
            return builder.build();
        }
    }

    private static String httpGet(String url) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();
        HttpResponse<String> response = LocalClient.INSTANCE.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() / 100 != 2) {
            throw new IOException("HTTP " + response.statusCode());
        }
        return response.body();
    }

    /// 当前账号的名字，陶瓦用它当玩家名。
    private static String playerName() {
        try {
            Account account = Accounts.getSelectedAccount();
            if (account != null && account.getProfileName() != null && !account.getProfileName().isBlank()) {
                return account.getProfileName();
            }
        } catch (Throwable ignored) {
        }
        return "玩家";
    }

    /// 公共节点。拿不到就返回空列表 —— 直连仍可工作，只是穿透率低一些。
    private static List<String> publicNodes() {
        try {
            List<String> nodes = new ArrayList<>();
            for (var url : TerracottaNodeList.fetch()) {
                nodes.add(url.toString());
            }
            return nodes;
        } catch (Throwable e) {
            LOG.info("[lan] node list unavailable: " + e);
            return List.of();
        }
    }

    @Nullable
    private static String resolveExePath() {
        String path = readPath();
        if (path != null && !path.isBlank()) {
            return path;
        }
        Path bundled = findInstalled();
        return bundled == null ? null : bundled.toString();
    }

    // ---------------- 下载与安装 ----------------

    private static void doInstall() {
        Path staging = TOOLS.resolve(".staging");
        try {
            Files.createDirectories(TOOLS);
            pushTaskTitle();
            pushTaskStage("正在获取版本信息", 0, false, null);

            JsonObject release = fetchJson(RELEASES_API);
            String assetUrl = null;
            JsonArray assets = release.getAsJsonArray("assets");
            if (assets != null) {
                for (JsonElement element : assets) {
                    JsonObject asset = element.getAsJsonObject();
                    String name = asset.get("name").getAsString();
                    if (name.contains("windows") && name.contains("x86_64") && name.endsWith(".tar.gz")) {
                        assetUrl = asset.get("browser_download_url").getAsString();
                        break;
                    }
                }
            }
            if (assetUrl == null) {
                throw new IOException("发布页里没有 windows-x86_64 包");
            }

            // 每次重下都从干净的目录开始，避免上一版残留的 exe 被当成新版
            deleteTree(staging);
            Files.createDirectories(staging);

            Path archive = staging.resolve("terracotta.tar.gz");
            download(assetUrl, archive);

            pushTaskStage("正在解压", 96, false, null);
            Path unpacked = staging.resolve("app");
            TarGz.extract(archive, unpacked);
            Path exe = findExe(unpacked);
            if (exe == null) {
                throw new IOException("包里没有找到 exe");
            }

            // 挪到正式目录：不同版本各自一个子目录，换版本不会互相覆盖
            String version = versionOf(exe);
            Path target = TOOLS.resolve(version.isEmpty() ? "current" : version);
            deleteTree(target);
            moveTree(exe.getParent(), target);

            Path installed = target.resolve(exe.getFileName().toString());
            writePath(installed.toString());
            deleteTree(staging);
            installProgress = 100;
            pushTaskStage("已完成", 1, true, null);
            LOG.info("[lan] installed " + installed);
        } catch (Throwable e) {
            LOG.warning("[lan] install failed", e);
            installError = describe(e);
            // 任务行只说一句能照着做的；具体到证书 / hosts 的原因在上面那条 toast 里
            pushTaskStage("", -1, true, "下载联机模块失败，请检查网络是否正常");
            try {
                deleteTree(staging);
            } catch (IOException ignored) {
            }
        } finally {
            INSTALLING.set(false);
        }
    }

    /// 把异常翻成一句能照着做的话。
    ///
    /// 直接把 `PKIX path building failed` 甩给用户等于什么都没说 —— 他不知道
    /// 这是证书、代理还是网络的问题，也不知道下一步该点哪儿。
    private static String describe(Throwable e) {
        String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        if (e instanceof javax.net.ssl.SSLException || message.contains("PKIX") || message.contains("certificate")) {
            String local = hostsPointingToLocalhost();
            if (local != null) {
                return "证书校验没过：hosts 把 github.com 指到了 " + local
                        + "，是本地加速工具（瓦特工具箱 / Steam++ 之类）留下的。"
                        + "在它里面关掉加速并清一次 hosts，或者手动删掉 hosts 里指向本机的 github 条目，再重试。";
            }
            return "证书校验没过，多半是代理或网络拦截。点「打开发布页」手动下载，再用「选择程序」指过来。";
        }
        if (e instanceof java.net.ConnectException) {
            String local = hostsPointingToLocalhost();
            if (local != null) {
                return "连不上 github.com：hosts 把它指到了 " + local + "，但那里没有程序在监听。"
                        + "清掉 hosts 里指向本机的 github 条目，或者在加速工具里重新开启加速。";
            }
            return "连不上 GitHub。检查网络后重试，或者点「打开发布页」手动下载。";
        }
        if (e instanceof java.net.UnknownHostException) {
            return "连不上 GitHub。检查网络后重试，或者点「打开发布页」手动下载。";
        }
        if (e instanceof java.net.http.HttpTimeoutException) {
            return "下载超时。换个网络再试，或者点「打开发布页」手动下载。";
        }
        return message;
    }

    /// GitHub 在国内经常直连不上，先直连、失败再走「百宝箱 → GitHub 加速」选出的镜像。
    /// 镜像只改写下载地址，发布页和 API 的语义不变。
    private static String withMirror(String url) {
        try {
            return GithubMirrorService.canAccelerate(url)
                    ? GithubMirrorService.rewriteBest(url)
                    : url;
        } catch (Throwable e) {
            return url;
        }
    }

    private static JsonObject fetchJson(String url) throws IOException, InterruptedException {
        try {
            return fetchJsonDirect(url);
        } catch (IOException | InterruptedException e) {
            String mirrored = withMirror(url);
            if (mirrored.equals(url)) {
                throw e;
            }
            LOG.info("[lan] direct GitHub API failed, retry via mirror: " + mirrored);
            return fetchJsonDirect(mirrored);
        }
    }

    /// 访问 GitHub 用的客户端。
    ///
    /// 关键在 `sslContext`：浏览器、curl、.NET 读的是系统证书库，Java 只读 JDK 自带的
    /// cacerts。装了本地加速或抓包工具的机器上，那些工具的根证书只在系统库里，
    /// 于是浏览器能开 GitHub，这里却报 `PKIX path building failed`。
    /// 合并系统根证书之后两边口径一致，校验规则没有放松。
    private static HttpClient githubClient() {
        return RemoteClient.INSTANCE;
    }

    /// hosts 里把 GitHub 指到本机了吗？指到了就返回那个地址，没指到返回 null。
    ///
    /// 本地加速工具（瓦特工具箱 / Steam++ 之类）的 hosts 模式会写上百条
    /// `127.0.0.1 github.com`，关掉加速也不一定清。它们的自签证书没进系统库时，
    /// 报错只说「证书校验没过」，用户根本不知道该去哪儿改。
    @Nullable
    private static String hostsPointingToLocalhost() {
        try {
            String root = System.getenv("SystemRoot");
            Path file = root == null || root.isBlank()
                    ? Path.of("/etc/hosts")
                    : Path.of(root, "System32", "drivers", "etc", "hosts");
            if (!Files.isRegularFile(file)) {
                return null;
            }
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                String text = line.strip();
                if (text.isEmpty() || text.startsWith("#")) {
                    continue;
                }
                // 行尾注释先切掉，再按空白拆
                int hash = text.indexOf('#');
                if (hash >= 0) {
                    text = text.substring(0, hash).strip();
                }
                String[] parts = text.split("\\s+");
                if (parts.length < 2) {
                    continue;
                }
                String address = parts[0];
                if (!address.startsWith("127.") && !address.equals("::1")) {
                    continue;
                }
                for (int i = 1; i < parts.length; i++) {
                    String name = parts[i].toLowerCase(Locale.ROOT);
                    if (name.equals("github.com")
                            || name.equals("api.github.com")
                            || name.endsWith(".githubusercontent.com")) {
                        return address;
                    }
                }
            }
        } catch (Exception ignored) {
            // 读不到 hosts 就当作没改过，不影响主流程
        }
        return null;
    }

    private static JsonObject fetchJsonDirect(String url) throws IOException, InterruptedException {
        HttpClient client = githubClient();
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "HopeStar-MCLab")
                .GET()
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() / 100 != 2) {
            throw new IOException("GitHub 返回 " + response.statusCode());
        }
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    /// 模块下载的兜底镜像前缀。
    ///
    /// 顺序按国内可达性排：先 ghfast / gh-proxy 这类通用代理，再兜底几个。
    /// 公益站随时可能停服，所以不做「选一个最好的押上去」，而是**逐个试**。
    private static final List<String> MODULE_MIRRORS = List.of(
            "https://ghfast.top/",
            "https://gh-proxy.com/",
            "https://ghproxy.net/",
            "https://v6.gh-proxy.org/"
    );

    /// 下载模块，逐源重试。
    ///
    /// 之前只试两个源：直连 → 用户测速得出的最优镜像。最优镜像本身挂掉
    /// （公益站常见）就彻底失败，用户只能反复点重试。现在把直连、最优镜像、
    /// 以及几个通用代理排成候选队列，任何一个成功就停 —— 一次点击能把
    /// 整条链路走完，而不是卡在某个源上。
    private static void download(String url, Path target) throws IOException {
        java.util.LinkedHashSet<String> candidates = new java.util.LinkedHashSet<>();
        candidates.add(url);
        String best = withMirror(url);
        if (!best.equals(url)) {
            candidates.add(best);
        }
        if (GithubMirrorService.canAccelerate(url)) {
            for (String prefix : MODULE_MIRRORS) {
                candidates.add(prefix + url);
            }
        }

        IOException last = null;
        int index = 0;
        for (String candidate : candidates) {
            index++;
            try {
                LOG.info("[lan] 下载源 " + index + "/" + candidates.size() + "：" + candidate);
                downloadDirect(candidate, target);
                if (index > 1) {
                    LOG.info("[lan] 由第 " + index + " 个源下载成功");
                }
                return;
            } catch (IOException e) {
                last = e;
                LOG.info("[lan] 源失败，换下一个：" + describeShort(e));
                // 只在失败时清半截文件。放进 finally 会把成功下载的那份也删掉 ——
                // return 之前 finally 照样执行，下一个源又要从零开始。
                try {
                    Files.deleteIfExists(target);
                } catch (IOException ignored) {
                }
            }
        }
        throw last != null ? last : new IOException("没有可用的下载源");
    }

    private static String describeShort(Throwable e) {
        String m = e.getMessage();
        return m == null || m.isBlank() ? e.getClass().getSimpleName() : m;
    }

    /// 下载发行包。
    ///
    /// 这里用 `HttpURLConnection` 而不是 `HttpClient`，只为一件事：**读取超时**。
    /// `HttpClient` 只有整体超时，碰到「连接还在、数据不再来」的链路卡死会一直挂着，
    /// 进度条停在某个百分比再也不动，用户既不能重试也不知道出了什么事。
    /// `setReadTimeout` 是按每次读算的，30 秒没有新字节就抛异常，失败路径才能走通。
    private static void downloadDirect(String url, Path target) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) URI.create(url).toURL().openConnection();
        try {
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "HopeStar-MCLab");

            // 证书走和别处同一套信任锚（JDK + 系统证书库）
            if (connection instanceof HttpsURLConnection https) {
                SSLContext context = SystemTrust.context();
                if (context != null) {
                    https.setSSLSocketFactory(context.getSocketFactory());
                }
            }

            int code = connection.getResponseCode();
            if (code / 100 != 2) {
                throw new IOException("下载失败，HTTP " + code);
            }

            long total = connection.getContentLengthLong();
            // 每 2% 推一次就够了：64KB 一块读下来每秒几百次，全推会把页面的消息队列刷满
            int nextReport = 0;
            try (InputStream in = connection.getInputStream();
                 OutputStream out = Files.newOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                long done = 0;
                int n;
                while ((n = in.read(buffer)) > 0) {
                    out.write(buffer, 0, n);
                    done += n;
                    if (total > 0) {
                        double ratio = (double) done / total;
                        // 留 10% 给解压和搬运，别让进度条走到 100 之后还卡很久
                        installProgress = Math.min(90, ratio * 90);
                        int pct = (int) (ratio * 100);
                        if (pct >= nextReport) {
                            pushTaskStage("正在下载", Math.min(0.9, ratio * 0.9), false, null);
                            nextReport = pct + 2;
                        }
                    }
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    // ---------------- 目录操作 ----------------

    /// 托管目录里已装好的 exe。先找 terracotta.exe，再退而求其次找一个 exe。
    @Nullable
    private static Path findInstalled() {
        if (!Files.isDirectory(TOOLS)) {
            return null;
        }
        List<Path> candidates = new ArrayList<>();
        try (Stream<Path> stream = Files.walk(TOOLS, 4)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().endsWith(".exe"))
                    .forEach(candidates::add);
        } catch (IOException e) {
            LOG.warning("[lan] cannot scan tools dir", e);
            return null;
        }
        if (candidates.isEmpty()) {
            return null;
        }
        // 版本目录是并存的，取最新的那个
        return candidates.stream()
                .max(Comparator.comparing((Path p) -> versionOf(p))
                        .thenComparingLong(p -> {
                            try {
                                return Files.getLastModifiedTime(p).toMillis();
                            } catch (IOException e) {
                                return 0L;
                            }
                        }))
                .orElse(null);
    }

    @Nullable
    private static Path findExe(Path dir) throws IOException {
        List<Path> candidates = new ArrayList<>();
        try (Stream<Path> stream = Files.walk(dir, 4)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase().endsWith(".exe"))
                    .forEach(candidates::add);
        }
        if (candidates.isEmpty()) {
            return null;
        }
        return candidates.stream()
                .filter(p -> p.getFileName().toString().toLowerCase().contains("terracotta"))
                .findFirst()
                .orElse(candidates.get(0));
    }

    private static void moveTree(Path from, Path to) throws IOException {
        Files.createDirectories(to);
        if (from == null) {
            return;
        }
        try (Stream<Path> stream = Files.walk(from)) {
            for (Path source : stream.toList()) {
                Path dest = to.resolve(from.relativize(source).toString());
                if (Files.isDirectory(source)) {
                    Files.createDirectories(dest);
                } else {
                    Files.createDirectories(dest.getParent());
                    Files.copy(source, dest, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    private static void deleteTree(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return;
        }
        try (Stream<Path> stream = Files.walk(dir)) {
            for (Path path : stream.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }

    // ---------------- 存取 ----------------

    @Nullable
    private static String readPath() {
        if (!Files.isRegularFile(CONFIG)) {
            return null;
        }
        try {
            String text = Files.readString(CONFIG, StandardCharsets.UTF_8);
            JsonObject root = JsonParser.parseString(text).getAsJsonObject();
            if (root.has("path") && !root.get("path").isJsonNull()) {
                return root.get("path").getAsString();
            }
        } catch (Exception e) {
            // 配置坏了就当没配过，不要让联机页整页打不开
            LOG.warning("[lan] bad config, ignoring", e);
        }
        return null;
    }

    private static void writePath(String path) throws IOException {
        JsonObject root = new JsonObject();
        root.addProperty("path", path);

        Files.createDirectories(CONFIG.getParent());
        Path tmp = CONFIG.resolveSibling("lan.json.tmp");
        Files.writeString(tmp, root.toString(), StandardCharsets.UTF_8);
        try {
            Files.move(tmp, CONFIG, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, CONFIG, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /// 文件名里带的版本号，给页面显示用；抠不到就空着。
    private static String versionOf(Path exe) {
        String name = exe.getFileName().toString();
        Matcher m = VERSION.matcher(name);
        return m.find() ? m.group(1) : "";
    }

    private static String error(String message) {
        JsonObject root = new JsonObject();
        root.addProperty("ok", false);
        root.addProperty("error", message);
        return root.toString();
    }
}
