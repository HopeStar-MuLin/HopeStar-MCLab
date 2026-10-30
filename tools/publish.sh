#!/usr/bin/env bash
# 导出「本体源码」并推送到 GitHub。
#
# 为什么不直接 git push：本地历史里有 docs/ 截图（含账号名、皮肤、本机路径）、
# 调试脚本、运行态目录，还有一些只在本机有意义的东西。公共仓库只发源码，
# 这里用白名单导出 + 单次提交，比每次推送前手工检查可靠。
#
# 用法（Windows 下用 Git Bash 跑）：
#   bash tools/publish.sh                      # 只导出并体检，不推送（默认，安全）
#   bash tools/publish.sh --remote git@github.com:you/HopeStar-MCLab.git
#   bash tools/publish.sh --remote ... --tag v3.17.0
#   bash tools/publish.sh --remote ... --yes   # 跳过确认
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REMOTE=""
TAG=""
YES=0
BRANCH="main"

while [ $# -gt 0 ]; do
    case "$1" in
        --remote) REMOTE="$2"; shift 2 ;;
        --tag) TAG="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --yes|-y) YES=1; shift ;;
        -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# 白名单：只有这些会进公共仓库
# ---------------------------------------------------------------------------
INCLUDE_FILES=(
    ".gitignore"
    "README.md"
    "LICENSE"
    "NOTICE"
    "AGENT.md"
    "build.sh"
    "run.cmd"
    "启动器图标.png"
)
INCLUDE_DIRS=(
    "HMCL"          # 上游 fork 的 Gradle 工程（含新增的 ui/web 与 assets/web）
    "shell"         # Tauri 外壳 + Rust 源码（web/ 是镜像，构建时生成）
    "env"           # env.sh / env.cmd / setup-env.sh / fetch-deps.sh
)
# tools/ 只带需要给使用者的脚本，本机调试脚本留在本地
INCLUDE_TOOLS=(
    "tools/make-icons.py"
    "tools/pack-debug.py"
    "tools/official_keys.py"
    "tools/publish.sh"
)

# 导出时就要排除的（可再生产物 / 运行态 / 本机数据）
PRUNE=(
    "HMCL/.gradle"
    "HMCL/.hmcl"
    "HMCL/build"
    "HMCL/HMCL/build"
    "shell/web"
    "shell/node_modules"
    "shell/src-tauri/target"
    "shell/src-tauri/gen/schemas"
    "env/jdk"
    "env/gradle-home"
    "env/cargo"
    "env/rustup"
    "env/rutrustup"
    "env/rustup-init.exe"   # 13MB 的 Rust 安装器，属于工具链不属于源码
    "env/fetch-deps.sh"     # 给已淘汰的 webui-shell 原型下 JavaFX，公开仓库用不上
)

STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/repo"
mkdir -p "$STAGE"

# 用 tar 流式导出（Git Bash 里没有 rsync）。
# --exclude 必须在**拷贝时**生效：shell/src-tauri/target 有 1.9G，
# 先 cp 再删会卡好几分钟。
EXCLUDES=()
for p in "${PRUNE[@]}"; do EXCLUDES+=("--exclude=$p"); done
EXCLUDES+=(
    "--exclude=*/build"
    "--exclude=*/target"
    "--exclude=*/.gradle"
    "--exclude=node_modules"
    "--exclude=*.class"
    "--exclude=*.log"
    "--exclude=.DS_Store"
)

echo "[publish] 导出白名单到 $STAGE"
ITEMS=()
for f in "${INCLUDE_FILES[@]}" "${INCLUDE_DIRS[@]}" "${INCLUDE_TOOLS[@]}"; do
    [ -e "$ROOT/$f" ] && ITEMS+=("$f")
