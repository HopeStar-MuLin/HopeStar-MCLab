#!/usr/bin/env bash
# 一键构建：环境 → 编译 → 打包 → 复制到 dist/
# 用法：./build.sh [--clean]
set -euo pipefail
cd "$(dirname "$0")"

source env/env.sh

cd HMCL

if [[ "${1:-}" == "--clean" ]]; then
    ./gradlew clean --offline --console=plain
fi

./gradlew :HMCL:shadowJar -x test --offline --console=plain

# 按修改时间取最新的那个，不能按字母序：上一次用 VERSION_OVERRIDE=0.1-dev 构建会留下
# HMCL-0.1-dev.jar，字母序排在 HMCL-3.17.SNAPSHOT.jar 前面，于是每次都拷到旧包
# （表现：代码改了、编译也过了，但打出来的 jar 里没有新类）。
JAR="$(ls -t HMCL/build/libs/HMCL-*.jar | head -1)"
cp "$JAR" ../dist/HopeStar-MCLab.jar
echo "[build] $JAR -> dist/HopeStar-MCLab.jar"
ls -la ../dist/HopeStar-MCLab.jar
