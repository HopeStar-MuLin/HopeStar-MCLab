#!/usr/bin/env python3
"""构建后自检：产物里有没有地域限制、下载源通不通。

用法:
    python tools/verify.py --jar dist/HopeStar-MCLab.jar
    python tools/verify.py --jar dist/HopeStar-MCLab.jar --offline   # 跳过联网检查
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

# 下载界面里一旦出现这些符号，说明地域限制还在
GATE_MARKERS = (
    b"isIsChinaMainlandNetwork",
    b"isIsChinaMainlandMachine",
    b"IS_CHINA_MAINLAND",
)

# 下载页 class（相对 jar 根）
DOWNLOAD_UI = [
    "org/jackhuang/hmcl/ui/download/VersionsPage.class",
    "org/jackhuang/hmcl/ui/instances/DownloadListPage.class",
]

# 镜像加速逻辑所在（这里应保留 RegionUtils，删了反而变慢）
MIRROR_CLASS = "org/jackhuang/hmcl/download/HMCLDownloadProvider.class"

SOURCES = [
    ("Mojang 版本清单", "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"),
    ("BMCLAPI 镜像", "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json"),
    ("Modrinth API", "https://api.modrinth.com/v2/search?limit=1"),
]


def check_jar(jar: Path) -> bool:
    if not jar.is_file():
        print(f"[x] 找不到 {jar}")
        return False

    ok = True
    with zipfile.ZipFile(jar) as zf:
        names = set(zf.namelist())

        for cls in DOWNLOAD_UI:
            if cls not in names:
                print(f"[!] jar 里没有 {cls}（可能改名了，需人工确认）")
                continue
            data = zf.read(cls)
            hit = [m.decode() for m in GATE_MARKERS if m in data]
            if hit:
                print(f"[x] {cls} 仍含限制符号: {hit}")
                ok = False
            else:
                print(f"[ok] {cls} 无地域限制符号")

        if MIRROR_CLASS in names:
            data = zf.read(MIRROR_CLASS)
            if b"RegionUtils" in data:
                print("[ok] 镜像加速逻辑保留（CN 用户仍优先 BMCLAPI）")
            else:
                print("[!] HMCLDownloadProvider 不再引用 RegionUtils，镜像选择可能失效")

    print(f"[ok] jar 大小 {jar.stat().st_size / 1024 / 1024:.1f} MiB")
    return ok


def check_network() -> bool:
    ok = True

    try:
        with urllib.request.urlopen(SOURCES[0][1], timeout=20) as r:
            m = json.load(r)
        latest = m["latest"]["release"]
        print(f"[ok] Mojang 清单可读：{len(m['versions'])} 个版本，最新正式版 {latest}")
    except Exception as e:
        print(f"[x] Mojang 清单失败: {type(e).__name__}: {e}")
        ok = False

    for name, url in SOURCES[1:]:
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                body = r.read()
            if name.startswith("Modrinth"):
                n = len(json.loads(body).get("hits", []))
                print(f"[ok] {name} 可用（搜索返回 {n} 条）")
            else:
                m = json.loads(body)
                print(f"[ok] {name} 可用（{len(m['versions'])} 个版本）")
        except Exception as e:
            print(f"[x] {name} 不可用: {type(e).__name__}: {e}")
            ok = False

    return ok


def jar_props(jar: Path) -> dict[str, str]:
    with zipfile.ZipFile(jar) as zf:
        text = zf.read("assets/hmcl.properties").decode("utf-8")
    out = {}
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def check_curseforge(jar: Path) -> bool:
    key = jar_props(jar).get("hmcl.curseforge.apikey", "")
    if not key:
        print("[!] CurseForge 未配置 API key（模组/整合包只能搜 Modrinth）")
        return True
    req = urllib.request.Request(
        "https://api.curseforge.com/v1/mods/search?gameId=432&pageSize=1&classId=6",
        headers={"x-api-key": key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            d = json.load(r)
        total = d.get("pagination", {}).get("totalCount")
        print(f"[ok] CurseForge API 可用（模组总数 {total}）")
        return True
    except Exception as e:
        print(f"[x] CurseForge API 失败: {type(e).__name__}: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar", default="dist/HopeStar-MCLab.jar")
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args()

    print("== 产物检查 ==")
    ok = check_jar(Path(args.jar))

    if not args.offline:
        print("\n== 下载源连通性 ==")
        ok = check_network() and ok
        ok = check_curseforge(Path(args.jar)) and ok

    print("\n结论:", "通过" if ok else "有问题，看上面 [x]")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
