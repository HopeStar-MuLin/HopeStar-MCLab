import io, os, glob, re

log = sorted(glob.glob('*.log'), key=os.path.getmtime)[-1]
lines = io.open(log, encoding='utf-8', errors='replace').read().splitlines()
cand = [l for l in lines if 'Launched process:' in l]
cmd = cand[-1].split('Launched process:', 1)[1]

out = io.open(os.path.join(os.environ.get('TEMP', '.'), 'cmdline.txt'), 'w', encoding='utf-8')
out.write(cmd.replace(chr(92), '/'))
out.close()

for kw in ['--versionType', 'launcher.brand', 'launcher.version', '--username']:
    for m in re.finditer(re.escape(kw), cmd):
        s = max(0, m.start() - 40)
        e = min(len(cmd), m.end() + 80)
        print(cmd[s:e].replace(chr(92), '/'))
        print('  ---')
print('TOTAL', len(cmd))
