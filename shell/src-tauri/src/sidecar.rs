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
    /// 界面语言，拼页面 URL 时带上（前端据此加载 i18n/<lang>.json）
    pub lang: String,
}

/// 问核心当前界面语言。
///
/// 就一次本地 HTTP，拿不到就按简体走 —— 最坏结果是界面显示中文，
/// 不该为了它拖慢启动或者报错。
fn fetch_language(port: u16, token: &str) -> Option<String> {
    use std::io::{Read, Write};

    let mut stream = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(500),
    )
    .ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!(
        "POST /api/webLanguage HTTP/1.1\r\nHost: 127.0.0.1\r\nX-HMCL-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;

    // 响应形如 {"ok":true,"data":"zh-Hans"}，把 data 那段抠出来就够
    let idx = buf.find("\"data\":")?;
    let rest = &buf[idx + 7..];
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')? + start;
    let lang = rest[start..end].trim().to_string();
    if lang.is_empty() {
        None
    } else {
        Some(lang)
    }
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

    // 发行版不能弹黑窗：GUI 程序里用 java.exe 起子进程会新建一个控制台窗口，
    // 用户看到的就是「双击启动器先蹦出一屏日志」。优先换同目录的 javaw.exe
    // （同一条代码，GUI 子系统入口，不建控制台）。
    #[cfg(windows)]
    let java = {
        let javaw = java.with_file_name("javaw.exe");
        if javaw.is_file() { javaw } else { java }
    };

    let mut cmd = Command::new(&java);

    // 壳是 GUI 程序，没有控制台可继承；日志改成落文件，
    // 出问题时让用户把 data/logs/core.log 发过来就行。
    let core_log = {
        let dir = layout.data.join("logs");
        let _ = std::fs::create_dir_all(&dir);
        std::fs::File::create(dir.join("core.log")).ok()
    };
    let (core_out, core_err) = match core_log {
        Some(f) => (
            Stdio::from(f.try_clone().expect("clone core log")),
            Stdio::from(f),
        ),
        None => (Stdio::null(), Stdio::null()),
    };

    // 双保险：万一没有 javaw（极端精简的运行时），也不让它建控制台
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // 便携模式：把「用户级」数据也收进同一个目录。
    // 账号、皮肤、皮肤站列表默认落在 %APPDATA%\.hmcl（HMCL_USER_HOME），
    // 那样把程序拷到别的机器上这些就带不走。开发构建保持原样——
    // 否则每次重建都要重新登录一遍。
    if !dev {
        cmd.env("HMCL_USER_HOME", &layout.data);
    }

    let core_started = Instant::now();
    // 类数据共享：让 JVM 直接 mmap 一份预先算好的类元数据，省掉每次冷启动
    // 那两千多次类加载。实测核心从 fork 到报端口 2.5s → 1.3s。
    let cds = cds_args(&java, &jar, &layout.data.join("cache"));
    if let Some(first) = cds.first() {
        crate::boot_log(&format!("AppCDS: {}", first));
    }

    let mut child = cmd
        // JavaFX 不在 JDK 里（Oracle JDK 11 起移除），必须走 module-path。
        // 不给的话 HMCL 会自己下载，实测被镜像回了错误的包，SHA-1 校验失败。
        //
        // 只要 controls（含 base / graphics 传递依赖）。不要 web 也不要 media：
        // - web：壳模式下页面是 WebView2 渲染的，那个 36 MB 的 jfxwebkit
        //   一次都用不上，带上等于白送三分钟下载时间；
        // - media：整个工程没有一处 javafx.scene.media 引用。
        // 堆上限必须显式给。JVM 默认取物理内存的 1/4 —— 8G 机器上就是 2G，
        // 而启动器稳态只用两三百兆，剩下的全被算进工作集，任务管理器里
        // 就是一个启动器吃 1G 的观感。640m 对 JavaFX + 模组扫描够用，
        // 真正跑游戏时游戏有自己的 JVM，和这里无关。
        .arg("-Xms128m")
        .arg("-Xmx512m")
        // 串行 GC：启动器是「点一下、看一眼」的交互式负载，不是吞吐型服务。
        // G1 会额外开一组 GC 线程，每个线程都要栈和本地内存，常驻下来
        // 就是几百兆的底噪。SerialGC 单线程回收，对这个场景完全够。
        .arg("-XX:+UseSerialGC")
        // 元空间也设上限：默认不封顶，加载的类和反射代理多了会一路涨
        .arg("-XX:MaxMetaspaceSize=128m")
        // 线程栈收一档：默认 1M，启动器线程不少（HTTP、任务池、JavaFX）
        .arg("-Xss512k")
        // JavaFX 的渲染脉冲默认 60fps。Web 模式下 JavaFX 窗口是隐藏的，
        // 没人看它的画面，但脉冲照旧每秒触发 60 次，QuantumRenderer 和
        // JavaFX Application Thread 加起来能吃掉单核 10% 以上。
        // 降到 1fps：界面全在 WebView 里，JavaFX 这一侧不需要流畅度。
        .arg("-Djavafx.animation.pulse=1")
        // JavaFX 给那个隐藏窗口建了 D3D 交换链，Present 每帧都在等垂直同步。
        // 关掉 vsync 等待，至少不再被 60Hz 节流空转。
        .arg("-Dprism.vsync=false")
        // 隐藏窗口用软件管线：D3D 那条路要给交换链分配纹理和后台缓冲，
        // 窗口明明看不见，这些显存/内存纯属白占。软件管线在没有实际绘制时
        // 几乎不消耗，正好契合「JavaFX 只当壳、界面全在 WebView」的用法。
        .arg("-Dprism.order=sw")
        .arg("--module-path")
        .arg(&javafx)
        .arg("--add-modules")
        .arg("javafx.controls")
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
        // 必须在 -jar 之前：这两条是给 JVM 的，不是给应用的
        .args(&cds)
        // 不要加 -Dprism.order=sw：软件管线画不出 SkinCanvas 的 3D 内容
        // （实测 snapshot 出全透明空图）。核心虽然不出窗口，但 3D 渲染还是要 D3D。
        .arg("-jar")
        .arg(&jar)
        // CWD 决定 `.minecraft` 落在哪儿：根目录（exe 同级），不是 data 里
        .current_dir(&layout.root)
        .stdout(core_out)
        .stderr(core_err)
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
                    crate::boot_log(&format!(
                        "核心从 fork 到报端口 {}ms",
                        core_started.elapsed().as_millis()
                    ));
                    let lang = fetch_language(port, &token).unwrap_or_else(|| "zh-Hans".to_string());
                    crate::boot_log(&format!("界面语言 {lang}"));
                    return Ok(Core { child, port, token, java, jar, lang });
                }
            }
        }

        // 40ms 而不是原来的一百多：这一步决定端口就绪到窗口出现之间还压着多久，
        // 平均白等半轮。轮询本身只是读一个几十字节的文件，频率高一点没有代价。
        std::thread::sleep(Duration::from_millis(40));
    }
}

