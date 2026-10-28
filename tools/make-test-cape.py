"""生成一张测试披风，只用于验收渲染效果，不随启动器分发。

披风贴图是 64x32：
  (0,0)-(22,22)    披风本体图案（导入披风后实际看到的部分）
  (22,0)-(46,22)   原版鞘翅图案区。官方披风会在这里画翅膀花纹，
                   普通皮肤站的披风通常是空的，所以我们要支持两种取图方式。

用法：python tools/make-test-cape.py
"""
import json
import pathlib
import struct
import zlib

ROOT = pathlib.Path("E:/MCLab/.hmcl-demo/appearance")
CAPES = ROOT / "capes"
CAPES.mkdir(parents=True, exist_ok=True)

W, H = 64, 32
PNG_SIGNATURE = bytes((137, 80, 78, 71, 13, 10, 26, 10))


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def pixel(x, y):
    """披风本体画深蓝横条，鞘翅区画青色渐变，方便一眼区分用了哪套 UV。"""
    if x < 22 and y < 22:
        if (y // 3) % 2 == 0:
            return (36, 58, 120, 255)
        return (22, 34, 76, 255)
    if 22 <= x < 46 and y < 22:
        t = y / 22.0
        return (int(40 + 60 * t), int(150 - 40 * t), int(160 + 30 * t), 255)
    return (0, 0, 0, 0)


raw = bytearray()
for y in range(H):
    raw.append(0)  # PNG 每行的 filter type
    for x in range(W):
        raw.extend(pixel(x, y))

png = bytearray(PNG_SIGNATURE)
png.extend(chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)))
png.extend(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
png.extend(chunk(b"IEND", b""))

target = CAPES / "test-cape.png"
target.write_bytes(bytes(png))

index = ROOT / "capes.json"
entries = []
if index.is_file():
    try:
        entries = json.loads(index.read_text(encoding="utf-8")).get("entries", [])
    except Exception:
        entries = []
if not any(e.get("id") == "test-cape" for e in entries):
    entries.insert(0, {"id": "test-cape", "name": "测试披风", "hasElytra": False, "addedAt": 0})
index.write_text(json.dumps({"version": 1, "entries": entries}, ensure_ascii=False, indent=2),
                 encoding="utf-8")

print("written", target, target.stat().st_size, "bytes")
