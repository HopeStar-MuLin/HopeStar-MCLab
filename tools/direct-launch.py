"""不走 HMCL，直接用游戏进程的原始命令行启动一次，用来判断 --versionType 到底管不管用。

用法：
    python tools/direct-launch.py <pid> <new-version-type>

流程：读 pid 的命令行 → 杀掉该 pid → 改掉 versionType → 用同一份 argv 直接启动。
"""
import ctypes
import io
import os
import subprocess
import sys
import time
from ctypes import wintypes

CommandLineToArgvW = ctypes.windll.shell32.CommandLineToArgvW
CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)


def split(cmd):
    argc = ctypes.c_int(0)
    argv = CommandLineToArgvW(cmd, ctypes.byref(argc))
    return [argv[i] for i in range(argc.value)]


pid = sys.argv[1]
new_type = sys.argv[2]

raw = subprocess.run(
    ['powershell', '-NoProfile', '-Command',
     "(Get-CimInstance Win32_Process -Filter \"ProcessId=%s\").CommandLine" % pid],
    capture_output=True, text=True, encoding='utf-8').stdout.strip('\r\n')

if not raw:
    print('cannot read command line for pid', pid)
    raise SystemExit(1)

args = split(raw)
print('argv count:', len(args))
dropped = False
for i, a in enumerate(args):
    if a == '--versionType':
        print('old versionType:', args[i + 1])
        if new_type == 'DELETE':
            del args[i:i + 2]
            dropped = True
        else:
            args[i + 1] = new_type
        break

subprocess.run(['powershell', '-NoProfile', '-Command',
                "Stop-Process -Id %s -Force -ErrorAction SilentlyContinue" % pid])
time.sleep(1.5)
print('old process stopped')

log_path = os.path.join(os.environ.get('TEMP', '.'), 'direct-launch.log')
log = io.open(log_path, 'w', encoding='utf-8')
p = subprocess.Popen(
    args,
    cwd=r'E:\MCLab\dist-packageelease\.minecraft\versions\1.21.1-fabric-0.20.1',
    stdout=log, stderr=log, close_fds=True)
print('started pid', p.pid, 'versionType =', new_type, 'log:', log_path)
