#!/usr/bin/env python3
"""把 dist/HMCL.jar 打成一个双击即用的 Windows 目录 + 分发包。

产物:
    dist/HMCL/HMCL.exe     双击启动，内置 JRE，不需要装 Java
    dist/HMCL/runtime/     jlink 裁出来的运行时
    dist/HMCL/app/         HMCL.jar + JavaFX
    dist/HMCL-<ver>-win-x64.zip

用法:
    python tools/pack_exe.py
    python tools/pack_exe.py --no-zip
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JAR = ROOT / "dist" / "HMCL.jar"
APP = ROOT / "build" / "app"
JLINK = ROOT / "build" / "jlink"
ICON = ROOT / "build" / "icon.ico"
OUT = ROOT / "dist"
NAME = "HMCL"
VER = "3.17.0"

# HMCL 自己就是用这三个 jar 补 JavaFX，坐标一致即可
FX_VER = "21.0.8"
FX_ARTIFACTS = ["javafx-base", "javafx-graphics", "javafx-controls"]
FX_MIRROR = "https://mirrors.cloud.tencent.com/nexus/repository/maven-public/org/openjfx"

MODULES = ",".join([
    "java.base", "java.desktop", "java.logging", "java.management", "java.naming",
    "java.net.http", "java.prefs", "java.scripting", "java.security.jgss", "java.sql",
    "java.xml", "java.transaction.xa", "jdk.attach", "jdk.unsupported",
    "jdk.crypto.ec", "jdk.crypto.cryptoki", "jdk.localedata", "jdk.zipfs",
    "jdk.charsets", "jdk.jfr",
])


def java_home() -> Path:
    env = os.environ.get("JAVA_HOME")
    if env and (Path(env) / "bin" / "jlink.exe").exists():
        return Path(env)
    for base in (Path(r"C:\Program Files\Java"), Path(r"C:\Program Files\Eclipse Adoptium")):
        if base.is_dir():
            for d in sorted(base.glob("jdk-*"), reverse=True):
                if (d / "bin" / "jlink.exe").exists():
                    return d
    sys.exit("[x] 找不到 JDK（需要 jlink/jpackage，JDK 17+）")


def fetch_fx(dst: Path) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for art in FX_ARTIFACTS:
        target = dst / f"{art}-{FX_VER}-win.jar"
        if target.exists():
            print(f"[=] {target.name}")
            continue
        url = f"{FX_MIRROR}/{art}/{FX_VER}/{art}-{FX_VER}-win.jar"
        print(f"[+] {url}")
        with urllib.request.urlopen(url, timeout=180) as r, open(target, "wb") as f:
            shutil.copyfileobj(r, f)
        print(f"    {target.stat().st_size / 1048576:.1f} MiB")


def make_icon(jdk: Path) -> None:
    """把 256x256 PNG 包成 ICO（ICO 允许直接内嵌 PNG）。"""
    import struct
    png = ROOT / "HMCL/HMCL/src/main/resources/assets/img/icon@8x.png"
    if not png.exists():
        print("[!] 没有 icon@8x.png，用默认图标")
        return
    data = png.read_bytes()
    w, h = struct.unpack(">II", data[16:24])
    if (w, h) != (256, 256):
        print(f"[!] 图标不是 256x256（{w}x{h}），跳过")
        return
    ICON.parent.mkdir(parents=True, exist_ok=True)
    ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(data), 22) + data
    ICON.write_bytes(ico)


def run(cmd: list[str], **kw) -> None:
    print("$", " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def rmtree(p: Path) -> None:
    if not p.exists():
        return
    try:
        shutil.rmtree(p)
    except OSError:
        # 目录里还有进程占用的文件时（比如启动器正开着），退回系统删除
        subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(p)], check=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-zip", action="store_true")
    args = ap.parse_args()

    if not JAR.exists():
        sys.exit(f"[x] 先构件: {JAR} 不存在，跑 tools/build.cmd")

    jdk = java_home()
    print(f"[i] JDK: {jdk}")

    # 1) app 目录：主 jar + JavaFX
    rmtree(APP)
    APP.mkdir(parents=True)
    shutil.copy2(JAR, APP / "HMCL.jar")
    fetch_fx(APP)

    # 2) 裁运行时
    rmtree(JLINK)
    run([jdk / "bin" / "jlink", "--add-modules", MODULES, "--output", JLINK,
         "--strip-debug", "--no-man-pages", "--no-header-files", "--compress=2"])
    print(f"[ok] runtime: {sum(f.stat().st_size for f in JLINK.rglob('*') if f.is_file()) / 1048576:.0f} MiB")

    # 3) jpackage -> app-image（含 exe）
    make_icon(jdk)
    target = OUT / NAME
    rmtree(target)
    cmd = [jdk / "bin" / "jpackage", "--type", "app-image", "--name", NAME,
           "--app-version", VER, "--input", APP, "--main-jar", "HMCL.jar",
           "--main-class", "org.jackhuang.hmcl.Main", "--runtime-image", JLINK,
           "--dest", OUT, "--java-options", "-Xmx2G",
           "--java-options", "-Dfile.encoding=UTF-8",
           "--description", "Hello Minecraft! Launcher (self-built)"]
    if ICON.exists():
        cmd += ["--icon", ICON]
    run(cmd)

    size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1048576
    print(f"[ok] {target / (NAME + '.exe')}  目录 {size:.0f} MiB")

    # 4) 打包成 zip
    if not args.no_zip:
        zpath = OUT / f"{NAME}-{VER}-win-x64.zip"
        print(f"[i] 压缩 {zpath.name} ...")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for f in target.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(target.parent))
        print(f"[ok] {zpath}  {zpath.stat().st_size / 1048576:.0f} MiB")

    return 0


if __name__ == "__main__":
    sys.exit(main())