/// AppCDS 参数：让 JVM 直接 mmap 一份预先算好的类元数据，省掉每次冷启动
/// 那两千多次类加载和校验。实测核心从 fork 到报端口 2.5s → 1.3s。
///
/// 归档跟 jar 一对一（文件名里带 jar 的大小和修改时间），热更新换了 jar
/// 就自动换一份新的，不会拿旧归档去配新代码。
fn cds_args(java: &Path, jar: &Path, cache: &Path) -> Vec<String> {
    // SharedArchiveFile / ArchiveClassesAtExit 是 HotSpot 的参数。
    // OpenJ9 之类根本不认，加了会直接起不来——宁可不加速，也不能起不来。
    if !is_hotspot_vm(java) {
        crate::boot_log("AppCDS 未启用：不是 HotSpot 系 VM");
        return Vec::new();
    }
    // 动态 CDS 必须踩在基础归档上。jlink 裁出来的 runtime 默认不带
    // （lib/bin 下的 server/classes.jsa），少了它 JVM 只会警告一句
    // "ArchiveClassesAtExit is unsupported when base CDS archive is not loaded"，
    // 然后什么也不做 —— 每次启动白跑一趟。
    if !has_base_archive(java) {
        crate::boot_log("AppCDS 未启用：这份 runtime 没有基础 CDS 归档");
        return Vec::new();
    }
    let Some(tag) = jar_tag(jar) else { return Vec::new() };
    let _ = std::fs::create_dir_all(cache);

    let jsa = cache.join(format!("core-app-{tag}.jsa"));
    if std::fs::metadata(&jsa).map(|m| m.len() > 1024).unwrap_or(false) {
        return vec![
            format!("-XX:SharedArchiveFile={}", jsa.display()),
            // 归档对不上（换了 JDK、写到一半被打断）就安静地走默认路径，不报错
            "-Xshare:auto".to_string(),
        ];
    }

    // 还没有归档。顺手把上一个 jar 指纹留下的删掉——一份 35 MB，攒着没意义。
    if let Ok(entries) = std::fs::read_dir(cache) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("core-app-") && name.ends_with(".jsa") && entry.path() != jsa {
                remove_quietly(&entry.path());
            }
        }
    }

    // 这一次跑完、正常退出时让 JVM 把归档写出来，下一次起就是快的。
    // 用户强杀进程的话这次就白跑，下次还会再试一遍。
    vec![format!("-XX:ArchiveClassesAtExit={}", jsa.display())]
}

