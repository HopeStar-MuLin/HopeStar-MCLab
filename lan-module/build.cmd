@echo off
setlocal
cd /d "%~dp0"

set "GOEXE=go"
where go >nul 2>&1
if errorlevel 1 set "GOEXE=%~dp0..\.toolchain\go\bin\go.exe"

if not exist "%GOEXE%" (
    echo [ERROR] Go toolchain not found.
    echo         Install Go 1.21+ and add it to PATH,
    echo         or extract it to ..\.toolchain\go
    exit /b 1
)

set "GOPATH=%~dp0..\.toolchain\gopath"
set "GOCACHE=%~dp0..\.toolchain\gocache"

echo Building lan-module.exe ...
"%GOEXE%" build -trimpath -ldflags "-s -w" -o lan-module.exe .
if errorlevel 1 (
    echo [ERROR] build failed
    exit /b 1
)

echo Done.
