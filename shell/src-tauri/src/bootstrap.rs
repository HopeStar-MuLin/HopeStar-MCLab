//! 首次启动的 Java 引导。
//!
//! 发行版不带 Java，而启动器核心本身要 Java 21 才能跑 —— 没有它连界面都出不来。
//! 所以壳先开一个只依赖 WebView 的引导页（`bootstrap.html`，不需要 Java），
//! 在这里把 Temurin JRE 21 下下来、解压到 `data/runtime`，然后再起核心。
//!
//! 下载和解压都不引第三方 crate：
//! - 下载交给包里的 `data/bin/aria2c.exe`（MTGet 那个 5.4 MB 单文件，16 连接分块、
//!   多源自动切换）；它在就用它，不在就退回系统 PowerShell；
//! - 解压用 Windows 10 1803 起自带的 `C:\Windows\System32\tar.exe`（bsdtar，
//!   直接吃 zip），省掉 zip/deflate 依赖。
//!
//! 任何一步失败都不抛给用户看堆栈，而是把原因写进引导页，并提示手动装 Java。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::WebviewWindow;

/// Temurin 21 的最新 JRE（x64 Windows）。
///
/// 用 `binary/latest` 这个重定向接口而不是写死带版本号的文件名：Adoptium 隔几个月
/// 就发一版，写死的话下次就得改代码。
const DOWNLOAD_URLS: &[&str] = &[
    "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse",
    // 走 GitHub 加速的同一个地址：Adoptium 最终会 302 到 github release，
    // 国内直连经常卡住，套一层镜像更稳
    "https://ghfast.top/https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse",
];

/// 低于这个大小基本就是下到了错误页 / 半截文件
const MIN_ZIP_BYTES: u64 = 20 * 1024 * 1024;

/// 确保系统里有能跑核心的 Java。返回它的路径。
pub fn ensure_java(window: &WebviewWindow) -> Result<PathBuf, String> {
    if let Ok(java) = crate::sidecar::locate_java() {
        // 这台机器本来就有 Java：引导页只当启动画面用，别显示「未安装 / 正在下载」
        let _ = window.eval("window.bootstrapReady && window.bootstrapReady()");
        return Ok(java);
    }

    let data = crate::sidecar::data_dir();
    let runtime = data.join("runtime");
    let work = data.join("java-bootstrap");

    // 上次下到一半留下的东西：只要 runtime 还没成，就清掉重来
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work)
        .map_err(|e| format!("建不了临时目录 {}：{e}", work.display()))?;

    let zip = work.join("temurin21-jre.zip");

    progress(window, Some(0.0), "连接下载服务器…");
    if let Err(e) = download(window, DOWNLOAD_URLS, &zip) {
        let _ = std::fs::remove_dir_all(&work);
        return Err(format!("下载 Java 失败：{e}"));
    }

    match std::fs::metadata(&zip) {
        Ok(meta) if meta.len() >= MIN_ZIP_BYTES => {}
        Ok(meta) => {
            let _ = std::fs::remove_dir_all(&work);
            return Err(format!("下载下来的文件只有 {} 字节，不像安装包", meta.len()));
        }
        Err(e) => return Err(format!("下载文件不见了：{e}")),
    }

    progress(window, None, "正在解压…");
    let unpacked = work.join("unpacked");
    std::fs::create_dir_all(&unpacked)
        .map_err(|e| format!("建不了解压目录：{e}"))?;
    extract_zip(&zip, &unpacked)?;

    // Temurin 的 zip 里包着一层 `jdk-21.0.x-y-jre/`，把那一层挪成 runtime
    let inner = single_dir(&unpacked).ok_or_else(|| "压缩包结构不认识（没有单层目录）".to_string())?;
    if runtime.exists() {
        let _ = std::fs::remove_dir_all(&runtime);
    }
    std::fs::rename(&inner, &runtime)
        .map_err(|e| format!("把运行时挪到 {} 失败：{e}", runtime.display()))?;

    let java = runtime.join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
    if !java.is_file() {
        let _ = std::fs::remove_dir_all(&runtime);
        return Err(format!("解压完没找到 {}，包可能不对", java.display()));
    }

    let _ = std::fs::remove_dir_all(&work);
    progress(window, Some(1.0), "准备完成，正在启动…");
    Ok(java)
}