/// 这份 JDK/runtime 里有没有基础 CDS 归档。
///
/// `java` 本身就在 `<home>/bin/` 下：Windows 的基础归档在 `bin/server/classes.jsa`，
/// Linux 在 `lib/server/classes.jsa`。
fn has_base_archive(java: &Path) -> bool {
    let Some(bin) = java.parent() else { return false };
    if cfg!(windows) {
        bin.join("server").join("classes.jsa").is_file()
    } else {
        bin.parent()
            .map(|home| home.join("lib").join("server").join("classes.jsa").is_file())
            .unwrap_or(false)
    }
}

/// 判断这个 Java 是不是 HotSpot 系（Oracle / Temurin / Zulu / GraalVM 都是）。
///
/// 不能读 release 里的 JAVA_VM —— Oracle JDK 21 的 release 根本没有这一行。
/// 看 VM 本体更实在：HotSpot 是 `bin/server/jvm.dll`，OpenJ9 是 `bin/default/jvm.dll`。
fn is_hotspot_vm(java: &Path) -> bool {
    let Some(bin) = java.parent() else { return false };
    let vm = if cfg!(windows) { "jvm.dll" } else { "libjvm.so" };
    bin.join("server").join(vm).is_file()
}

/// 删文件，并且先把只读属性摘掉。
///
/// JVM 生成的 CDS 归档带只读位，Windows 上直接 remove_file 会被拒掉，
/// 结果就是每换一次 jar 在 cache 里多躺一份 35 MB。
fn remove_quietly(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perm = meta.permissions();
        if perm.readonly() {
            perm.set_readonly(false);
            let _ = std::fs::set_permissions(path, perm);
        }
    }
    let _ = std::fs::remove_file(path);
}

/// jar 的「指纹」：大小 + 修改时间。两者任一变了就是另一个文件。
fn jar_tag(jar: &Path) -> Option<String> {
    let meta = std::fs::metadata(jar).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("{:x}-{:x}", meta.len(), mtime.as_secs()))
}

impl Core {
    /// 直接掐掉核心，不给它保存配置的机会。
    ///
    /// 迁移导入之后要用：核心正常退出时会把它内存里的账号、游戏目录写回文件，
    /// 那正好把刚导进来的内容盖掉。杀了它，文件就保持我们写的样子。
    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

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

/// 启动器数据目录。bootstrap 要在这里落 runtime，而它跑在 Layout 之前，
/// 所以单独给一个：打包后就是 exe 旁边的 data/。
pub fn data_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(DATA_DIR_NAME)
}

/// 启动器自己需要的最低 Java 版本。
///
/// 发行版从 0.2 起不再内置 runtime，改为在系统里找；核心里有 JMOD/JavaFX 相关的
/// API 是 21 才有的，低于 21 直接起不来，所以这里先拦一道。
const MIN_JAVA_MAJOR: u32 = 21;

