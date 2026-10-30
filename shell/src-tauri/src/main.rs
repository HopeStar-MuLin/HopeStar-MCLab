// 发布版不要控制台窗口；debug 版留着，方便看 Java 核心的输出
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;
mod single_instance;

/// 浏览器行为屏蔽脚本，编译进二进制。
const GUARD_JS: &str = include_str!("guard.js");

use std::sync::{Mutex, OnceLock};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 第二个实例启动时要把已有窗口提到前台，这里留一份 AppHandle 给监听线程用。
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// 把主窗口提到前台。由单实例守卫在检测到重复启动时调用，也可单独复用。
pub(crate) fn focus_main_window() {
    let Some(app) = APP_HANDLE.get() else { return };
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}


/// 核心进程握在 Tauri 的托管状态里，窗口销毁时统一收
struct ShellState {
    core: Mutex<Option<sidecar::Core>>,
    /// 单实例守卫。存着只为不让端口释放；窗口关了进程也就退了。
    _single: single_instance::SingleInstance,
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());

            // 双开会共用同一份配置目录，写坏 config / 日志，必须先挡。
            let single = match single_instance::acquire() {
                Ok(Some(guard)) => guard,
                Ok(None) => {
                    // 已有实例在跑：刚才那一 ping 已经让对方把窗口提到前台了。
                    println!("[shell] 已有实例在运行，本次启动退出");
                    std::process::exit(0);
                }
                Err(()) => {
                    // 端口被无关程序占着，不阻断用户，照常启动
                    println!("[shell] 单实例端口被占用（非本程序），跳过检查");
                    // 拿不到 guard 就没有占位；这里用一个不占端口的空壳顶上
                    single_instance::SingleInstance::detached()
                }
            };

            println!("[shell] 启动 Java 核心…");
            let core = sidecar::spawn()?;
            println!(
                "[shell] 核心已就绪 port={} java={} jar={}",
                core.port,
                core.java.display(),
                core.jar.display()
            );

            // 端口和 token 走 query 传给页面：比 initialization_script 简单，
            // 而且刷新页面（F5）时不会丢
            let url = format!("index.html?port={}&token={}", core.port, core.token);

            // debug 构建下面还会重新赋值（加 CDP 端口），release 下不用改，
            // 所以 mut 只在 debug 有意义 —— 用 allow 而不是去掉，否则 debug 编不过
            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
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
                // 顶层导航只允许留在本地页面。否则点到一个 a[href]、或者拖进来
                // 一个文件，整个应用就被导航顶掉了，而且再也回不来（没有后退按钮）。
                .on_navigation(|url| {
                    url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri"
                });

            // 只在 debug 开 CDP，用于注入帧率探针和调样式；发布版不留调试端口。
            // 注意这个参数会整体替换 wry 的默认浏览器参数，所以只放必须的那一条。
            #[cfg(debug_assertions)]
            {
                builder = builder.additional_browser_args("--remote-debugging-port=9222");
            }

            builder.build()?;

            app.manage(ShellState {
                core: Mutex::new(Some(core)),
                _single: single,
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口没了核心必须跟着走，否则下次启动会撞单例锁
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<ShellState>() {
                    if let Ok(mut guard) = state.core.lock() {
                        if let Some(mut core) = guard.take() {
                            println!("[shell] 窗口已关闭，停止核心");
                            core.shutdown();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Tauri 启动失败");
}
