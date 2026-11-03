@echo off
cd /d "%~dp0"

rem 不请求管理员权限。虚拟网卡方案不可用，仅「免虚拟网卡」方案可用。
if not exist "lan-module.exe" (
    echo lan-module.exe not found, run build.cmd first.
    pause
    exit /b 1
)

lan-module.exe
