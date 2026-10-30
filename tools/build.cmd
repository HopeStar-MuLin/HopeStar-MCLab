@echo off
setlocal
cd /d "%~dp0.."

rem --- JDK: prefer JAVA_HOME, fall back to scanning Program Files ---
if not exist "%JAVA_HOME%\bin\javac.exe" (
    for /d %%D in ("C:\Program Files\Java\jdk-*") do if exist "%%D\bin\javac.exe" set "JAVA_HOME=%%D"
)
if not exist "%JAVA_HOME%\bin\javac.exe" (
    echo [x] Invalid JAVA_HOME: "%JAVA_HOME%"
    echo     Install JDK 17+ then: set JAVA_HOME=C:\path\to\jdk
    exit /b 1
)
echo [i] JAVA_HOME=%JAVA_HOME%

rem --- maven mirror: direct maven central is slow in CN ---
if "%MAVEN_CENTRAL_REPO%"=="" set "MAVEN_CENTRAL_REPO=https://maven.aliyun.com/repository/public"

rem --- strip region gate on download pages (no-op when upstream has none) ---
python tools\unrestrict.py --root .\HMCL --apply
if errorlevel 1 (
    echo [x] unrestrict failed
    exit /b 1
)

rem --- credentials: MSA client id + CurseForge key (need official jar) ---
if exist ".cache\HMCL-official.jar" (
    python tools\official_keys.py --jar .cache\HMCL-official.jar --out .cache\keys.cmd --format cmd
    if exist ".cache\keys.cmd" call ".cache\keys.cmd"
) else (
    echo [!] No .cache\HMCL-official.jar: no Microsoft login / no CurseForge this build
    echo     Run: python tools\fetch_official.py
)

rem --- build ---
pushd HMCL
call gradlew.bat :HMCL:shadowJar -x test --console=plain
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
    echo [x] Build failed, see gradle output above
    exit /b %RC%
)

rem --- collect artifact ---
if not exist dist mkdir dist
copy /y "HMCL\HMCL\build\libs\HMCL-*.jar" "dist\HopeStar-MCLab.jar" >nul
echo.
echo [ok] Artifact: dist\HopeStar-MCLab.jar
python tools\verify.py --jar dist\HopeStar-MCLab.jar
endlocal
