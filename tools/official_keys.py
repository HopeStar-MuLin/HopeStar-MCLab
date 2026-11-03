#!/usr/bin/env python3
"""从官方 HMCL 包里取两个运行时凭据，供自编译版使用。

官方 CI 编译时把凭据写进 assets/hmcl.properties：
    hmcl.microsoft.auth.id  -> 微软正版登录的 OAuth client id
    hmcl.curseforge.apikey  -> CurseForge 内容源的 API key

自编译版这两项默认为空，表现为「不能正版登录」「搜不到 CurseForge 模组」。
本脚本从官方包里读出来，输出成 shell 可 source 的环境文件。

用法:
    python tools/official_keys.py --jar .cache/HMCL-official.jar --out .cache/keys.env
    source .cache/keys.env && tools/build.sh
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

PROPS = "assets/hmcl.properties"
WANT = {
    "hmcl.microsoft.auth.id": "MICROSOFT_AUTH_ID",
    "hmcl.curseforge.apikey": "CURSEFORGE_API_KEY",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar", required=True, help="官方 HMCL-*.jar")
    ap.add_argument("--out", default=".cache/keys.env")
    ap.add_argument("--format", choices=("sh", "cmd"), default="sh")
    args = ap.parse_args()

    jar = Path(args.jar)
    if not jar.is_file():
        print(f"[x] 找不到 {jar}")
        return 1

    with zipfile.ZipFile(jar) as zf:
        try:
            text = zf.read(PROPS).decode("utf-8")
        except KeyError:
            print(f"[x] 包里没有 {PROPS}，不是官方构建？")
            return 1

    props = {}
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            props[k.strip()] = v.strip()

    lines, missing = [], []
    for key, env in WANT.items():
        val = props.get(key, "")
        if val:
            lines.append(f"set \"{env}={val}\"" if args.format == "cmd" else f"{env}='{val}'")
            print(f"[ok] {env} = {val[:8]}…（{len(val)} 字符）")
        else:
            missing.append(key)
            print(f"[!] {key} 为空，跳过")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[ok] 写入 {out}")

    return 0 if lines else 1


if __name__ == "__main__":
    sys.exit(main())
