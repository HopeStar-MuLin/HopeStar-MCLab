#!/usr/bin/env bash
# 重建 env/ 下的便携运行时：把系统里的 JDK 和 Gradle 缓存搬进来。
# 只在换机器 / 误删 env/ 之后跑一次。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

mkdir -p "$ROOT/env"

# ---- JDK ----
if [[ ! -x "$ROOT/env/jdk/bin/javac" ]]; then
    SRC="${1:-/c/Program Files/Java/jdk-21.0.12.1}"
    if [[ ! -x "$SRC/bin/javac" ]]; then
        echo "[x] 找不到 JDK 源目录：$SRC" >&2
        echo "    用法：./env/setup-env.sh /c/path/to/jdk-21" >&2
        exit 1
    fi
    echo "[i] 复制 JDK: $SRC -> env/jdk"
    cp -r "$SRC" "$ROOT/env/jdk"
else
    echo "[i] env/jdk 已存在，跳过"
fi

# ---- Gradle ----
if [[ ! -d "$ROOT/env/gradle-home/wrapper" ]]; then
    SRC="${GRADLE_SRC:-$HOME/.gradle}"
    if [[ ! -d "$SRC/wrapper" ]]; then
        echo "[!] 找不到 $SRC/wrapper，跳过（首次构建会联网下载 Gradle 发行包）"
    else
        echo "[i] 复制 Gradle 缓存: $SRC -> env/gradle-home"
        mkdir -p "$ROOT/env/gradle-home"
        cp -r "$SRC/caches" "$ROOT/env/gradle-home/" 2>/dev/null || true
        cp -r "$SRC/wrapper" "$ROOT/env/gradle-home/" 2>/dev/null || true
    fi
else
    echo "[i] env/gradle-home 已存在，跳过"
fi

echo "[ok] 环境就绪："
"$ROOT/env/jdk/bin/java" -version 2>&1 | head -1
