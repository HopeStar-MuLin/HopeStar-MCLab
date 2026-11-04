#!/usr/bin/env bash
# 一键构建：环境 → 编译 → 打包 → 复制到 dist/
# 用法：./build.sh [--clean]
set -euo pipefail
cd "$(dirname "$0")"

source env/env.sh

# 版本号只有一个来源：update.json。
#
# 不设 VERSION_OVERRIDE 时 gradle 会退回 3.17.SNAPSHOT（继承自上游的版本线），
# 而检查更新是拿 update.json 的版本（0.x）和 jar 里写的版本比 ——
# 3.17.SNAPSHOT 恒大于 0.x，于是「检查更新」永远回「已是最新」，用户点了没反应。
# 之前一直靠手动 export，忘一次就打回原形，所以这里直接从清单读。
VER="$(python -c "import json;print(json.load(open('update.json'))['version'])" 2>/dev/null || true)"
if [ -z "$VER" ]; then
    echo "[build] 读不到 update.json 里的 version，中止" >&2
    exit 1
fi
export VERSION_OVERRIDE="$VER"
echo "[build] 版本 $VERSION_OVERRIDE"

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
