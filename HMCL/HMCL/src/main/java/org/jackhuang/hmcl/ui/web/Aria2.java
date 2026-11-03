package org.jackhuang.hmcl.ui.web;

import org.jackhuang.hmcl.Metadata;
import org.jetbrains.annotations.Nullable;

import static org.jackhuang.hmcl.util.logging.Logger.LOG;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/// aria2c 的调用封装。
///
/// <p>启动器自带一份 `data/bin/aria2c.exe`（取自 MTGet 项目里的 5.4 MB 单文件，
/// aria2 1.37）。用它而不是自己写 HTTP 的原因：
///
/// <ul>
///   <li>16 连接分块。单连接下 190 MB 的 JDK 要十几分钟，分块后快得多；</li>
///   <li>**一个文件多个源**。把直达链和各镜像一起给它，aria2 会自己挑快的、
///       失败了自动换，不用我们写轮换逻辑（而且它换源时能接着已下的分块，
///       自研版本只能整个重来）；</li>
///   <li>断点续传由 `.aria2` 控制文件负责，进程被强杀也能接着下。</li>
/// </ul>
///
/// <p>aria2 走自己的 TLS 栈，不依赖 JVM 的 cacerts。实测本机 java 直连
/// github.com 报 PKIX、curl 直接 000，aria2 却能正常下 —— 多一层保险。
final class Aria2 {

    /// `[#446a7e 2.0MiB/6.0MiB(34%) CN:1 DL:1.0MiB ETA:3s]`
    private static final Pattern PROGRESS = Pattern.compile(
            "\\[#([0-9a-f]{6})\\s+(\\S+)/(\\S+)\\((\\d+)%\\)(?:[^\\]]*?DL:([\\d.]+\\s*[KMGT]?i?B))?");

    /// 已经找到的路径，避免每次下载都去扫目录
    @Nullable
    private static volatile Path cached;

    private Aria2() {
    }

    /// 找 aria2c：启动器自带的 `data/bin` 优先，其次系统 PATH。
    @Nullable
    static Path locate() {
        Path cachedPath = cached;
        if (cachedPath != null && Files.isRegularFile(cachedPath)) {
            return cachedPath;
        }

        String exeName = isWindows() ? "aria2c.exe" : "aria2c";
        List<Path> candidates = new ArrayList<>();

        // 1) 启动器目录下的 data/bin —— 打包时放在这里，用户升级也不会丢
        try {
            candidates.add(Metadata.HMCL_LOCAL_HOME.resolve("bin").resolve(exeName));
        } catch (Throwable ignored) {
        }
        // 2) 开发环境：项目根目录的 dist-package
        candidates.add(Path.of("data", "bin", exeName));

        for (Path p : candidates) {
            if (Files.isRegularFile(p)) {
                cached = p.toAbsolutePath();
                return cached;
            }
        }

        // 3) PATH 里碰运气（用户自己装过 aria2）
        String pathEnv = System.getenv("PATH");
        if (pathEnv != null) {
            for (String dir : pathEnv.split(java.io.File.pathSeparator)) {
                if (dir.isBlank()) {
                    continue;
                }
                Path p = Path.of(dir, exeName);
                if (Files.isRegularFile(p)) {
                    cached = p;
                    return p;
                }
            }
        }

        LOG.warning("[java] 没找到 aria2c，退回内置的单连接下载器");
        return null;
    }

    /// 拼命令行。多个 url 作为同一个文件的镜像交给 aria2，它会自己选、自己换。
    static List<String> command(Path exe, Path target, List<String> urls) {
        List<String> cmd = new ArrayList<>();
        cmd.add(exe.toString());

        // 每 1 秒打一行带换行的摘要（默认的进度条是 \r 覆盖，读不出来）
        cmd.add("--summary-interval=1");
        cmd.add("--console-log-level=notice");
        cmd.add("--show-console-readout=false");
        cmd.add("--file-allocation=none");

        // 分块：16 连接、每段至少 1 MB
        cmd.add("--max-connection-per-server=16");
        cmd.add("--split=16");
        cmd.add("--min-split-size=1M");

        // 续传：靠 <文件名>.aria2 控制文件
        cmd.add("--continue=true");

        // 暂停是把 aria2c 强杀掉（CLI 没有优雅暂停），所以两件事必须做：
        // - 关掉内存缓存，否则已下但还在缓冲区的字节跟着进程一起没了，
        //   文件长度对不上控制文件里记的进度，续传出来是个空洞；
        // - 每秒落一次控制文件（默认 60 秒），不然强杀时进度停在几十秒前。
        cmd.add("--disk-cache=0");
        cmd.add("--auto-save-interval=1");

        // 目标文件名要固定，不然重下时会变成 file.1.zip
        cmd.add("--auto-file-renaming=false");
        cmd.add("--allow-overwrite=true");

        // 网络：每个源试 3 次，失败 2 秒后重试
        cmd.add("--max-tries=3");
        cmd.add("--retry-wait=2");
        cmd.add("--connect-timeout=15");
        cmd.add("--timeout=30");
        cmd.add("--lowest-speed-limit=1K");

        cmd.add("--user-agent=" + Metadata.NAME + "/" + Metadata.VERSION);
        cmd.add("--dir=" + target.getParent().toAbsolutePath());
        cmd.add("--out=" + target.getFileName());
        cmd.addAll(urls);
        return cmd;
    }

    /// 解析一行输出。不是进度行就返回 null。
    @Nullable
    static Progress parse(String line) {
        Matcher m = PROGRESS.matcher(line);
        if (!m.find()) {
            return null;
        }
        try {
            int percent = Integer.parseInt(m.group(4));
            return new Progress(percent, m.group(5));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /// aria2 的控制文件路径。暂停留着、取消删掉。
    static Path controlFile(Path target) {
        return target.resolveSibling(target.getFileName() + ".aria2");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    /// 一行进度的解析结果。`speed` 是 aria2 给的原样文本（"3.4MiB"），没给就是 null。
    record Progress(int percent, @Nullable String speed) {
    }
}
