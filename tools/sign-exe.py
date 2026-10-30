#!/usr/bin/env python3
"""给 exe 做 Authenticode 签名（signtool 封装）。

证书从环境变量取，三种来源按优先级：

    SIGN_PFX          证书文件（.pfx / .p12）
    SIGN_PFX_PASS     上面的密码
    SIGN_THUMBPRINT   证书存储里的指纹（证书装在本机时用这个）

可选：
    SIGN_TIMESTAMP    时间戳服务器，默认 http://timestamp.digicert.com
    SIGN_NAME         期望的签名主体，用于签完自检（如 "HopeStar-MCLab"）

用法：
    python tools/sign-exe.py dist-package/release/hmcl-shell.exe
    python tools/sign-exe.py --require dist-package/release/hmcl-shell.exe
    python tools/sign-exe.py --check dist-package/release/hmcl-shell.exe   # 只看有没有签名

没配证书时默认「跳过并退出 0」——本地构建不该因为有或没有证书而失败；
CI 里加 --require，证书缺失就直接报错。
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

TIMESTAMP_DEFAULT = "http://timestamp.digicert.com"


def find_signtool() -> str | None:
    """PATH 里没有就翻 Windows SDK 的目录，取版本号最大的那个。"""
    hit = shutil.which("signtool")
    if hit:
        return hit
    kits = Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Windows Kits" / "10" / "bin"
    if not kits.is_dir():
        return None
    best: tuple[tuple[int, ...], Path] | None = None
    for d in kits.iterdir():
        exe = d / "x64" / "signtool.exe"
        if not exe.is_file():
            continue
        try:
            key = tuple(int(x) for x in d.name.split("."))
        except ValueError:
            continue
        if best is None or key > best[0]:
            best = (key, exe)
    return str(best[1]) if best else None


def sign_args() -> list[str] | None:
    """按环境变量拼证书参数；一个都没配就返回 None。"""
    pfx = os.environ.get("SIGN_PFX")
    if pfx:
        args = ["/f", pfx]
        if os.environ.get("SIGN_PFX_PASS"):
            args += ["/p", os.environ["SIGN_PFX_PASS"]]
        return args
    thumb = os.environ.get("SIGN_THUMBPRINT")
    if thumb:
        return ["/sha1", thumb.replace(" ", "")]
    return None


def run(cmd: list[str]) -> int:
    print("> " + subprocess.list2cmdline(cmd))
    return subprocess.call(cmd)


def verify(signtool: str, target: Path) -> bool:
    """签名自检：/pa 按默认策略校验，能过才算真的签上了。"""
    return run([signtool, "verify", "/pa", "/q", str(target)]) == 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", help="要签的可执行文件")
    ap.add_argument("--require", action="store_true", help="没配证书就报错（CI 用）")
    ap.add_argument("--check", action="store_true", help="只检查签名状态，不签")
    ap.add_argument("--skip-verify", action="store_true",
                    help="签完不做 /pa 校验（自签证书测流程时用，正式证书别加）")
    args = ap.parse_args()
    if os.environ.get("SIGN_SKIP_VERIFY") == "1":
        args.skip_verify = True

    signtool = find_signtool()
    if not signtool:
        print("[x] 找不到 signtool，装一个 Windows SDK（含 Signing Tools）再来", file=sys.stderr)
        return 2 if args.require else 0
    print("[i] signtool: " + signtool)

    targets = [Path(f).resolve() for f in args.files]
    for t in targets:
        if not t.is_file():
            print(f"[x] 文件不存在：{t}", file=sys.stderr)
            return 2

    if args.check:
        for t in targets:
            ok = verify(signtool, t)
            print(("[ok] 已签名：" if ok else "[!] 未签名或签名无效：") + str(t))
        return 0

    cert = sign_args()
    if not cert:
        msg = "[!] 没配证书（SIGN_PFX / SIGN_THUMBPRINT），跳过签名"
        print(msg, file=sys.stderr if args.require else sys.stdout)
        return 2 if args.require else 0

    ts = os.environ.get("SIGN_TIMESTAMP", TIMESTAMP_DEFAULT)
    for t in targets:
        cmd = [signtool, "sign", "/fd", "sha256", "/td", "sha256", "/tr", ts] + cert + [str(t)]
        if run(cmd) != 0:
            print(f"[x] 签名失败：{t}", file=sys.stderr)
            return 1
        if not args.skip_verify and not verify(signtool, t):
            print(f"[x] 签完自检没过（证书链可能不受信任）：{t}", file=sys.stderr)
            return 1
        print("[ok] 已签名：" + str(t))

    want = os.environ.get("SIGN_NAME")
    if want:
        # 只做提示，不阻断：证书主体名和产品名本来就可以不一样
        print(f"[i] 期望签名主体包含：{want}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
