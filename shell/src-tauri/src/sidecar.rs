//! Java 核心（sidecar）的启动与生命周期管理。
//!
//! 壳和核心是两个进程，靠 127.0.0.1 的 HTTP 说话。这里负责三件事：
//! 1. 生成一次性 token，传给两边做鉴权
//! 2. 拉起 `java -Dhmcl.web.http=true -jar data/HopeStar-MCLab.jar`，等它把端口写出来
//! 3. 窗口关闭时把进程收干净，不留孤儿

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// 端口回传文件，和 Java 侧 `WebHttpServer.PORT_FILE_NAME` 保持一致
const PORT_FILE_NAME: &str = "hmcl-web-ui.port";

/// 核心 jar 的文件名。发布包里叫这个，不沿用上游的 HMCL.jar
const CORE_JAR_NAME: &str = "HopeStar-MCLab.jar";

/// 启动器数据目录名（配置、日志、缓存、核心 jar、JavaFX 都在里面）
const DATA_DIR_NAME: &str = "data";

/// 旧布局的配置目录名，只在迁移时用到
const LEGACY_DATA_DIR_NAME: &str = ".hmcl";

/// Java 启动 + 配置初始化 + Mojang 探测，给足时间。冷启动实测 3–6 秒
const START_TIMEOUT: Duration = Duration::from_secs(90);

pub struct Core {
    child: Child,
    pub port: u16,
    pub token: String,
    pub java: PathBuf,
    pub jar: PathBuf,
}

impl Drop for Core {
    fn drop(&mut self) {
        // 先礼后兵：正常情况下窗口关闭时已经通过 /api/quit 让 Java 自己退了
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// 发行版的目录约定：
///
/// ```text
/// HopeStar-MCLab/
/// ├── HopeStar-MCLab.exe
/// ├── runtime/            jlink 精简运行时
/// ├── .minecraft/         游戏目录
/// └── data/               启动器自己的东西全在这儿
///     ├── HopeStar-MCLab.jar
///     ├── javafx/
///     └── config/ logs/ state/ cache/ …
/// ```
///
/// `.minecraft` 留在根目录（不是 data 里）：Java 侧的游戏目录是相对路径
/// `.minecraft`，按 JVM 的 CWD 解析，而 CWD 就是这里的 `root`。
struct Layout {
    /// exe 所在目录（打包后）或 jar 所在目录（开发时）。同时是 JVM 的 CWD。
    root: PathBuf,
    /// 启动器数据目录。`-Dhmcl.dir` 和 `HMCL_USER_HOME` 都指这儿。
    data: PathBuf,
}

fn layout(jar: &Path, exe_dir: &Path, dev: bool) -> Layout {
    // 开发构建（exe 在 target/ 下）跟着 jar 走，否则每次重建都要重新登录；
    // 打包后数据跟着启动器走，整个目录可以拷到 U 盘上带走。
    let root = if dev {
        jar.parent().unwrap_or(exe_dir).to_path_buf()
    } else {
        exe_dir.to_path_buf()
    };
    Layout {
        data: root.join(DATA_DIR_NAME),
        root,
    }
}

/// 老版本把配置直接放在 `.hmcl/`，新布局收进 `data/`。
///
/// 只在「新目录里还没有 config、旧目录里有」时迁移，两种情况都安全：
/// - 全新解压：没有 `.hmcl`，什么都不做；
/// - 覆盖升级：zip 只带来 `data/HopeStar-MCLab.jar` 和 `data/javafx`，
///   旧配置被搬进 `data/`，账号、皮肤站、游戏设置都不用重新弄。
///
/// 迁移失败不阻断启动（最坏就是回到未登录状态），但每条失败都打日志。
fn migrate_legacy(legacy: &Path, data: &Path) {
    if data.join("config").is_dir() || !legacy.join("config").is_dir() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(data) {
        eprintln!("[core] 迁移：建不了 {}（{e}）", data.display());
        return;
    }
    let Ok(entries) = std::fs::read_dir(legacy) else {
        return;
    };
    for entry in entries.flatten() {
        let target = data.join(entry.file_name());
        // data 里已经有的（zip 自带的 jar / javafx）保持原样
        if target.exists() {
            continue;
        }
        if let Err(e) = std::fs::rename(entry.path(), &target) {
            eprintln!("[core] 迁移失败：{}（{e}）", entry.path().display());
        }
    }
    // 空了才删得掉；还有东西就留着，用户自己清
    let _ = std::fs::remove_dir(legacy);
    rewrite_legacy_paths(&data.join("config"), legacy, data);
    eprintln!(
        "[core] 配置已从 {} 迁移到 {}",
        legacy.display(),
        data.display()
    );
}

/// 把配置里写死的旧绝对路径改到新位置。
///
/// 离线账号的本地皮肤/披风存的是绝对路径（`localSkinPath`），文件搬了、路径没改的话
/// 每次启动都会抛一次 NoSuchFileException，表现就是「皮肤没了」。
/// 只扫 `config/*.json`，只替换以旧目录开头的字符串，别的地方一个字节都不动。
fn rewrite_legacy_paths(config_dir: &Path, legacy: &Path, data: &Path) {
    let Ok(entries) = std::fs::read_dir(config_dir) else {
        return;
    };
    // JSON 里反斜杠是转义的（E:\\MCLab\\…），两种写法都要试
    let from_raw = legacy.to_string_lossy().to_string();
    let to_raw = data.to_string_lossy().to_string();
    let from_json = from_raw.replace('\\', "\\\\");
    let to_json = to_raw.replace('\\', "\\\\");

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let replaced = text.replace(&from_json, &to_json).replace(&from_raw, &to_raw);
        if replaced == text {
            continue;
        }
        // 原子替换：先写临时文件再改名，中途断电不会留下半个 JSON
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, replaced).is_ok() && std::fs::rename(&tmp, &path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        eprintln!("[core] 已改写配置里的旧路径：{}", path.display());
    }
}

pub fn spawn() -> Result<Core, String> {
    let token = random_token();
    let port_file = std::env::temp_dir().join(PORT_FILE_NAME);
    // 清掉上一个实例可能留下的端口，避免读到过期值
    let _ = std::fs::remove_file(&port_file);

    let jar = locate_jar()?;
    let java = locate_java()?;
    let javafx = locate_javafx()?;

    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("取不到 exe 路径: {e}"))?
        .parent()
        .ok_or("exe 没有父目录")?
        .to_path_buf();
    // 路径里带 target 组件 = 开发构建（target/debug、target/release）
    let dev = exe_dir.components().any(|c| c.as_os_str() == "target");
    let layout = layout(&jar, &exe_dir, dev);

