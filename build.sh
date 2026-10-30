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

JAR="$(ls HMCL/build/libs/HMCL-*.jar | head -1)"
cp "$JAR" ../dist/HopeStar-MCLab.jar
echo "[build] $JAR -> dist/HopeStar-MCLab.jar"
ls -la ../dist/HopeStar-MCLab.jar
