@echo off
cd /d "%~dp0"

if not exist "lan-module.exe" (
    echo lan-module.exe not found, run build.cmd first.
    pause
    exit /b 1
)

net session >nul 2>&1
if errorlevel 1 (
    echo Requesting administrator privileges for virtual NIC...
    powershell -NoProfile -Command "Start-Process -FilePath '%~dp0lan-module.exe' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b
)

lan-module.exe