    migrate_legacy(&exe_dir.join(LEGACY_DATA_DIR_NAME), &layout.data);
    std::fs::create_dir_all(&layout.data)
        .map_err(|e| format!("建不了数据目录 {}: {e}", layout.data.display()))?;

    eprintln!(
        "[core] java={}\n[core] jar={}\n[core] javafx={}\n[core] data={}\n[core] cwd={}",
        java.display(),
        jar.display(),
        javafx.display(),
        layout.data.display(),
        layout.root.display()
    );

    let mut cmd = Command::new(&java);

    // 便携模式：把「用户级」数据也收进同一个目录。
    // 账号、皮肤、皮肤站列表默认落在 %APPDATA%\.hmcl（HMCL_USER_HOME），
    // 那样把程序拷到别的机器上这些就带不走。开发构建保持原样——
    // 否则每次重建都要重新登录一遍。
    if !dev {
        cmd.env("HMCL_USER_HOME", &layout.data);
    }

    let mut child = cmd
        // JavaFX 不在 JDK 里（Oracle JDK 11 起移除），必须走 module-path。
        // 不给的话 HMCL 会自己下载，实测被镜像回了错误的包，SHA-1 校验失败。
        .arg("--module-path")
        .arg(&javafx)
        .arg("--add-modules")
        .arg("javafx.web")
        .arg("-Dhmcl.web.http=true")
        .arg("-Dhmcl.web.http.port=0")
        // shadowJar 会剥掉签名，完整性自检必然失败并写一堆 ERROR 日志。
        // 壳自己控制核心 jar 的来源，这条校验在这里没有意义。
        .arg("-Dhmcl.self_integrity_check.disable=true")
        .arg(format!("-Dhmcl.web.token={}", token))
        // 把自己的 pid 交给核心：壳被强杀（任务管理器 / 崩溃）时 on_window_event
        // 跑不到，核心靠这个 pid 判断「壳还在不在」，不在就自己退。
        .arg(format!("-Dhmcl.web.parent={}", std::process::id()))
        // 本地配置目录（config/、state/、logs/、cache/…）
        .arg(format!("-Dhmcl.dir={}", layout.data.display()))
        // 不要加 -Dprism.order=sw：软件管线画不出 SkinCanvas 的 3D 内容
        // （实测 snapshot 出全透明空图）。核心虽然不出窗口，但 3D 渲染还是要 D3D。
        .arg("-jar")
        .arg(&jar)
        // CWD 决定 `.minecraft` 落在哪儿：根目录（exe 同级），不是 data 里
        .current_dir(&layout.root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("无法启动 Java 核心（{}）: {}", java.display(), e))?;

    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            return Err(format!("核心 {} 秒内没有报告端口，已终止", START_TIMEOUT.as_secs()));
        }

        // 进程提前死了，别等满超时
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("核心启动后立即退出: {:?}", status));
        }

        if let Ok(text) = std::fs::read_to_string(&port_file) {
            if let Ok(port) = text.trim().parse::<u16>() {
                if port > 0 {
                    return Ok(Core { child, port, token, java, jar });
                }
            }
        }

        std::thread::sleep(Duration::from_millis(120));
    }
}

