"""把 dist-package/release 打成 dist/HopeStar-MCLab-<日期>-<variant>.zip。

出两个包：

    full（内置 Java 21）          约 62 MB
    HopeStar-MCLab/
    ├── HopeStar-MCLab.exe        壳
    ├── runtime/                  jlink 精简运行时（JDK 21，约 59MB）
    ├── data/                     启动器数据目录
    │   ├── HopeStar-MCLab.jar    Java 核心
    │   └── javafx/               JavaFX 模块
    └── README.txt

    lite（不内置 Java）           约 27 MB
    HopeStar-MCLab/
    ├── HopeStar-MCLab.exe
    ├── data/                     同上，但没有 runtime/
    └── README.txt

两个包用的是**同一个 exe**：`locate_java()` 先找 exe 旁的 runtime/，再找系统里
的 Java 21+，都没有就走 bootstrap 自动下载到 data/runtime/。所以 lite 包第一次
启动会自动补 Java，之后和 full 包完全一样。

README.txt 按 variant 改写：full 说「自带精简 Java 21」，lite 说「第一次打开会
自动装」，其余内容共用一份源文件（dist-package/release/README.txt）。

`.minecraft` 和 `data/config` 是运行时才生成的用户数据，不进包——
直接压整个目录会把 1.6G 的测试用 .minecraft 一起打进去。

用法：
    python tools/pack-debug.py              # 两个包都出
    python tools/pack-debug.py --variant full
    python tools/pack-debug.py --variant lite
"""
import argparse
import datetime
import os
import pathlib
import subprocess
import sys
import zipfile

# 路径都从脚本位置推出来，不写死本机绝对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "dist-package", "release")
DIST = os.path.join(ROOT, "dist")

# 产品名：zip 名、内层目录、exe 文件名都用它
PRODUCT = "HopeStar-MCLab"

# 公共条目 (源路径, 包内路径)。runtime 按 variant 单独插入。
BASE_ENTRIES = [
    ("hmcl-shell.exe", PRODUCT + ".exe"),
    # 发行包不带 README.txt：说明文档只在仓库和发布页，包里少一个文件
    # 就少一处「版本对不上」的麻烦（用户改了包里的说明，下次更新又变回去）
    ("data/" + PRODUCT + ".jar", "data/" + PRODUCT + ".jar"),
    ("data/javafx", "data/javafx"),
    # 下载引擎（aria2 1.37，取自 MTGet 项目的 bin/）。Java 下载和首次引导下载都走它，
    # 16 连接分块 + 多源自动切换；两个 variant 都要带
    ("data/bin", "data/bin"),
]

VARIANT_RUNTIME = {"full": True, "lite": False}

# README 里「Java 21」那一节的两个版本。全文共用一份源文件，打包时替换。
JAVA_SECTION_FULL = """自带精简 Java 21
--------------------------------------
压缩包里带了一个用 jlink 裁过的 Java 21（runtime\\ 目录，约 59 MB），
解压即用，不用另外装 Java，也不用管理员权限。双击就是主界面，没有启动画面和过渡动画。

如果 runtime\\ 被删掉或者损坏，启动器会自动退到系统里找 Java 21+（JAVA_HOME、
Program Files 下各家 JDK、系统 PATH）；实在找不到才联网下载一个补上，整个过程
有进度显示，失败会给出手动下载入口。

"""

JAVA_SECTION_LITE = """第一次打开会自动装一个 Java 21
--------------------------------------
这个包（lite）没带 Java。第一次双击时，启动器会先在你机器上找一遍（JAVA_HOME、
Program Files 下各家 JDK、系统 PATH）；找不到就自动下载一个 Java 21（约 45 MB，
只需一次）放到启动器自己的目录里，装好直接进主界面。下载过程有进度条，
失败会给出手动下载入口。

装好的 Java 只放在启动器目录下，不写注册表、不改系统环境变量；
整个文件夹拷走就能带走。下次启动就和带 Java 的版本没有区别了。

"""

RUNTIME_LINE_FULL = "runtime\\               Java 21 运行时（内置的，约 59 MB）"
RUNTIME_LINE_LITE = "runtime\\               第一次启动后自动装好的 Java 21"


