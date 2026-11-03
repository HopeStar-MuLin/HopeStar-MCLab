//! 单实例守卫。
//!
//! 两个启动器同时跑会共用同一份 `.hmcl` 和 `.minecraft`：
//! `config/*.json` 互相覆盖、日志互相截断、同一个存档可能被两个进程同时写。
//! 实测双开能成功（`-Dhmcl.dir` 绕过了上游的目录锁判断），所以这里自己挡一道。
//!
//! 做法是占一个固定的回环端口：进程活着端口就在，进程退出系统自动释放，
//! 不需要临时文件，也不会像 pid 文件那样在崩溃后留下死锁。
//!
//! 端口被占时不能直接判定「重复启动」——也可能是别的程序恰好用了这个端口。
//! 所以占用方要能自报身份：它 accept 后回一行固定特征串，第二个实例读到这个串
//! 才认定「已有启动器在跑」，否则按正常启动继续走。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

/// 特征串。两个实例之间只靠它认亲。
const HELLO: &str = "hopestar-mclab-shell";
const SINGLETON_PORT: u16 = 38571;

pub struct SingleInstance {
    /// 持有它端口就不会释放；字段本身不用，靠 Drop 语义占位。
    /// 端口被无关程序占用时这里是 None —— 那种情况我们不占位也不阻断启动。
    _listener: Option<TcpListener>,
}

impl SingleInstance {
    /// 不占端口的所有权占位。只在「端口被别的程序用了」这条罕见路径上用到。
    pub fn detached() -> Self {
        SingleInstance { _listener: None }
    }
}

/// 尝试取得单实例所有权。
///
/// * `Ok(Some(guard))` —— 我们是唯一实例，guard 要一直活着
/// * `Ok(None)`         —— 已有实例在跑（已通知它把窗口提到前台），调用方应退出
/// * `Err(())`          —— 端口被无关程序占用，按正常启动继续（不阻断用户）
pub fn acquire() -> Result<Option<SingleInstance>, ()> {
    match TcpListener::bind(("127.0.0.1", SINGLETON_PORT)) {
        Ok(listener) => {
            let _ = listener.set_nonblocking(false);
            start_responder(listener.try_clone().ok());
            Ok(Some(SingleInstance { _listener: Some(listener) }))
        }
        Err(_) => {
            if ping_existing() {
                Ok(None)
            } else {
                Err(())
            }
        }
    }
}

/// 问一下占着这个端口的是不是我们自己人。
fn ping_existing() -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], SINGLETON_PORT));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(600)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    // 故意发一个不像 HTTP 的东西：我们只关心对面回不回答特征串
    if stream.write_all(b"FOCUS\n").is_err() {
        return false;
    }
    let mut buf = [0u8; 128];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => String::from_utf8_lossy(&buf[..n]).contains(HELLO),
        _ => false,
    }
}

/// 专职应答：收到任何一行就回特征串，并把已有窗口提到前台。
fn start_responder(listener: Option<TcpListener>) {
    let Some(listener) = listener else { return };
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.write_all(HELLO.as_bytes());
            let _ = stream.flush();
            // 客户端只是问一句就走，这里不读也不等
            crate::focus_main_window();
        }
    });
}
