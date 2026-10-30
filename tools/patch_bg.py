import io

base = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web'

# ---------- index.html：背景层 ----------
p = base + r'\index.html'
s = io.open(p, encoding='utf-8').read()
old = '<body data-theme="light">'
new = '''<body data-theme="light">

<!-- 内置背景图。固定在下层（z-index:-2），内容整体浮在上面。
     上面盖一层可调的蒙层（--bg-shade）：亮色下提亮、暗色下压暗，
     保证不管背景多亮多花，正文对比度都够。 -->
<div class="app-bg" aria-hidden="true"></div>'''
assert old in s, 'body tag not found'
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8').write(s)
print('html ok')

# ---------- app.css ----------
p = base + r'\app.css'
css = '''

/* ================= 内置背景图 + 毛玻璃 =================
   结构照 QQ-Bot 桌面端那套：
   - 背景独立一层（fixed + z-index:-2），不参与布局
   - 上面盖一层 --bg-shade 蒙层调对比度（亮色提亮 / 暗色压暗）
   - 顶栏 / 侧栏 / 页头用 backdrop-filter 做真玻璃
   - 卡片用半透明面（不做 blur）——滚动区里挂一堆 backdrop-filter 会明显掉帧 */

:root {
  --bg-shade: rgba(246, 248, 252, .55);
  --glass: rgba(255, 255, 255, .6);
  --glass-line: rgba(255, 255, 255, .55);
  --surface: rgba(255, 255, 255, .78);
  --surface-2: rgba(248, 249, 252, .72);
  --surface-3: rgba(238, 240, 246, .72);
}

body[data-theme="dark"] {
  --bg-shade: rgba(8, 10, 16, .68);
  --glass: rgba(21, 23, 28, .58);
  --glass-line: rgba(255, 255, 255, .08);
  --surface: rgba(21, 23, 28, .74);
  --surface-2: rgba(28, 31, 38, .7);
  --surface-3: rgba(36, 40, 48, .7);
}

/* 整页底色交给背景图，body 本身透明 */
body { background: transparent; }

.app-bg {
  position: fixed;
  inset: 0;
  z-index: -2;
  background-image: url('img/background.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
}
.app-bg::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--bg-shade);
}

/* 顶栏 / 侧栏 / 页头：真毛玻璃 */
.titlebar,
.rail,
.page-head {
  background: var(--glass);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  backdrop-filter: blur(18px) saturate(160%);
}

.titlebar,
.page-head { border-bottom: 1px solid var(--glass-line); }
.rail { border-right: 1px solid var(--glass-line); }

/* 页面滚动体透明，背景图透出来 */
.page-body,
.content,
.desk-body { background: transparent; }

/* 卡片类：半透明面，不加 blur */
.card,
.instance-card,
.news-item,
.account-row,
.asset-card,
.login-card,
.settings-group .card {
  background: var(--surface);
}

/* 输入框在玻璃上要更实一点，不然打字看不清 */
input[type="text"],
input[type="password"],
textarea,
select { background: var(--surface-2); }

/* 设置页吸顶导航也是玻璃 */
.settings-nav {
  background: var(--glass);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  backdrop-filter: blur(16px) saturate(150%);
  border-color: var(--glass-line);
}

/* 弹窗：背后还有一层页面，玻璃让层次更自然 */
.modal-body {
  background: var(--surface);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  backdrop-filter: blur(24px) saturate(160%);
}

/* 下载任务小窗 */
.dl-popover {
  background: var(--glass);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  backdrop-filter: blur(20px) saturate(150%);
  border-color: var(--glass-line);
}
'''
with io.open(p, 'a', encoding='utf-8') as f:
    f.write(css)
print('css ok')
