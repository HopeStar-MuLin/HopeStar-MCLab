#!/usr/bin/env bash
# 下载 webui-shell 需要的 JavaFX 模块（jar 不入 git，换机器时跑一次）。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${JAVAFX_VERSION:-21.0.13}"
MIRROR="${MAVEN_CENTRAL_REPO:-https://maven.aliyun.com/repository/public}"
DEST="webui-shell/lib"
mkdir -p "$DEST"

# javafx.web 依赖 javafx.media，五个都要
for m in base graphics controls media web; do
    target="$DEST/javafx-$m-$VERSION-win.jar"
    if [[ -s "$target" ]]; then
        echo "[i] 已存在 $target"
        continue
    fi
    url="$MIRROR/org/openjfx/javafx-$m/$VERSION/javafx-$m-$VERSION-win.jar"
    echo "[i] 下载 $url"
    curl -fL --retry 3 -o "$target" "$url"
done

ls -la "$DEST"