impl Core {
    /// 请求核心正常退出（保存配置、释放单例锁），失败就直接杀
    pub fn shutdown(&mut self) {
        // 不用 HTTP 客户端库，这里只需要一次 POST + 把响应读掉。
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.port)).map(|mut s| {
            use std::io::{Read, Write};
            let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = write!(
                s,
                "POST /api/quit HTTP/1.1\r\nHost: 127.0.0.1\r\nX-HMCL-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                self.token
            );
            let _ = s.flush();
            // 必须把响应读掉再关：直接断开会让对端写响应时抛异常，
            // 而那一侧的退出逻辑曾经就排在写响应之后（于是永远走不到）。
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf);
        });
        // 给足退出清理时间：日志要压缩成 xz，大日志十几秒很正常
        let until = Instant::now() + Duration::from_secs(15);
        while Instant::now() < until {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(80));
        }
    }
}

/// 开发时找 `dist/HopeStar-MCLab.jar`，打包后找 `data/` 里的
fn locate_jar() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var("HOPESTAR_CORE_JAR") {
        candidates.push(PathBuf::from(p));
    }

    // 打包后布局：exe + data/HopeStar-MCLab.jar
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(DATA_DIR_NAME).join(CORE_JAR_NAME));
            // 兼容早期把 jar 直接摆在根目录的包
            candidates.push(dir.join(CORE_JAR_NAME));
        }
    }

    // 开发时：shell/src-tauri -> shell -> MCLab/dist
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("..").join("..").join("dist").join(CORE_JAR_NAME));

    for c in &candidates {
        if c.is_file() {
            return Ok(canonical(c));
        }
    }

    Err(format!(
        "找不到 {}，试过这些位置：\n{}",
        CORE_JAR_NAME,
        candidates.iter().map(|p| format!("  {}", p.display())).collect::<Vec<_>>().join("\n")
    ))
}

/// 优先用随包分发的 JDK，其次 JAVA_HOME，最后 PATH
fn locate_java() -> Result<PathBuf, String> {
    let javabin = if cfg!(windows) { "java.exe" } else { "java" };
    let mut tried: Vec<String> = Vec::new();

    if let Ok(p) = std::env::var("HOPESTAR_JAVA") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        tried.push(format!("HOPESTAR_JAVA={}", p.display()));
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    // 打包后：exe 同目录的 runtime/ 或 jre/
    if let Ok(self_exe) = std::env::current_exe() {
        if let Some(dir) = self_exe.parent() {
            candidates.push(dir.join("runtime").join("bin").join(javabin));
            candidates.push(dir.join("jre").join("bin").join(javabin));
        }
    }

    // 开发时：项目自带 JDK
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("..").join("..").join("env").join("jdk").join("bin").join(javabin));

    if let Ok(home) = std::env::var("JAVA_HOME") {
        candidates.push(PathBuf::from(home).join("bin").join(javabin));
    }

    for c in &candidates {
        if c.is_file() {
            return Ok(canonical(c));
        }
        tried.push(c.display().to_string());
    }

    // 最后交给 PATH
    if Command::new(javabin).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok() {
        return Ok(PathBuf::from(javabin));
    }
    tried.push(format!("PATH 里的 {}", javabin));

    Err(format!("找不到 Java 运行时，试过：\n{}", tried.join("\n")))
}

/// JavaFX 模块目录（含 javafx-*-21.x-win.jar 的文件夹）
fn locate_javafx() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(p) = std::env::var("HOPESTAR_JAVAFX_LIB") {
        candidates.push(PathBuf::from(p));
    }

    if let Ok(self_exe) = std::env::current_exe() {
        if let Some(dir) = self_exe.parent() {
            // 打包后：data/javafx（兼容早期放在根目录的包）
            candidates.push(dir.join(DATA_DIR_NAME).join("javafx"));
            candidates.push(dir.join("javafx"));
            candidates.push(dir.join("lib"));
        }
    }

    // 开发时：项目根的 webui-shell/lib
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest.join("..").join("..").join("webui-shell").join("lib"));

    for c in &candidates {
        if c.is_dir() {
            // 确认目录里真有 JavaFX 的 jar，别把空目录当成功
            if let Ok(entries) = std::fs::read_dir(c) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if name.starts_with("javafx-base") && name.ends_with(".jar") {
                        return Ok(canonical(c));
                    }
                }
            }
        }
    }

    Err(format!(
        "找不到 JavaFX 模块目录（需要含 javafx-base-*.jar），试过：\n{}",
        candidates.iter().map(|p| format!("  {}", p.display())).collect::<Vec<_>>().join("\n")
    ))
}

/// Windows 上 `fs::canonicalize` 会返回 `\\?\E:\...` 这种 UNC 扩展路径，
/// Java 的 `-jar` / `--module-path` 不认这个前缀，直接当无效路径处理，
/// 表现就是「找不到主类」。所以这里只做轻量规范化，不加前缀。
fn canonical(p: &PathBuf) -> PathBuf {
    p.components().collect()
}

/// token 不引额外依赖：时间戳和 pid 混一下走 xorshift。
/// 用途只是防止同机其它进程随口调 bridge，不需要密码学强度。
fn random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut x = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
        ^ ((std::process::id() as u64) << 32);

    const HEX: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(32);
    for _ in 0..32 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.push(HEX[(x & 0xf) as usize] as char);
    }
    out
}
