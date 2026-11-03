// 发布版不要控制台窗口；debug 版留着，方便看 Java 核心的输出
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bootstrap;
mod sidecar;
mod single_instance;

/// 浏览器行为屏蔽脚本，编译进二进制。
const GUARD_JS: &str = include_str!("guard.js");

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 进程启动时刻。冷启动分段计时都相对它。
pub(crate) static BOOT_AT: OnceLock<Instant> = OnceLock::new();

/// 第二个实例启动时要把已有窗口提到前台，这里留一份 AppHandle 给监听线程用。
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 主页（或引导页）真的画出来了没有。
///
/// 窗口是隐藏创建的，只有它变 true 之后才允许 display：
/// 否则单实例的「提到前台」会把这层空壳掀开给用户看。
static PAGE_READY: AtomicBool = AtomicBool::new(false);

/// 冷启动分段计时，追加到 `data/logs/boot.log`。
///
/// release 版没有控制台，双击之后「慢」还是「卡住了」只能靠这份日志区分：
/// 每行一个阶段，看最后一行停在哪儿就知道卡在哪。超过 64 KB 自动清空。
pub(crate) fn boot_log(phase: &str) {
    use std::io::Write;

    let Some(t0) = BOOT_AT.get() else { return };
    let dir = sidecar::data_dir().join("logs");
    let path = dir.join("boot.log");
    let _ = std::fs::create_dir_all(&dir);
    if std::fs::metadata(&path).map(|m| m.len() > 64 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{:>6}ms] {}", t0.elapsed().as_millis(), phase);
    }
}

/// 把主窗口提到前台。由单实例守卫在检测到重复启动时调用，也可单独复用。
pub(crate) fn focus_main_window() {
    let Some(app) = APP_HANDLE.get() else { return };
    // 还在启动、窗口只是隐藏的空壳：这时候 show 出来没有任何意义
    if !PAGE_READY.load(Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

/// 让窗口真正露面。跳任务栏和隐藏都在这儿一起收拾掉。
fn reveal(window: &tauri::WebviewWindow) {
    let _ = window.set_skip_taskbar(false);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// 用当前页面的 origin 拼出目标页。
///
/// 不写死 `http://tauri.localhost`：不同平台上 Tauri 的自定义协议不一样，
/// 从窗口当前的 URL 推是最省事的办法。
fn navigate(window: &tauri::WebviewWindow, relative: &str) -> bool {
    let Ok(base) = window.url() else { return false };
    let Ok(target) = base.join(relative) else { return false };
    window.navigate(target).is_ok()
}

/// 兜底：万一导航没触发 on_page_load，窗口也不能永远藏着。
/// 用户看到的「双击没反应」比任何错误都糟。
fn reveal_fallback(window: &tauri::WebviewWindow, ms: u64) {
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ms));
        if !PAGE_READY.load(Ordering::SeqCst) {
            boot_log("兜底显示窗口（页面加载事件没到）");
            reveal(&window);
        }
    });
}

/// 核心进程握在 Tauri 的托管状态里，窗口销毁时统一收
struct ShellState {
    core: Mutex<Option<sidecar::Core>>,
    /// 窗口已经销毁。核心还在启动时被关窗，后台线程靠这个把进程收掉，
    /// 不然 javaw 会一个人留在后台占着内存。
    closed: AtomicBool,
    /// 单实例守卫。存着只为不让端口释放；窗口关了进程也就退了。
    _single: single_instance::SingleInstance,
}

/// 把起好的核心交给托管状态。
///
/// 交接和「窗口已销毁」共用一把锁：否则刚好在检查完 closed 之后窗口关掉，
/// 核心就没人收了。
fn hand_over(app: &tauri::AppHandle, core: sidecar::Core) {
    let Some(state) = app.try_state::<ShellState>() else {
        let mut core = core;
        core.shutdown();
        return;
    };
    let mut guard = state.core.lock().unwrap_or_else(|e| e.into_inner());
    if state.closed.load(Ordering::SeqCst) {
        drop(guard);
        std::thread::spawn(move || {
            let mut core = core;
            core.shutdown()
        });
    } else {
        *guard = Some(core);
    }
}

