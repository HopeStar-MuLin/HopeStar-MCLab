import io, json, os, struct, zlib, hashlib, pathlib, shutil

ROOT = pathlib.Path(r'E:/MCLab/.hmcl-demo/appearance')
SKINS = ROOT / 'skins'; CAPES = ROOT / 'capes'; STATE = ROOT / 'state'
for d in (SKINS, CAPES, STATE):
    d.mkdir(parents=True, exist_ok=True)


def write_png(path, width, height, pixel):
    """pixel(x, y) -> (r, g, b, a)"""
    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            r, g, b, a = pixel(x, y)
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    path.write_bytes(png)


def sha16(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:16]


# ---- 皮肤：直接复用 HMCL 自带皮肤 ----
src_dir = pathlib.Path(r'E:/MCLab/HMCL/HMCLCore/src/main/resources/assets/img/skin')
seed_skins = []
for name, model in (('wide/steve.png', 'default'), ('wide/alex.png', 'default'), ('slim/alex.png', 'slim')):
    src = src_dir / name
    if not src.exists():
        continue
    dst_name = f'{model}-{src.stem}.png'
    dst = SKINS / dst_name
    shutil.copyfile(src, dst)
    seed_skins.append({
        'id': dst.stem,
        'name': ('Steve' if 'steve' in src.stem else ('Alex 纤体' if model == 'slim' else 'Alex')),
        'model': model,
        'hasElytra': False,
        'addedAt': 1730000000000,
    })

# ---- 披风：生成两张 64x32 ----
def cape_pixel(x, y):
    if x < 12 and y < 18:
        band = (y // 3) % 2
        return (40, 70 + band * 60, 200, 255) if band else (20, 30, 60, 255)
    return (0, 0, 0, 0)


def elytra_pixel(x, y):
    if x < 12 and y < 18:
        band = (x // 3) % 2
        return (250, 80 + band * 60, 60, 255) if band else (120, 20, 20, 255)
    return (0, 0, 0, 0)


cape_a = CAPES / 'cape-deepblue.png'
write_png(cape_a, 64, 32, cape_pixel)
ely_a = CAPES / 'cape-deepblue.elytra.png'
write_png(ely_a, 64, 32, elytra_pixel)

cape_b = CAPES / 'cape-plain.png'
write_png(cape_b, 64, 32, lambda x, y: (30, 160, 90, 255) if (x < 12 and y < 18) else (0, 0, 0, 0))

capes = []
for path, has_elytra, label in ((cape_a, True, '深蓝（含鞘翅）'), (cape_b, False, '纯绿')):
    capes.append({
        'id': path.stem,
        'name': label,
        'hasElytra': has_elytra,
        'addedAt': 1730000000000,
    })

(ROOT / 'skins.json').write_text(json.dumps({'version': 1, 'entries': seed_skins}, ensure_ascii=False, indent=2), encoding='utf-8')
(ROOT / 'capes.json').write_text(json.dumps({'version': 1, 'entries': capes}, ensure_ascii=False, indent=2), encoding='utf-8')

state = {
    'skin': seed_skins[0]['id'] if seed_skins else None,
    'cape': 'cape-deepblue',
    'model': 'default',
    'capeMode': 'elytra',
}
(STATE / 'none.json').write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')

print('seeded skins:', [s['name'] for s in seed_skins])
print('seeded capes:', [c['name'] for c in capes])
print('state:', state)