/// 找一个能用的 Java。返回 java(.exe) 的路径。
///
/// 顺序：
/// 1. `HOPESTAR_JAVA`（给自己/调试留的后门）
/// 2. exe 同目录的 `runtime/` `jre/`（想继续用绿色版的人把运行时装回去仍然优先）
/// 3. 启动器自己下载的 `data/java/**`
/// 4. `JAVA_HOME`
/// 5. Windows 上常见的 JDK/JRE 安装目录（Program Files 各家发行版）
/// 6. PATH
///
/// 挑版本的规则是「**21 优先**，其次比 21 大的里面最小的」：
/// 核心里带的 JavaFX 是 21 的模块，装到 25 上一般也能跑，但 21 最稳，
/// 所以不盲目挑最新的。
/// 包里自带的 aria2c（`data/bin/aria2c.exe`）。引导页下载 Java 用它。
///
/// 找不到就返回 None，调用方退回系统自带的下载方式 —— 后者单连接、
/// 而且在部分网络下会被挡（本机实测 .NET 的 HttpWebRequest 走不通）。
pub fn aria2c_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "aria2c.exe" } else { "aria2c" };

    let mut candidates = vec![data_dir().join("bin").join(name)];

    // 开发时：项目根下的 dist-package/release/data/bin
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(
            manifest
                .join("..")
                .join("..")
                .join("dist-package")
                .join("release")
                .join("data")
                .join("bin")
                .join(name),
        );
    }

    // 最后看 PATH（用户自己装过 aria2）
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.push(dir.join(name));
        }
    }

    candidates.into_iter().find(|p| p.is_file())
}

/// 上次找到的 Java 记在这儿，下次冷启动直接拿来用。
///
/// 不缓存就得每次把 Program Files 下十几家发行版翻一遍、再起一个 JVM 读版本，
/// 那是几百毫秒的纯等待，而结果 99% 跟上次一模一样。
fn java_cache_file() -> PathBuf {
    data_dir().join("cache").join("java-path.txt")
}

/// 读缓存。用「路径 + 文件大小 + 修改时间」验身份：
/// JDK 被卸载、升级、或者目录被换成别的东西，校验自然对不上，退回全量扫描。
fn read_java_cache() -> Option<PathBuf> {
    let text = std::fs::read_to_string(java_cache_file()).ok()?;
    let mut it = text.lines();
    let path = PathBuf::from(it.next()?);
    let size: u64 = it.next()?.trim().parse().ok()?;
    let mtime: u64 = it.next()?.trim().parse().ok()?;

    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() != size {
        return None;
    }
    let now = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    if now != mtime {
        return None;
    }
    Some(path)
}

fn write_java_cache(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else { return };
    let Some(mtime) = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    else {
        return;
    };
    let file = java_cache_file();
    let Some(dir) = file.parent() else { return };
    let _ = std::fs::create_dir_all(dir);
    // 先写临时文件再改名：写到一半断电不会留下一份半截缓存
    let tmp = file.with_extension("tmp");
    let body = format!("{}\n{}\n{}\n", path.display(), meta.len(), mtime.as_secs());
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, &file);
    }
}