/// 清掉 WebView2 的浏览器缓存。
///
/// 这套东西归 Chromium 自己管，落在 `%LOCALAPPDATA%\<identifier>\EBWebView`，
/// 和启动器目录不在一起 —— 绿色版整个拷走之后它仍然占着系统盘。
/// 实测用两周能堆到 111 MB，其中能安全删的是 Cache / Code Cache / GPUCache 这些。
/// WidevineCdm、component_crx_cache 属于 Chromium 组件，删了它会自己下回来，不动。
///
/// 运行中的 WebView 会锁住一部分文件，删不掉的跳过就行，剩下的下次再清。
#[tauri::command]
fn clean_webview_cache(app: tauri::AppHandle) -> Result<u64, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("找不到缓存目录: {e}"))?
        .join("EBWebView");
    if !root.is_dir() {
        return Ok(0);
    }

    const TARGETS: &[&str] = &[
        "Default/Cache",
        "Default/Code Cache",
        "Default/GPUCache",
        "Default/DawnGraphiteCache",
        "Default/DawnWebGPUCache",
        "GPUCache",
        "GrShaderCache",
        "ShaderCache",
    ];

    let mut freed = 0u64;
    for rel in TARGETS {
        purge_dir(&root.join(rel), &mut freed);
    }
    Ok(freed)
}

/// 逐个文件删，删不掉就跳过：WebView 还开着的时候有一半文件是锁着的。
fn purge_dir(dir: &std::path::Path, freed: &mut u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            purge_dir(&path, freed);
            let _ = std::fs::remove_dir(&path);
        } else if std::fs::remove_file(&path).is_ok() {
            *freed += meta.len();
        }
    }
}

/// 重启启动器。
///
/// 先杀核心：核心正常退出时会把它内存里的账号和游戏目录写回文件，正好盖掉
/// 刚导入的那份。掐掉它，文件就保持我们写好的样子。
///
/// 新进程带着 `HOPESTAR_RESTARTING=1` 起来，它会在开头先等一会儿再抢单例端口
/// —— 不等的话会撞上还在退出的旧实例，判定「已有实例在跑」然后自己退出。
#[cfg(windows)]
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        let mut guard = state.core.lock().unwrap_or_else(|e| e.into_inner());
        state.closed.store(true, Ordering::SeqCst);
        if let Some(mut core) = guard.take() {
            core.kill();
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        // 直接起，不要开线程延迟：app.exit 会把线程一起带走
        let _ = std::process::Command::new(exe)
            .env("HOPESTAR_RESTARTING", "1")
            .spawn();
    }
    app.exit(0);
}

