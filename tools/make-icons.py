# 从 启动器图标.png 生成所有需要的图标尺寸。
#
# 用到的地方：
#   shell/src-tauri/icons/*      → exe 资源、任务栏、窗口、安装包
#   HMCL/.../assets/img/icon.png → JavaFX 模式的窗口图标 / 关于页
#   .../assets/web/img/logo.png  → 页面左上角品牌标
#
# 用法：python tools/make-icons.py
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "启动器图标.png")
TAURI = os.path.join(ROOT, "shell", "src-tauri", "icons")
JAVA_IMG = os.path.join(ROOT, "HMCL", "HMCL", "src", "main", "resources", "assets", "img")
WEB_IMG = os.path.join(ROOT, "HMCL", "HMCL", "src", "main", "resources", "assets", "web", "img")

# 源图四周留一点透明边的话小尺寸会显得更小，这里按需裁掉额外空白。
# 1200x1200 的图内容大约撑满，直接等比缩放即可。
def scaled(size: int) -> Image.Image:
    im = Image.open(SRC).convert("RGBA")
    return im.resize((size, size), Image.LANCZOS)


def save_png(path: str, size: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scaled(size).save(path, "PNG", optimize=True)


def main() -> None:
    # ---- Tauri ----
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [scaled(s) for s in ico_sizes]
    os.makedirs(TAURI, exist_ok=True)
    frames[-1].save(
        os.path.join(TAURI, "icon.ico"),
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=frames[:-1],
    )
    save_png(os.path.join(TAURI, "icon.png"), 1024)
    save_png(os.path.join(TAURI, "32x32.png"), 32)
    save_png(os.path.join(TAURI, "64x64.png"), 64)
    save_png(os.path.join(TAURI, "128x128.png"), 128)
    save_png(os.path.join(TAURI, "128x128@2x.png"), 256)
    for size in (30, 44, 71, 89, 107, 142, 150, 284, 310):
        save_png(os.path.join(TAURI, "Square%dx%dLogo.png" % (size, size)), size)
    save_png(os.path.join(TAURI, "StoreLogo.png"), 50)

    # ---- JavaFX 用的那几份（上游原图全是 HMCL 的方块 logo）----
    # FXUtils.setIcon() 在 Windows 上取 icon.png，Linux 取 icon@4x.png，
    # 首页标题取 icon-title.png；任何一处漏换都会在窗口标题栏露出上游图标。
    for name, size in (
        ("icon@2x.png", 64),
        ("icon@4x.png", 128),
        ("icon@8x.png", 256),
        ("icon-title.png", 24),
        ("icon-title@2x.png", 48),
        ("icon-mac.png", 256),
    ):
        save_png(os.path.join(JAVA_IMG, name), size)

    # ---- JavaFX 窗口图标 ----
    save_png(os.path.join(JAVA_IMG, "icon.png"), 256)

    # ---- 页面品牌标（CSS 里 18px 显示，给 128 够用）----
    save_png(os.path.join(WEB_IMG, "logo.png"), 128)

    print("icons written")
    for path in ("icon.ico", "icon.png"):
        full = os.path.join(TAURI, path)
        print("  ", path, os.path.getsize(full), "bytes")


if __name__ == "__main__":
    main()
