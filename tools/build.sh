#!/usr/bin/env bash
# 一键构建（Git Bash / WSL）
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${JAVA_HOME:-}" ]]; then
    for d in "/c/Program Files/Java"/jdk-*; do [[ -x "$d/bin/javac" ]] && JAVA_HOME="$d"; done
fi
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/javac" ]]; then
    echo "[x] 找不到 JDK，先 export JAVA_HOME=/c/path/to/jdk" >&2
    exit 1
fi
export JAVA_HOME
echo "[i] JAVA_HOME=$JAVA_HOME"

export MAVEN_CENTRAL_REPO="${MAVEN_CENTRAL_REPO:-https://maven.aliyun.com/repository/public}"

python tools/unrestrict.py --root ./HMCL --apply

# 正版登录 client id + CurseForge key：从官方包里取，避免自编译版缺功能
if [[ -f .cache/HMCL-official.jar ]]; then
    python tools/official_keys.py --jar .cache/HMCL-official.jar --out .cache/keys.env
    set -a; . .cache/keys.env; set +a
else
    echo "[!] 没有 .cache/HMCL-official.jar，本次构建无正版登录 / 无 CurseForge"
fi

cd HMCL
./gradlew :HMCL:shadowJar -x test --console=plain
cd ..

mkdir -p dist
cp -f HMCL/HMCL/build/libs/HMCL-*.jar dist/HMCL.jar
echo "[ok] 产物: dist/HMCL.jar"
python tools/verify.py --jar dist/HMCL.jar
