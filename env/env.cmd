@echo off
rem 用法：call env\env.cmd
rem 把 JAVA_HOME / GRADLE_USER_HOME / Maven 镜像全部固定到本目录。

set "MCLAB_ROOT=%~dp0.."
for %%I in ("%MCLAB_ROOT%") do set "MCLAB_ROOT=%%~fI"

set "JAVA_HOME=%MCLAB_ROOT%\env\jdk"
set "GRADLE_USER_HOME=%MCLAB_ROOT%\env\gradle-home"
if "%MAVEN_CENTRAL_REPO%"=="" set "MAVEN_CENTRAL_REPO=https://maven.aliyun.com/repository/public"
set "PATH=%JAVA_HOME%\bin;%PATH%"

echo [env] MCLAB_ROOT       = %MCLAB_ROOT%
echo [env] JAVA_HOME        = %JAVA_HOME%
echo [env] GRADLE_USER_HOME = %GRADLE_USER_HOME%
echo [env] MAVEN           = %MAVEN_CENTRAL_REPO%
