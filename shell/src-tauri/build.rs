use std::path::Path;

/// 把目录里每个文件都登记成构建依赖。
///
/// 只写 `rerun-if-changed=../web` 是不行的：cargo 对**目录**只看 mtime，
/// 而改一个已有文件的内容不会更新目录的 mtime —— 于是改完 css 跑 cargo build，
/// 它认为「没变化」直接跳过，跑起来还是旧界面（这个坑踩过两次）。
fn watch_dir(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                watch_dir(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn main() {
    // 图标不进增量编译的依赖图：换掉 icons/icon.ico 之后 cargo 认为
    // build.rs 的输出仍然有效，resource.lib 不会重生成，exe 里还是旧图标。
    // （换图标那次就是这么踩的：exe 重新编译了、图标却没变。）
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    // 前端资源是通过 tauri.conf.json 的 frontendDist(../web) 编进 exe 的
    watch_dir(Path::new("../web"));

    tauri_build::build()
}
