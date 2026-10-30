@echo off
setlocal
cd /d "%~dp0"
if not exist "%JAVA_HOME%\bin\javaw.exe" (
    for /d %%D in ("C:\Program Files\Java\jdk-*") do if exist "%%D\bin\javaw.exe" set "JAVA_HOME=%%D"
)
if not exist "%JAVA_HOME%\bin\javaw.exe" (
    echo [x] No JDK found. Set JAVA_HOME first.
    exit /b 1
)
if not exist "dist\HopeStar-MCLab.jar" (
    echo [x] Not built yet. Run build.sh first.
    exit /b 1
)
start "" "%JAVA_HOME%\bin\javaw.exe" -jar "dist\HopeStar-MCLab.jar"
endlocal
