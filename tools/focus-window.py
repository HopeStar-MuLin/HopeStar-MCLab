"""把标题含关键字的窗口提到前台并报出位置。用 ctypes 直接调 user32。"""
import ctypes
import sys
from ctypes import wintypes

u = ctypes.windll.user32
keyword = sys.argv[1] if len(sys.argv) > 1 else "Minecraft"

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
found = []


def cb(hwnd, _):
    if not u.IsWindowVisible(hwnd):
        return True
    n = u.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return True
    buf = ctypes.create_unicode_buffer(n + 1)
    u.GetWindowTextW(hwnd, buf, n + 1)
    if keyword.lower() in buf.value.lower():
        found.append((hwnd, buf.value))
    return True


u.EnumWindows(EnumWindowsProc(cb), 0)
if not found:
    print("no window matched:", keyword)
    raise SystemExit(1)

hwnd, title = found[0]
u.ShowWindow(hwnd, 9)          # SW_RESTORE
u.SetForegroundWindow(hwnd)
rect = wintypes.RECT()
u.GetWindowRect(hwnd, ctypes.byref(rect))
print("hwnd=%s title=%s rect=%d,%d,%d,%d" % (hwnd, title, rect.left, rect.top, rect.right, rect.bottom))
