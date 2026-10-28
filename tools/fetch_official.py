#!/usr/bin/env python3
"""下载官方 HMCL 发行包到 .cache/HMCL-official.jar（只为取两个运行时凭据）。

用法:
    python tools/fetch_official.py
    python tools/fetch_official.py --tag v3.16.4
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.request
from pathlib import Path

API = "https://api.github.com/repos/HMCL-dev/HMCL/releases/"
DEST = Path(".cache/HMCL-official.jar")


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "hmcl-local-build"})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="latest", help="latest 或 v3.16.4")
    args = ap.parse_args()

    rel = get_json(API + ("latest" if args.tag == "latest" else f"tags/{args.tag}"))
    jar = next((a for a in rel["assets"] if a["name"].endswith(".jar")), None)
    if not jar:
        print("[x] 这个 release 没有 .jar 资产")
        return 1

    DEST.parent.mkdir(parents=True, exist_ok=True)
    print(f"[i] {rel['tag_name']} -> {jar['name']} ({jar['size'] / 1048576:.1f} MiB)")
    req = urllib.request.Request(jar["browser_download_url"], headers={"User-Agent": "hmcl-local-build"})
    with urllib.request.urlopen(req, timeout=300) as r, open(DEST, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)

    print(f"[ok] 已保存 {DEST} ({DEST.stat().st_size / 1048576:.1f} MiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