/// 把失败显示到引导页上（不弹系统框：页面已经在了，用页面更清楚）
pub fn show_error(window: &WebviewWindow, message: &str) {
    let js = format!(
        "window.bootstrapError && window.bootstrapError({})",
        serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string())
    );
    let _ = window.eval(&js);

    // 引导页里没法点链接（壳拦了外部导航），所以再弹一个系统框：
    // 「是」直接用系统浏览器打开下载页，这是用户此刻唯一能自救的出口。
    crate::sidecar::show_fatal(message);
}

fn progress(window: &WebviewWindow, percent: Option<f64>, text: &str) {
    let pct = match percent {
        Some(v) => format!("{}", (v * 100.0).round()),
        None => "-1".to_string(),
    };
    let js = format!(
        "window.bootstrapProgress && window.bootstrapProgress({pct}, {})",
        serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
    );
    let _ = window.eval(&js);
}

/// 下载 Java 安装包。优先 aria2c（多连接 + 多源自动切换），没有就退回 PowerShell。
fn download(window: &WebviewWindow, urls: &[&str], target: &Path) -> Result<(), String> {
    if let Some(exe) = crate::sidecar::aria2c_path() {
        match download_with_aria2(window, &exe, urls, target) {
            Ok(()) => return Ok(()),
            Err(e) => println!("[shell] aria2c 下载失败，改用系统下载：{e}"),
        }
    }
    download_with_powershell(window, urls, target)
}

/// aria2c 下载。多个 URL 作为同一个文件的镜像一次给它，它会自己挑快的、
/// 挂了自动换，比在 Rust 里轮换省事也更稳。
fn download_with_aria2(
    window: &WebviewWindow,
    exe: &Path,
    urls: &[&str],
    target: &Path,
) -> Result<(), String> {
    let dir = target.parent().ok_or("目标路径没有父目录")?;
    let name = target.file_name().ok_or("目标路径没有文件名")?;

    let mut cmd = Command::new(exe);
    cmd.args([
        // 每秒一行带换行的摘要；默认那个进度条是 \r 覆盖，读不出来
        "--summary-interval=1",
        "--console-log-level=notice",
        "--show-console-readout=false",
        "--file-allocation=none",
        "--max-connection-per-server=16",
        "--split=16",
        "--min-split-size=1M",
        "--continue=true",
        // 引导页没有暂停按钮，但用户可能直接关窗口 —— 留着控制文件才能下次续传
        "--disk-cache=0",
        "--auto-save-interval=1",
        "--auto-file-renaming=false",
        "--allow-overwrite=true",
        "--max-tries=3",
        "--retry-wait=2",
        "--connect-timeout=15",
        "--timeout=30",
        "--user-agent=HopeStar-MCLab",
    ])
    .arg(format!("--dir={}", dir.display()))
    .arg(format!("--out={}", name.to_string_lossy()))
    .args(urls)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .creation_flags_no_window();

    let mut child = cmd.spawn().map_err(|e| format!("起不来 aria2c：{e}"))?;
    let stdout = child.stdout.take().ok_or("拿不到 aria2c 输出")?;

    let mut reported = 0u32;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some((pct, speed)) = parse_progress(&line) {
            // 下载占 0–90%，留 10% 给解压
            let scaled = (pct as f64) * 0.9;
            let bucket = (scaled * 100.0) as u32;
            if bucket > reported {
                reported = bucket;
                let text = if speed.is_empty() {
                    format!("正在下载 Java 21… {}%", pct)
                } else {
                    format!("正在下载 Java 21… {}% · {}/s", pct, speed)
                };
                progress(window, Some(scaled), &text);
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("aria2c 退出码 {:?}", status.code()));
    }
    Ok(())
}

/// 从 aria2 的进度行里取百分比和速度：
/// `[#446a7e 2.0MiB/6.0MiB(34%) CN:16 DL:1.0MiB ETA:3s]`
fn parse_progress(line: &str) -> Option<(u32, String)> {
    let open = line.find('(')?;
    let rest = &line[open + 1..];
    let close = rest.find("%)")?;
    let pct: u32 = rest[..close].trim().parse().ok()?;
    let speed = line
        .split("DL:")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .unwrap_or("")
        .to_string();
    Some((pct, speed))
}

