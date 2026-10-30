"""把 dist-package/release 打成 dist/HopeStar-MCLab-<日期>.zip。

发布包结构（和 sidecar.rs 的查找逻辑一一对应）：

    HopeStar-MCLab/
    ├── HopeStar-MCLab.exe        壳
    ├── runtime/                  jlink 精简运行时（JDK）
    ├── data/                     启动器数据目录
    │   ├── HopeStar-MCLab.jar    Java 核心
    │   └── javafx/               JavaFX 模块
    └── README.txt

`.minecraft` 和 `data/config` 是运行时才生成的用户数据，不进包——
直接压整个目录会把 1.6G 的测试用 .minecraft 一起打进去。

用法：python tools/pack-debug.py [--date YYYY-MM-DD]
"""
import argparse
import datetime
import os
import subprocess
import sys
import zipfile

# 路径都从脚本位置推出来，不写死本机绝对路径
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "dist-package", "release")
DIST = os.path.join(ROOT, "dist")

# 产品名：zip 名、内层目录、exe 文件名都用它
PRODUCT = "HopeStar-MCLab"

# (源路径, 包内路径)。目录递归展开，文件原样写入。
ENTRIES = [
    ("hmcl-shell.exe", PRODUCT + ".exe"),
    ("README.txt", "README.txt"),
    ("runtime", "runtime"),
    ("data/" + PRODUCT + ".jar", "data/" + PRODUCT + ".jar"),
    ("data/javafx", "data/javafx"),
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=datetime.date.today().isoformat(),
                        help="文件名里的日期，默认今天")
    parser.add_argument("--src", default=SRC, help="待打包目录")
    parser.add_argument("--sign", action="store_true",
                        help="打包前给 exe 签名（证书从 SIGN_PFX / SIGN_THUMBPRINT 取）")
    parser.add_argument("--require-sign", action="store_true",
                        help="签名失败就中止（发布用）")
    args = parser.parse_args()

    src = args.src
    if not os.path.isdir(src):
        raise SystemExit("找不到待打包目录：%s（先构建 exe 和 jar 并复制进去）" % src)

    # 缺件要在打包前就报出来，否则打出一个跑不起来的包
    for rel, _ in ENTRIES:
        if not os.path.exists(os.path.join(src, rel)):
            raise SystemExit("缺少 %s，检查一下 dist-package 是否已更新" % rel)

    # 签名要在压包之前：签的是 zip 里那个 exe，不是临时副本。
    # 没配证书时脚本自己跳过，本地构建不受影响。
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
    out = os.path.join(DIST, "%s-%s.zip" % (PRODUCT, args.date))
    if os.path.exists(out):
        os.remove(out)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr(PRODUCT + "/", "")
        for rel, dst in ENTRIES:
            p = os.path.join(src, rel.replace("/", os.sep))
            if os.path.isfile(p):
                z.write(p, PRODUCT + "/" + dst)
                continue
            # 目录：连空目录一起写进去，解压出来的层级才跟宿主一致
            for dirpath, _dirnames, filenames in os.walk(p):
                sub = os.path.relpath(dirpath, src).replace(os.sep, "/")
                z.writestr(PRODUCT + "/" + sub + "/", "")
                for fn in filenames:
                    z.write(os.path.join(dirpath, fn), PRODUCT + "/" + sub + "/" + fn)

    print("size:", os.path.getsize(out))
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
    print("entries:", len(names))
    print("root:", sorted({n.split("/")[1] for n in names if n.count("/") >= 1}))


if __name__ == "__main__":
    main()
