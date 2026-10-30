#!/usr/bin/env python3
"""发一个版本：构建 → 更新热更新清单 → 提交 → 打 tag。

用法：
    python tools/release.py 318 --notes "修复了某某问题"
    python tools/release.py 318 --notes-file notes.txt

版本号规则：项目版本是 `3.<build>`（见 config/project.properties 的 versionRoot），
所以传 318 就是 3.318，tag 记作 `v3.318`。

做完这一步，还需要（脚本最后会把命令打出来）：
    git push origin main --tags
然后去 GitHub 建 Release，把 `dist/HopeStar-MCLab-<日期>.zip` 传上去。
用户端的「检查更新」读的是仓库里的 `update.json` + `update/HopeStar-MCLab.jar`，
走 jsDelivr 的 `@latest`，所以打完 tag 就自动生效，不用改代码。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST_JAR = ROOT / "dist" / "HopeStar-MCLab.jar"
UPDATE_DIR = ROOT / "update"
UPDATE_JAR = UPDATE_DIR / "HopeStar-MCLab.jar"
MANIFEST = ROOT / "update.json"


def run(cmd: list[str], env: dict | None = None) -> None:
    print("$ " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=ROOT, env=env)
    if result.returncode != 0:
        raise SystemExit(f"命令失败（{result.returncode}）：{' '.join(cmd)}")


def git_remote_slug() -> str:
    """从 origin 的 URL 里取 owner/repo。"""
    url = subprocess.run(["git", "config", "--get", "remote.origin.url"],
                         cwd=ROOT, capture_output=True, text=True).stdout.strip()
    url = url.removesuffix(".git")
    if "github.com" not in url:
        raise RuntimeError("origin 不是 GitHub 地址：" + url)
    parts = url.split("github.com")[-1].lstrip(":/").split("/")
    return f"{parts[0]}/{parts[1]}"


def jar_version(jar: Path) -> str:
    with zipfile.ZipFile(jar) as z:
        text = z.read("assets/hmcl.properties").decode("utf-8")
    for line in text.splitlines():
        if line.startswith("hmcl.version="):
            return line.split("=", 1)[1].strip()
    return ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("build", help="构建号，例如 318 对应版本 3.318")
    ap.add_argument("--notes", default="", help="更新说明（会显示在启动器的更新面板里）")
    ap.add_argument("--notes-file", help="从文件读更新说明")
    ap.add_argument("--skip-build", action="store_true", help="用现成的 dist jar，不重新构建")
    ap.add_argument("--no-commit", action="store_true", help="只改文件，不提交也不打 tag")
    args = ap.parse_args()

    version = f"3.{args.build}"
    notes = args.notes
    if args.notes_file:
        notes = Path(args.notes_file).read_text(encoding="utf-8").strip()

    if not args.skip_build:
        env = dict(os.environ)
        env.update({
            "BUILD_NUMBER": str(args.build),
            "VERSION_TYPE": "release",
            # 发行版暂不内置微软登录的 client id（Mojang 审核中）
            "MCLAB_DISABLE_MSAUTH": "1",
        })
        run(["./build.sh"], env=env)

    if not DIST_JAR.is_file():
        raise SystemExit("找不到 dist/HopeStar-MCLab.jar，先跑一次构建")

    built = jar_version(DIST_JAR)
    if built != version:
        raise SystemExit(
            f"jar 里的版本是 {built!r}，和要发的 {version!r} 对不上。\n"
            f"不重新构建的话，用户更新完还会看到「有新版本」。加 --skip-build 前先确认这一点。"
        )

    UPDATE_DIR.mkdir(exist_ok=True)
    shutil.copy2(DIST_JAR, UPDATE_JAR)

    data = {
        "version": version,
        "notes": notes,
        "jar": "update/HopeStar-MCLab.jar",
        "jarSize": UPDATE_JAR.stat().st_size,
    }
    MANIFEST.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[ok] update.json → {version}（{data['jarSize']} 字节）")

    if args.no_commit:
        return 0

    run(["git", "add", "update.json", "update/HopeStar-MCLab.jar"])
    run(["git", "-c", "core.quotepath=false", "commit", "-m",
         f"chore(release): v{version}\n\n{notes}".strip()])
    run(["git", "tag", "-a", f"v{version}", "-m", f"v{version}"])

    # 清 jsDelivr 缓存。不清的话客户端读到的还是上一版清单，
    # 会出现「检查更新拿到旧版本号、下载旧 jar」这种反向升级。
    try:
        url = git_remote_slug()
        for ref in ("@latest", "@main"):
            purge = f"https://purge.jsdelivr.net/gh/{url}{ref}/update.json"
            urllib.request.urlopen(purge, timeout=15).read()
            print(f"[ok] 已刷新 CDN 缓存：{ref}/update.json")
    except Exception as e:
        print(f"[!] 刷新 CDN 缓存失败（{e}），过几分钟再手动访问一次 purge.jsdelivr.net")

    print()
    print("接下来两步：")
    print("  1) git push origin main --tags")
    print("  2) 把 dist/HopeStar-MCLab-*.zip 传到 GitHub Release（tag 选 v%s）" % version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
