#!/usr/bin/env bash
# 启动 WebView 外壳原型
#   ./run.sh                 正常启动
#   ./run.sh --smoke         加载完成后打印能力自检并退出
#   ./run.sh --shot out.png  加载完成后截图并退出
set -euo pipefail
cd "$(dirname "$0")"

JAVA_HOME="${JAVA_HOME:-/c/Program Files/Java/jdk-21.0.12.1}"
[[ -d out ]] || ./build.sh

ARGS=()
for arg in "$@"; do
    case "$arg" in
        --smoke) ARGS+=("-Dsmoke=true") ;;
        --shot=*) ARGS+=("-Dshot=${arg#--shot=}") ;;
        --theme=*) ARGS+=("-Dtheme=${arg#--theme=}") ;;
        *) echo "[x] 未知参数: $arg" >&2; exit 1 ;;
    esac
done

exec "$JAVA_HOME/bin/java" \
    --module-path lib --add-modules javafx.controls,javafx.web \
    -cp "out;src/main/resources" \
    "${ARGS[@]}" webshell.WebShell