pub fn locate_java() -> Result<PathBuf, String> {
    // 自检开关：想验证「没有 Java 时的引导流程」时设这个，让第一次查找失败。
    // 只失败一次——bootstrap 下完 data/runtime 之后，spawn() 那边的第二次查找
    // 要能正常找到，否则自检永远走不到头。
    {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // 前两次调用故意失败：一次给 main 的预判，一次给 bootstrap::ensure_java。
        // 第三次（下载完之后 spawn 那次）要能成功，否则自检走不到底。
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        if std::env::var("HOPESTAR_FORCE_BOOTSTRAP").is_ok() && CALLS.fetch_add(1, Ordering::SeqCst) < 2 {
            return Err("HOPESTAR_FORCE_BOOTSTRAP=1（自检用）".to_string());
        }
    }

    let started = Instant::now();
    let javabin = if cfg!(windows) { "java.exe" } else { "java" };
    let mut tried: Vec<String> = Vec::new();

    if let Ok(p) = std::env::var("HOPESTAR_JAVA") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(canonical(&p));
        }
        tried.push(format!("HOPESTAR_JAVA={}", p.display()));
    }

    if let Some(cached) = read_java_cache() {
        crate::boot_log(&format!(
            "Java 命中缓存 {} ({}ms)",
            cached.display(),
            started.elapsed().as_millis()
        ));
        return Ok(cached);
    }

    // 明确的候选：绿色版运行时装回来的时候仍然优先用
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(self_exe) = std::env::current_exe() {
        if let Some(dir) = self_exe.parent() {
            candidates.push(dir.join("runtime").join("bin").join(javabin));
            candidates.push(dir.join("jre").join("bin").join(javabin));
            // 首次启动时由 bootstrap.rs 下到 data/runtime 的那份
            candidates.push(dir.join(DATA_DIR_NAME).join("runtime").join("bin").join(javabin));
            // 启动器自己下载的：data/java/<os>-<arch>/<发行版>-<版本>/bin/java.exe
            scan_javas(&dir.join(DATA_DIR_NAME).join("java"), 3, javabin, &mut candidates);
        }
    }

    // 开发时：项目自带 JDK。只在 debug 构建里加 —— release 版不该把
    // 编译机的路径带进去，否则用户机器上万一撞了同名目录会选错
    #[cfg(debug_assertions)]
    {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        candidates.push(manifest.join("..").join("..").join("env").join("jdk").join("bin").join(javabin));
    }

    if let Ok(home) = std::env::var("JAVA_HOME") {
        candidates.push(PathBuf::from(home).join("bin").join(javabin));
    }

    // 各家发行版的默认安装位置。Windows 上装 JDK 基本都落在这几个地方，
    // 比翻注册表省事，也不会被残留的旧键值带偏。
    #[cfg(windows)]
    for root in windows_java_roots() {
        scan_javas(&root, 2, javabin, &mut candidates);
    }

    // 打分：21 最好，其次是 >21 里最小的。
    // 碰到 21 直接收工 —— 后面不可能有更好的，剩下那些 release 文件不用读了。
    let mut best: Option<(u32, PathBuf)> = None;
    for c in &candidates {
        if !c.is_file() {
            tried.push(c.display().to_string());
            continue;
        }
        match java_major(c) {
            Some(major) if major == MIN_JAVA_MAJOR => {
                let path = canonical(c);
                write_java_cache(&path);
                crate::boot_log(&format!(
                    "Java 扫描命中 21：{}（{}ms，看了 {} 个候选）",
                    path.display(),
                    started.elapsed().as_millis(),
                    candidates.len()
                ));
                return Ok(path);
            }
            Some(major) if major > MIN_JAVA_MAJOR => {
                if better_than(best.as_ref().map(|b| b.0), major) {
                    best = Some((major, canonical(c)));
                }
            }
            Some(major) => tried.push(format!("{} (Java {})", c.display(), major)),
            None => tried.push(format!("{} (读不出版本)", c.display())),
        }
    }

    // PATH 上的 java 要真跑一次 JVM 才知道版本，两百毫秒起。
    // 只有「手上还没有 21」时才值得花这个钱 —— 已经有 21 的话
    // 探测结果不可能被采用（better_than 对 21 永远返回 false）。
    let need_probe = match best.as_ref() {
        None => true,
        Some((major, _)) => *major != MIN_JAVA_MAJOR,
    };
    if need_probe && path_java_exists(javabin) {
        if let Some(major) = probe_path_java(javabin) {
            if major >= MIN_JAVA_MAJOR && better_than(best.as_ref().map(|b| b.0), major) {
                best = Some((major, PathBuf::from(javabin)));
            }
            if major < MIN_JAVA_MAJOR {
                tried.push(format!("PATH 里的 {} (Java {})", javabin, major));
            }
        }
    }

    if let Some((_, path)) = best {
        write_java_cache(&path);
        crate::boot_log(&format!(
            "Java 扫描命中 {}（{}ms）",
            path.display(),
            started.elapsed().as_millis()
        ));
        return Ok(path);
    }

    crate::boot_log(&format!(
        "Java 全盘扫描无结果（{}ms）",
        started.elapsed().as_millis()
    ));
    Err(format!(
        "没有找到 Java {MIN_JAVA_MAJOR} 或更高版本。\n\n\
         这个版本起启动器不再自带 Java，需要系统里装一个。\n\
         装完后重新打开启动器即可，不用重启电脑。\n\n\
         已检查过：\n{}",
        tried.join("\n")
    ))
}

/// PATH 里到底有没有 java。有才值得起一个进程去问版本。
fn path_java_exists(javabin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|dir| dir.join(javabin).is_file()))
        .unwrap_or(false)
}

/// 21 优先；否则取比 21 大的里面最小的
fn better_than(current: Option<u32>, major: u32) -> bool {
    match current {
        None => true,
        Some(cur) => {
            if cur == MIN_JAVA_MAJOR {
                return false; // 已经有 21 了，换别的都不划算
            }
            if major == MIN_JAVA_MAJOR {
                return true;
            }
            major < cur
        }
    }
}

