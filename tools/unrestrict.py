#!/usr/bin/env python3
r"""去掉 HMCL 下载页的地域限制开关。

上游做法：在下载页里包一层 `if (<地域判断>) { 提示HintPane + setDisable(true) }`。
本脚本把「下载 UI 目录内」的地域判断直接替换成 false，使 else 分支（正常界面）生效。

只改 ui/download/ 和 ui/instances/ —— HMCLDownloadProvider 里的地域判断是
「CN 用户优先走 BMCLAPI 镜像」，属于加速逻辑，不能动。

用法:
    python tools/unrestrict.py --root .\HMCL --check     # 只看，不写
    python tools/unrestrict.py --root .\HMCL --apply     # 写回，生成 .bak
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 只在下载界面目录内动手
SCOPES = ("ui/download/", "ui/instances/")

# 上游历史版本用过的几种写法
PATTERNS = [
    # 新写法（PR #7017 起）
    (re.compile(r"RegionUtils\s*\.\s*is\w*China\w*\s*\(\s*\)"), "false"),
    # 旧写法（PR #7017 之前）
    (re.compile(r"LocaleUtils\s*\.\s*IS_CHINA_MAINLAND\b"), "false"),
    # 兜底：任何 RegionUtils.isChinaXxx() 形式
    (re.compile(r"\bRegionUtils\s*\.\s*isChina\w*\s*\(\s*\)"), "false"),
]

# 判据：文件里出现过这些标记，才认为是限制点
MARKERS = ("download.china", "IS_CHINA_MAINLAND", "isIsChinaMainlandNetwork",
           "isIsChinaMainlandMachine", "isChinaMainland")


def scope_of(path: Path) -> bool:
    p = path.as_posix()
    return any(s in p for s in SCOPES)


def process(path: Path, apply: bool) -> tuple[int, str | None]:
    src = path.read_text(encoding="utf-8")
    if not any(m in src for m in MARKERS):
        return 0, None

    out, hits = src, 0
    for pattern, repl in PATTERNS:
        out, n = pattern.subn(repl, out)
        hits += n

    if hits == 0:
        return 0, f"[!] {path.name}: 有标记但没匹配到判断式，需人工看"

    if out == src:
        return 0, None

    if apply:
        bak = path.with_suffix(path.suffix + ".bak")
        if not bak.exists():
            bak.write_text(src, encoding="utf-8")
        path.write_text(out, encoding="utf-8")

    return hits, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="HMCL", help="源码根目录（含 HMCL/src/main/java 的那层）")
    ap.add_argument("--check", action="store_true", help="只报告，不写文件")
    ap.add_argument("--apply", action="store_true", help="写回文件（自动 .bak）")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    java_root = root / "HMCL" / "src" / "main" / "java"
    if not java_root.is_dir():
        print(f"[x] 找不到 {java_root}")
        return 2

    apply = args.apply and not args.check
    total, touched, warnings = 0, 0, []

    for path in java_root.rglob("*.java"):
        if not scope_of(path):
            continue
        hits, warn = process(path, apply)
        if warn:
            warnings.append(warn)
        if hits:
            total += hits
            touched += 1
            print(f"[{'改' if apply else '待改'}] {path.relative_to(root)}  替换 {hits} 处")

    for w in warnings:
        print(w)

    if total == 0:
        print("[ok] 下载界面上没有地域限制代码（当前上游主分支就是这种状态）")
    else:
        print(f"[{'done' if apply else 'dry-run'}] 共 {touched} 个文件 / {total} 处")
        if not apply:
            print("      加 --apply 写回")

    return 0


if __name__ == "__main__":
    sys.exit(main())
