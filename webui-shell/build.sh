#!/usr/bin/env bash
# 编译 WebView 外壳原型
set -euo pipefail
cd "$(dirname "$0")"

JAVA_HOME="${JAVA_HOME:-/c/Program Files/Java/jdk-21.0.12.1}"
if [[ ! -x "$JAVA_HOME/bin/javac" ]]; then
    echo "[x] 找不到 JDK，export JAVA_HOME=/c/path/to/jdk-21" >&2
    exit 1
fi

mkdir -p out
"$JAVA_HOME/bin/javac" -encoding UTF-8 -d out \
    --module-path lib --add-modules javafx.controls,javafx.web \
    src/main/java/webshell/WebShell.java

echo "[ok] out/"