def readme_for(src_readme, with_runtime):
    """按 variant 改写 README，返回写进 zip 的字节。

    发行包已经不带 README 了（BASE_ENTRIES 里没有这一项），源文件也删了。
    这里要能安全返回 None，否则打包会直接崩在「文件不存在」上 ——
    一个已经不再使用的说明文件，不该拦住整条打包链。
    """
    if not src_readme.exists():
        return None
    text = src_readme.read_text(encoding="utf-8-sig")

    section_start = text.index("自带精简 Java 21")
    section_end = text.index("游戏要的 Java 也会自己补")

    if with_runtime:
        text = text[:section_start] + JAVA_SECTION_FULL + text[section_end:]
    else:
        text = (text[:section_start] + JAVA_SECTION_LITE + text[section_end:])
        text = text.replace(RUNTIME_LINE_FULL, RUNTIME_LINE_LITE, 1)

    return ("\ufeff" + text).encode("utf-8")


def build(src, out_path, with_runtime, readme_bytes):
    entries = list(BASE_ENTRIES)
    if with_runtime:
        entries.insert(2, ("runtime", "runtime"))

    if os.path.exists(out_path):
        os.remove(out_path)

    count = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(PRODUCT + "/", "")
        for rel, dst in entries:
            p = os.path.join(src, rel.replace("/", os.sep))
            if os.path.isfile(p):
                if dst == "README.txt":
                    # 每个包写自己那份（源文件保持 full 的口径）。
                    # readme_bytes 为 None 表示源 README 已移除，直接跳过。
                    if readme_bytes:
                        z.writestr(PRODUCT + "/README.txt", readme_bytes)
                else:
                    z.write(p, PRODUCT + "/" + dst)
                count += 1
                continue
            # 目录：连空目录一起写进去，解压出来的层级才跟宿主一致
            for dirpath, _dirnames, filenames in os.walk(p):
                sub = os.path.relpath(dirpath, src).replace(os.sep, "/")
                z.writestr(PRODUCT + "/" + sub + "/", "")
                for fn in filenames:
                    z.write(os.path.join(dirpath, fn), PRODUCT + "/" + sub + "/" + fn)
                    count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=datetime.date.today().isoformat(),
                        help="文件名里的日期，默认今天")
    parser.add_argument("--src", default=SRC, help="待打包目录")
    parser.add_argument("--variant", choices=["full", "lite", "all"], default="all",
                        help="打哪个包：full 带 Java，lite 不带，all 出两个（默认）")
    parser.add_argument("--sign", action="store_true",
                        help="打包前给 exe 签名（证书从 SIGN_PFX / SIGN_THUMBPRINT 取）")
    parser.add_argument("--require-sign", action="store_true",
                        help="签名失败就中止（发布用）")
    args = parser.parse_args()

    src = args.src
    if not os.path.isdir(src):
        raise SystemExit("找不到待打包目录：%s（先构建 exe 和 jar 并复制进去）" % src)

    # 缺件要在打包前就报出来，否则打出一个跑不起来的包
    for rel, _ in BASE_ENTRIES:
        if not os.path.exists(os.path.join(src, rel)):
            raise SystemExit("缺少 %s，检查一下 dist-package 是否已更新" % rel)

    variants = ["full", "lite"] if args.variant == "all" else [args.variant]
    if "full" in variants and not os.path.isdir(os.path.join(src, "runtime")):
        raise SystemExit("要打 full 包，但 dist-package/release/runtime 不存在")

    # 签名要在压包之前：签的是 zip 里那个 exe，不是临时副本。
    # 两个包共用同一个 exe，签一次就够。没配证书时脚本自己跳过。
    if args.sign or os.environ.get("SIGN_PFX") or os.environ.get("SIGN_THUMBPRINT"):
        signer = os.path.join(ROOT, "tools", "sign-exe.py")
        cmd = [sys.executable, signer, os.path.join(src, "hmcl-shell.exe")]
        if args.require_sign:
            cmd.insert(2, "--require")
        print("[i] 签名：" + " ".join(cmd[2:]))
        rc = subprocess.call(cmd)
        if rc != 0:
            raise SystemExit("签名失败（rc=%d），已中止打包" % rc)

    os.makedirs(DIST, exist_ok=True)
    readme_path = pathlib.Path(src) / "README.txt"

    for variant in variants:
        with_runtime = VARIANT_RUNTIME[variant]
        out = os.path.join(DIST, "%s-%s-%s.zip" % (PRODUCT, args.date, variant))
        count = build(src, out, with_runtime, readme_for(readme_path, with_runtime))
        tag = "内置 Java 21" if with_runtime else "不内置 Java"
        print("%-5s %-12s %6.1f MB  %4d 个文件  %s"
              % (variant, tag, os.path.getsize(out) / 1048576, count,
                 os.path.basename(out)))


if __name__ == "__main__":
    main()
