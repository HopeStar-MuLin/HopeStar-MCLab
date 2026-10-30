"""在整个 .minecraft 里找 "已修改"，普通文件和 zip 内部都查。"""
import io
import os
import sys
import zipfile

root = sys.argv[1] if len(sys.argv) > 1 else r'E:\MCLab\dist-packageelease\.minecraft'
needle = '已修改'.encode('utf-8')
skip = {'assets', 'libraries'}

hits = []
for dirpath, dirnames, filenames in os.walk(root):
    rel = os.path.relpath(dirpath, root)
    top = rel.split(os.sep)[0]
    if top in skip:
        dirnames[:] = []
        continue
    for fn in filenames:
        p = os.path.join(dirpath, fn)
        try:
            if fn.endswith(('.jar', '.zip')):
                with zipfile.ZipFile(p) as z:
                    for name in z.namelist():
                        try:
                            if needle in z.read(name):
                                hits.append('%s!%s' % (p, name))
                        except Exception:
                            pass
            else:
                if os.path.getsize(p) > 20_000_000:
                    continue
                with io.open(p, 'rb') as f:
                    if needle in f.read():
                        hits.append(p)
        except Exception:
            pass

print('root:', root)
for h in hits[:30]:
    print('HIT', h)
print('total', len(hits))
