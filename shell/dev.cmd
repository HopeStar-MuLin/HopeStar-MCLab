@echo off
setlocal
rem Tauri 壳的开发启动。JDK 和核心 jar 都由 sidecar.rs 自己找，这里只管 Rust 工具链。

set "CARGO_HOME=E:\MCLab\env\cargo"
set "RUSTUP_HOME=E:\MCLab\env\rustup"
set "PATH=%CARGO_HOME%\bin;%PATH%"

cd /d "%~dp0"

if not exist "..\dist\HopeStar-MCLab.jar" (
    echo [dev] 没有 HopeStar-MCLab.jar，先构建核心...
    pushd ..
    call build.sh
    popd
    if not exist "..\dist\HopeStar-MCLab.jar" (
        echo [dev] 核心构建失败，退出
        exit /b 1
    )
)

node scripts\sync-web.js
call npx tauri dev