/// 从 `<java home>/release` 里读主版本号（JDK 8 是 `1.8.0_xxx`）
fn java_major(java_exe: &std::path::Path) -> Option<u32> {
    let home = java_exe.parent()?.parent()?;
    let text = std::fs::read_to_string(home.join("release")).ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("JAVA_VERSION=") {
            let value = rest.trim().trim_matches('"');
            let first = value.split(['.', '-', '+']).next()?;
            if first == "1" {
                return value.split('.').nth(1)?.parse().ok();
            }
            return first.parse().ok();
        }
    }
    None
}

/// PATH 上的 java 没有 release 文件可读，跑一次 `-version` 解析 stderr。
/// 返回 None 表示 PATH 里没有可用的 java，或者它 2 秒都没吭声。
fn probe_path_java(javabin: &str) -> Option<u32> {
    let mut cmd = std::process::Command::new(javabin);
    cmd.arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    // java.exe 是控制台程序。壳是 GUI 程序、手上没有控制台，直接起子进程
    // Windows 会给它新建一个 —— 表现就是启动器一打开先闪一下黑窗。
    // CREATE_NO_WINDOW 只影响窗口，stderr 照旧能读。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().ok()?;

    // PATH 里的 "java.exe" 未必真是 JVM：可能是个包了一层壳的 shim，
    // 也可能在等某个不存在的配置。启动路径不能被人拖住，2 秒不走就杀掉当没有。
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => return None,
        }
        if Instant::now() > deadline {
            crate::boot_log("PATH 里的 java 2 秒没响应，跳过");
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(8));
    }

    let mut text = String::new();
    {
        use std::io::Read;
        child.stderr.take()?.read_to_string(&mut text).ok()?;
    }
    let line = text.lines().next()?;
    // openjdk version "21.0.12" 2025-07-15 / java version "1.8.0_411"
    let quoted = line.split('"').nth(1)?;
    let first = quoted.split(['.', '-', '+']).next()?;
    if first == "1" {
        quoted.split('.').nth(1)?.parse().ok()
    } else {
        first.parse().ok()
    }
}

/// 递归找 `<dir>/bin/java.exe`，最多 depth 层
fn scan_javas(root: &std::path::Path, depth: usize, javabin: &str, out: &mut Vec<PathBuf>) {
    if depth == 0 || !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let exe = path.join("bin").join(javabin);
        if exe.is_file() {
            out.push(exe);
            continue;
        }
        scan_javas(&path, depth - 1, javabin, out);
    }
}

/// Windows 上各家 JDK 的默认安装根目录
#[cfg(windows)]
fn windows_java_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut bases: Vec<PathBuf> = vec![
        PathBuf::from(r"C:\Program Files"),
        PathBuf::from(r"C:\Program Files (x86)"),
    ];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        bases.push(PathBuf::from(local).join("Programs"));
    }
    // 只扫这些子目录：整个 Program Files 递归太慢
    const VENDORS: &[&str] = &[
        "Java",
        "Eclipse Adoptium",
        "Eclipse Foundation",
        "AdoptOpenJDK",
        "Microsoft",
        "Zulu",
        "Amazon Corretto",
        "BellSoft",
        "Semeru",
        "GraalVM",
        "JetBrains",
        "Common Files\\Oracle\\Java",
    ];
    for base in bases {
        for vendor in VENDORS {
            let dir = base.join(vendor);
            if dir.is_dir() {
                roots.push(dir);
            }
        }
    }
    roots
}

/// 弹一个系统消息框。release 版没有控制台，出错时用户只能看到这个。
#[cfg(windows)]
pub fn show_fatal(message: &str) {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: *mut core::ffi::c_void, text: *const u16, caption: *const u16, u_type: u32) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> *mut core::ffi::c_void;
    }

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    let text = wide(&format!("{message}\n\n要现在打开 Java 下载页吗？"));
    let caption = wide("HopeStar-MCLab 无法启动");
    // MB_YESNO(4) | MB_ICONERROR(0x10)
    let clicked = unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), 4 | 0x10)
    };
    if clicked == 6 {
        // IDYES：打开 Adoptium 的下载页（Eclipse Temurin）
        let op = wide("open");
        let url = wide("https://adoptium.net/temurin/releases/?os=windows&arch=x64&package=jdk");
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            );
        }
    }
}

/// 非 Windows 平台没有消息框，直接打到 stderr
#[cfg(not(windows))]
pub fn show_fatal(message: &str) {
    eprintln!("{message}");
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