fn main() {
    // 重启过来的实例：旧进程要先杀核心、关窗口才真正退出，
    // 这段时间里单例端口还被它占着。等它放开再继续，否则自己会把自己当成"双开"退出。
    if std::env::var("HOPESTAR_RESTARTING").is_ok() {
        std::thread::sleep(std::time::Duration::from_millis(700));
    }

    let _ = BOOT_AT.set(Instant::now());

    tauri::Builder::default()
        .setup(move |app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            boot_log("setup 进入");

            // 双开会共用同一份配置目录，写坏 config / 日志，必须先挡。
            let single = match single_instance::acquire() {
                Ok(Some(guard)) => guard,
                Ok(None) => {
                    // 已有实例在跑：刚才那一 ping 已经让对方把窗口提到前台了。
                    boot_log("已有实例在运行，本次启动退出");
                    std::process::exit(0);
                }
                Err(()) => {
                    // 端口被无关程序占着，不阻断用户，照常启动
                    boot_log("单实例端口被占用（非本程序），跳过检查");
                    // 拿不到 guard 就没有占位；这里用一个不占端口的空壳顶上
                    single_instance::SingleInstance::detached()
                }
            };
            boot_log("单实例检查完成");

            // 窗口先建出来、但先不显示。
            //
            // 原来是把 locate_java + spawn 全跑完才 build 窗口，两段耗时是相加的：
            // 用户从双击到看见界面要等 3.5 秒以上。现在 WebView2 的初始化
            // 和 Java 核心的启动并行，谁慢等谁，总时间取两者的最大值。
            //
            // 窗口是隐藏的，所以用户看到的仍然是「双击 → 直接主界面」，
            // 中间不会出现任何启动页或过渡动画。
            //
            // 起始页先指 placeholder.html：核心端口还没出来，直接指 index.html
            // 会让页面先发一轮注定失败的请求，然后才被导航覆盖。
            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("placeholder.html".into()),
            )
            // 关掉浏览器行为（刷新、缩放、右键菜单、拖放导航、新窗口），
            // 让 WebView 只当渲染层用。脚本在页面脚本之前注入。
            .initialization_script(GUARD_JS)
            .title("HopeStar-MCLab")
            .inner_size(1280.0, 820.0)
            // 最小 880×620：再窄下载页的六列标签 + 工具栏就开始互相挤，
            // 外观页的 3D 预览也会被压得看不清。
            // 880 这个数是故意的——侧栏在 <900 时自动收成图标条，
            // 所以 880 反而比 900 多一些内容宽度。
            .min_inner_size(880.0, 620.0)
            // 标题栏由页面自绘（38px 顶栏），和 JavaFX 模式保持一致
            .decorations(false)
            .center()
            .visible(false)
            .skip_taskbar(true)
            // 顶层导航只允许留在本地页面。否则点到一个 a[href]、或者拖进来
            // 一个文件，整个应用就被导航顶掉了，而且再也回不来（没有后退按钮）。
            .on_navigation(|url| {
                url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri"
            })
            // 主页/引导页画完才把窗口放出来：show 的瞬间画面已经是内容，
            // 用户不会看到先白一下再出来。
            .on_page_load(|window, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished) {
                    return;
                }
                let path = payload.url().path();
                // placeholder.html 不算，它只是给 WebView 一个轻量起始页
                if !(path.ends_with("index.html") || path.ends_with("bootstrap.html")) {
                    return;
                }
                boot_log(&format!("页面加载完成 {path}"));
                PAGE_READY.store(true, Ordering::SeqCst);
                reveal(&window);
            });

            // 只在 debug 开 CDP，用于注入帧率探针和调样式；发布版不留调试端口。
            // 注意这个参数会整体替换 wry 的默认浏览器参数，所以只放必须的那一条。
            #[cfg(debug_assertions)]
            {
                builder = builder.additional_browser_args("--remote-debugging-port=9222");
            }

            let window = builder.build()?;
            boot_log("窗口（隐藏）已创建，WebView2 就绪");

            // 系统文件拖放：WebView2 里拿不到被拖文件的绝对路径（安全限制），
            // 只能靠 Tauri 的原生拖放事件把路径转给页面。
            // 页面侧接 __hmcl.onDragEnter / onDragDrop / onDragLeave。
            {
                let win = window.clone();
                window.on_window_event(move |event| {
                    use tauri::{DragDropEvent, WindowEvent};
                    let WindowEvent::DragDrop(drag) = event else { return };
                    let js = match drag {
                        // Enter 也把路径带上：遮罩要显示「将 a.jar 安装至 xxx」，
                        // 只给个数的话只能写「3 个文件」，用户看不出拖的是什么
                        DragDropEvent::Enter { paths, .. } => {
                            let list: Vec<String> = paths
                                .iter()
                                .map(|p| p.display().to_string())
                                .collect();
                            format!(
                                "window.__hmcl && window.__hmcl.onDragEnter({})",
                                serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
                            )
                        }
                        // Over 每帧都来，转发过去只会刷屏
                        DragDropEvent::Over { .. } => return,
                        DragDropEvent::Drop { paths, .. } => {
                            let list: Vec<String> = paths
                                .iter()
                                .map(|p| p.display().to_string())
                                .collect();
                            format!(
                                "window.__hmcl && window.__hmcl.onDragDrop({})",
                                serde_json::to_string(&list).unwrap_or_else(|_| "[]".into())
                            )
                        }
                        DragDropEvent::Leave => {
                            "window.__hmcl && window.__hmcl.onDragLeave()".to_string()
                        }
                        _ => return,
                    };
                    let _ = win.eval(&js);
                });
            }

            app.manage(ShellState {
                core: Mutex::new(None),
                closed: AtomicBool::new(false),
                _single: single,
            });

            // 启动流程全丢到后台线程：主线程只管窗口，不碰磁盘和进程。
            let app_handle = app.handle().clone();
            let win = window.clone();
            std::thread::spawn(move || {
                // 任何一条路径跑歪，6 秒后也要把窗口放出来
                reveal_fallback(&win, 6000);

                // 有 Java 就直接起核心；一个都找不到才走引导下载。
                // 判断依据是探测本身，不是「起核心失败后看错误文案」——
                // 文案一改判断就失效。
                let has_java = match sidecar::locate_java() {
                    Ok(path) => {
                        boot_log(&format!("Java 就绪 {}", path.display()));
                        true
                    }
                    Err(e) => {
                        boot_log(&format!("没有可用的 Java：{}", e.lines().next().unwrap_or("")));
                        false
                    }
                };

                if !has_java {
                    if !navigate(&win, "bootstrap.html") {
                        reveal(&win);
                    }
                    match bootstrap::ensure_java(&win) {
                        Ok(java) => boot_log(&format!("引导页补齐 Java：{}", java.display())),
                        Err(e) => {
                            boot_log(&format!("Java 准备失败：{e}"));
                            bootstrap::show_error(&win, &e);
                            return;
                        }
                    }
                }

                match sidecar::spawn() {
                    Ok(core) => {
                        boot_log(&format!(
                            "核心已就绪 port={} java={} jar={}",
                            core.port,
                            core.java.display(),
                            core.jar.display()
                        ));
                        // 端口和 token 走 query 传给页面：比 initialization_script 简单，
                        // 而且刷新页面（F5）时不会丢。lang 让前端知道加载哪个语言包。
                        let url = format!(
                            "index.html?port={}&token={}&lang={}",
                            core.port, core.token, core.lang
                        );
                        let ok = navigate(&win, &url);
                        if !ok {
                            boot_log("导航到主页失败");
                            reveal(&win);
                        }
                        hand_over(&app_handle, core);
                    }
                    Err(e) => {
                        boot_log(&format!("核心启动失败：{e}"));
                        bootstrap::show_error(&win, &e);
                        std::process::exit(1);
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![clean_webview_cache, restart_app, open_login_window])
        .on_window_event(|window, event| {
            // 窗口没了核心必须跟着走，否则下次启动会撞单例锁
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<ShellState>() {
                    let core = {
                        let mut guard = state.core.lock().unwrap_or_else(|e| e.into_inner());
                        state.closed.store(true, Ordering::SeqCst);
                        guard.take()
                    };
                    // 核心退出要把日志压成 xz，十几秒都正常。
                    // 放到线程里做：关窗动作不该卡在窗口线程上。
                    if let Some(mut core) = core {
                        boot_log("窗口已关闭，停止核心");
                        std::thread::spawn(move || core.shutdown());
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}

/// 开一个内嵌窗口做微软登录。
///
/// 用子窗口而不是系统浏览器：用户在启动器里点「登录」，界面不该跳走。
/// 授权完成后微软会跳到 `http://localhost:<port>/auth-response` —— 那个地址
/// 由 Java 侧的 NanoHTTPD 接管，令牌交换在那边完成，所以窗口一导航到它就
/// 没用了，直接关掉，用户回到启动器刚好看到登录成功。
///
/// **必须在主线程建窗口**：WebView2 的环境绑在 UI 线程上，从后台线程
/// （`async fn` command 默认在后台跑）创建会拿到 `HRESULT(0x8007139F)`，
/// 报「组或资源的状态不是执行请求操作的正确状态」。所以这里用同步 command
/// + `run_on_main_thread` 把创建动作投递回 UI 线程。
#[tauri::command]
fn open_login_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed: tauri::Url = url.parse().map_err(|e| format!("登录地址无效：{e}"))?;

    let app_for_build = app.clone();
    app.run_on_main_thread(move || {
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        // 连点会开出好几个窗口，先关掉旧的
        if let Some(existing) = app_for_build.get_webview_window("microsoft-login") {
            let _ = existing.close();
        }

        let app_for_nav = app_for_build.clone();
        let built = WebviewWindowBuilder::new(
            &app_for_build,
            "microsoft-login",
            WebviewUrl::External(parsed),
        )
        .title("登录 Microsoft 账户")
        .inner_size(520.0, 760.0)
        .min_inner_size(420.0, 600.0)
        .center()
        .on_navigation(move |target| {
            let host = target.host_str().unwrap_or_default();
            let path = target.path();
            if (host == "localhost" || host == "127.0.0.1") && path.starts_with("/auth-response") {
                if let Some(w) = app_for_nav.get_webview_window("microsoft-login") {
                    let _ = w.close();
                }
            }
            true
        })
        .build();

        match built {
            Ok(w) => {
                let _ = w.set_focus();
            }
            Err(e) => {
                // 这里没法把错误回传给前端（闭包在 UI 线程跑），只能落日志。
                // 前端那边有兜底：调不通会退回系统浏览器打开同一个地址。
                eprintln!("[login] 创建内嵌登录窗口失败: {e}");
            }
        }
    })
    .map_err(|e| format!("无法调度窗口创建：{e}"))?;

    Ok(())
}
