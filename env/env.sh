#!/usr/bin/env bash
# 用法：source env/env.sh
# 把 JAVA_HOME / GRADLE_USER_HOME / Maven 镜像全部固定到本目录，不再依赖 C 盘的用户环境。

MCLAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MCLAB_ROOT

# 便携 JDK / Gradle 缓存是本机才有的东西（都不入库）。缺了就退回系统环境：
# 这样 CI（actions/setup-java）和「刚 clone 下来还没跑 setup-env.sh」都能构建。
if [ -x "$MCLAB_ROOT/env/jdk/bin/javac" ]; then
    export JAVA_HOME="$MCLAB_ROOT/env/jdk"
    case ":$PATH:" in
        *":$JAVA_HOME/bin:"*) ;;
        *) export PATH="$JAVA_HOME/bin:$PATH" ;;
    esac
else
    echo "[env] env/jdk 不存在，沿用系统 JAVA_HOME=${JAVA_HOME:-<未设置>}"
fi

if [ -d "$MCLAB_ROOT/env/gradle-home" ]; then
    export GRADLE_USER_HOME="$MCLAB_ROOT/env/gradle-home"
fi

export MAVEN_CENTRAL_REPO="${MAVEN_CENTRAL_REPO:-https://maven.aliyun.com/repository/public}"

echo "[env] MCLAB_ROOT      = $MCLAB_ROOT"
echo "[env] JAVA_HOME       = ${JAVA_HOME:-<未设置>}"
echo "[env] GRADLE_USER_HOME= ${GRADLE_USER_HOME:-<默认>}"
echo "[env] MAVEN 镜像      = $MAVEN_CENTRAL_REPO"

# ---------------------------------------------------------------------------
# 上游凭据（可选，不入库）
# ---------------------------------------------------------------------------
# HMCL 官方发行版的 assets/hmcl.properties 里带两个运行时凭据：微软登录的
# OAuth client id 和 CurseForge 的 API key。自己编译的包没有它们，表现为
# 「正版登录不可用」「CurseForge 源 403」。
#
# 需要的话用 tools/official_keys.py 从官方 jar 里取一次，落在 .cache/keys.env
# （.gitignore 已忽略 .cache/，**不要**把它提交上去——那是别人的凭据）：
#
#   python tools/official_keys.py --jar .cache/HMCL-official.jar --out .cache/keys.env
#
# 没有这个文件也能正常编译，只是上面那两个功能不可用。
if [ -f "$MCLAB_ROOT/.cache/keys.env" ]; then
    # shellcheck disable=SC1091
    . "$MCLAB_ROOT/.cache/keys.env"
    echo "[env] 已读取 .cache/keys.env（上游凭据）"
else
    echo "[env] 无 .cache/keys.env：正版登录 / CurseForge 源不可用"
fi

# 本地覆盖：用自己的微软 client id（过了 Mojang 审核之后）/ 自己的 CurseForge key。
# 必须放在 keys.env 之后——那个文件由 official_keys.py 每次重写，往里追加会被冲掉。
if [ -f "$MCLAB_ROOT/.cache/keys.local.env" ]; then
    # shellcheck disable=SC1091
    . "$MCLAB_ROOT/.cache/keys.local.env"
    echo "[env] 已加载本地覆盖 .cache/keys.local.env"
fi

# 发行构建用：MCLAB_DISABLE_MSAUTH=1 时清空 client id。
# Mojang 审核通过前，带 id 的包只会让用户卡在 Xbox Live 那步，不如先把入口关掉。
if [ "${MCLAB_DISABLE_MSAUTH:-0}" = "1" ]; then
    MICROSOFT_AUTH_ID=""
    echo "[env] 已禁用微软正版登录（MCLAB_DISABLE_MSAUTH=1）"
fi

[ -n "${MICROSOFT_AUTH_ID:-}" ] && export MICROSOFT_AUTH_ID
[ -n "${CURSEFORGE_API_KEY:-}" ] && export CURSEFORGE_API_KEY
true