done
if [ ${#ITEMS[@]} -eq 0 ]; then
    echo "[publish] 白名单里一个路径都不存在，检查 INCLUDE_* 配置" >&2
    exit 1
fi

if ! tar -C "$ROOT" -cf - "${EXCLUDES[@]}" "${ITEMS[@]}" | tar -C "$STAGE" -xf -; then
    echo "[publish] 导出失败（tar 报错），已中止" >&2
    exit 1
fi

# 兜底：任何层级的构建缓存与编译产物都不要
find "$STAGE" -type d \( -name build -o -name target -o -name .gradle -o -name node_modules -o -name .idea \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -type f \( -name "*.class" -o -name "*.log" -o -name "*.part" -o -name ".DS_Store" \) -delete 2>/dev/null || true

# ---------------------------------------------------------------------------
# 脱敏体检
#
# 分两级，避免误报：
#   1) 真实凭据值（.cache/keys.env 里的那几个）：全树扫，命中即中止；
#   2) 通用特征 + 本机绝对路径：只扫「我们自己写的代码」。
#      上游 HMCL 的测试资源里有一堆 PEM 和日志样例，全树扫必然一堆假阳性。
# ---------------------------------------------------------------------------
SCAN_FAIL=0

echo "[publish] 脱敏扫描"
if [ -f "$ROOT/.cache/keys.env" ]; then
    SECRETS="$STAGE_PARENT/secrets"
    grep -E '^[A-Z_]+=.+' "$ROOT/.cache/keys.env" | cut -d= -f2- | grep -v '^$' > "$SECRETS" || true
    chmod 600 "$SECRETS" 2>/dev/null || true
    if [ -s "$SECRETS" ]; then
        HITS="$(grep -rIlF -f "$SECRETS" "$STAGE" 2>/dev/null || true)"
        if [ -n "$HITS" ]; then
            echo "[publish] 发现真实凭据值（已中止）：" >&2
            echo "$HITS" | sed "s|$STAGE/||" >&2
            SCAN_FAIL=1
        fi
    fi
    rm -f "$SECRETS"
fi

# 我们自己写的代码范围（新增目录时记得加进来）
SCOPE=(
    "HMCL/HMCL/src/main/java/org/jackhuang/hmcl/ui/web"
    "HMCL/HMCL/src/main/resources/assets/web"
    "shell/src"
    "shell/src-tauri/src"
    "shell/src-tauri/build.rs"
    "shell/src-tauri/tauri.conf.json"
    "shell/src-tauri/Cargo.toml"
    "shell/package.json"
    "shell/scripts"
    "tools"
    "env"
)
SCOPE_PATHS=()
for d in "${SCOPE[@]}"; do
    [ -e "$STAGE/$d" ] && SCOPE_PATHS+=("$STAGE/$d")
done

INCLUDES=(
    --include=*.java --include=*.js --include=*.css --include=*.html
    --include=*.rs --include=*.py --include=*.sh --include=*.cmd
    --include=*.json --include=*.toml
)
# 扫描器自己写在探针规则里、文档里也会提到这些词，排除掉
SELF_EXCLUDE=(-e "/tools/publish.sh" -e "/AGENT.md" -e "/README.md" -e "/NOTICE")

if [ ${#SCOPE_PATHS[@]} -gt 0 ]; then
    GENERIC="$(grep -rIlE '\$2a\$10\$|client_secret|ghp_[A-Za-z0-9]{20}|github_pat_|xoxb-|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY' \
        "${SCOPE_PATHS[@]}" "${INCLUDES[@]}" 2>/dev/null | grep -vF "${SELF_EXCLUDE[@]}" || true)"
    if [ -n "$GENERIC" ]; then
        echo "[publish] 疑似凭据特征（请人工确认）：" >&2
        echo "$GENERIC" | sed "s|$STAGE/||" >&2
        SCAN_FAIL=1
    fi

    # 只认这台机器的特征，避免撞上上游测试数据里的 /home/xxx
    LEAKS="$(grep -rIlE 'E:\\MCLab|C:\\Users\\Admin1' "${SCOPE_PATHS[@]}" "${INCLUDES[@]}" 2>/dev/null || true)"
    if [ -n "$LEAKS" ]; then
        echo "[publish] 发现本机绝对路径（请改成相对路径或 \$ROOT 变量）：" >&2
        echo "$LEAKS" | sed "s|$STAGE/||" >&2
        SCAN_FAIL=1
    fi
fi

# 不该出现的目录（docs / 运行态 / 打包产物）
for bad in docs dist-package .cache .hmcl .hmcl-dl; do
    if [ -e "$STAGE/$bad" ]; then
        echo "[publish] 白名单失效，混进了 $bad" >&2
        SCAN_FAIL=1
    fi
done

if [ "$SCAN_FAIL" -ne 0 ]; then
    echo "[publish] 体检未通过，已中止。暂存目录保留在 $STAGE 供排查" >&2
    exit 1
fi

FILES=$(find "$STAGE" -type f | wc -l)
SIZE=$(du -sh "$STAGE" | cut -f1)
echo "[publish] 体检通过：$FILES 个文件，$SIZE"
echo "[publish] 顶层内容："
ls -1 "$STAGE" | sed 's/^/    /'

if [ -z "$REMOTE" ]; then
    echo
    echo "[publish] 未指定 --remote，仅导出。目录：$STAGE"
    echo "[publish] 真正推送时加：--remote git@github.com:<账号>/<仓库>.git"
    exit 0
fi

# ---------------------------------------------------------------------------
# 单提交推送：公共仓库不继承本地历史
# ---------------------------------------------------------------------------
if [ "$YES" -ne 1 ]; then
    echo
    echo "[publish] 即将把上面的内容作为**一次全新提交**强推到 $REMOTE ($BRANCH)。"
    read -r -p "确认？[y/N] " answer
    case "$answer" in y|Y) ;; *) echo "[publish] 已取消"; exit 1 ;; esac
fi

cd "$STAGE"
git init -q -b "$BRANCH"
git add -A
AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git -C "$ROOT" config user.name || echo HopeStar)}"
AUTHOR_MAIL="${GIT_AUTHOR_EMAIL:-$(git -C "$ROOT" config user.email || echo noreply@localhost)}"
git -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_MAIL" \
    commit -q -m "chore: 开源发布 ${TAG:-$(date +%Y-%m-%d)}"

git remote add origin "$REMOTE"
git push -f -u origin "$BRANCH"

if [ -n "$TAG" ]; then
    git tag -a "$TAG" -m "HopeStar-MCLab $TAG"
    git push origin "$TAG"
    echo "[publish] 已推送 tag $TAG"
fi

echo "[publish] 完成。构建产物请走 GitHub Release 附件，不要提交进仓库。"
