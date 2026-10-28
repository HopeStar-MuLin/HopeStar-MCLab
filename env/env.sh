#!/usr/bin/env bash
# 用法：source env/env.sh
# 把 JAVA_HOME / GRADLE_USER_HOME / Maven 镜像全部固定到本目录，不再依赖 C 盘的用户环境。

MCLAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MCLAB_ROOT

export JAVA_HOME="$MCLAB_ROOT/env/jdk"
export GRADLE_USER_HOME="$MCLAB_ROOT/env/gradle-home"
export MAVEN_CENTRAL_REPO="${MAVEN_CENTRAL_REPO:-https://maven.aliyun.com/repository/public}"

case ":$PATH:" in
    *":$JAVA_HOME/bin:"*) ;;
    *) export PATH="$JAVA_HOME/bin:$PATH" ;;
esac

echo "[env] MCLAB_ROOT      = $MCLAB_ROOT"
echo "[env] JAVA_HOME       = $JAVA_HOME"
echo "[env] GRADLE_USER_HOME= $GRADLE_USER_HOME"
echo "[env] MAVEN 镜像      = $MAVEN_CENTRAL_REPO"