/// 兜底：系统 PowerShell + .NET 的 HttpWebRequest，单连接但能拿到进度。
/// 只在 aria2c 缺失或起不来的时候走这里。
fn download_with_powershell(
    window: &WebviewWindow,
    urls: &[&str],
    target: &Path,
) -> Result<(), String> {
    let mut last_err = String::new();
    for (i, url) in urls.iter().enumerate() {
        if i > 0 {
            progress(window, Some(0.0), "换一个下载源重试…");
        }
        match powershell_download(window, url, target) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn powershell_download(window: &WebviewWindow, url: &str, target: &Path) -> Result<(), String> {
    let script = work_dir_script(target)?;
    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script.to_str().ok_or("路径不是 UTF-8")?,
            "-Url",
            url,
            "-Path",
            target.to_str().ok_or("路径不是 UTF-8")?,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_no_window()
        .spawn()
        .map_err(|e| format!("起不来 PowerShell：{e}"))?;

    let stdout = child.stdout.take().ok_or("拿不到 PowerShell 输出")?;
    let mut reported = 0u32;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        // 协议：每行 `已下载|总大小`
        let mut parts = line.trim().split('|');
        let read: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let total: u64 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        if total == 0 {
            continue;
        }
        let pct = (read as f64 / total as f64) * 0.9;
        // 每 1% 推一次就够，推太密 eval 反而卡
        let bucket = (pct * 100.0) as u32;
        if bucket > reported {
            reported = bucket;
            progress(window, Some(pct), &format!("正在下载 Java 21… {}%", bucket));
        }
    }

    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&script);
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        let brief = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        return Err(if brief.is_empty() { "PowerShell 返回失败".into() } else { brief.to_string() });
    }
    Ok(())
}

/// 生成下载脚本。写成文件而不是 `-Command`：脚本里有引号、循环和大括号，
/// 走命令行得转义到崩溃。
fn work_dir_script(_target: &Path) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir();
    let path = dir.join("hopestar-java-bootstrap.ps1");
    // 带 BOM 写：Windows PowerShell 5 没有 BOM 时会按 ANSI 解析，中文注释就乱了
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(SCRIPT.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| format!("写下载脚本失败：{e}"))?;
    Ok(path)
}

const SCRIPT: &str = r#"
param([string]$Url, [string]$Path)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$req = [Net.HttpWebRequest]::Create($Url)
$req.UserAgent = 'HopeStar-MCLab'
$req.AllowAutoRedirect = $true
$req.Timeout = 60000
$resp = $req.GetResponse()
$total = $resp.ContentLength
$in = $resp.GetResponseStream()
$out = [IO.File]::Create($Path)
$buf = New-Object byte[] 65536
$read = 0
try {
  while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
    $out.Write($buf, 0, $n)
    $read += $n
    [Console]::Out.WriteLine("$read|$total")
    [Console]::Out.Flush()
  }
} finally {
  $out.Close()
  $in.Close()
  $resp.Close()
}
"#;

/// 解压 zip。优先用系统 bsdtar（Win10 1803+ 自带，能直接吃 zip）
fn extract_zip(zip: &Path, dest: &Path) -> Result<(), String> {
    let tar = PathBuf::from(r"C:\Windows\System32\tar.exe");
    if tar.is_file() {
        let out = Command::new(&tar)
            .arg("-xf")
            .arg(zip)
            .arg("-C")
            .arg(dest)
            .creation_flags_no_window()
            .output()
            .map_err(|e| format!("调用 tar.exe 失败：{e}"))?;
        if out.status.success() {
            return Ok(());
        }
        return Err(format!(
            "解压失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Err("系统里没有 tar.exe（需要 Windows 10 1803 或更高）".to_string())
}

/// 目录下恰好只有一个子目录时返回它
fn single_dir(root: &Path) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    let mut files = 0;
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else {
            files += 1;
        }
    }
    if dirs.len() == 1 && files == 0 {
        Some(dirs.remove(0))
    } else {
        None
    }
}

/// 不弹黑窗（PowerShell 跑起来会闪一个控制台）
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    #[cfg(windows)]
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x08000000) // CREATE_NO_WINDOW
    }

    #[cfg(not(windows))]
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}
