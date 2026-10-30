import io

base = 'E:/MCLab/HMCL/HMCL/src/main/resources/assets/web/'

# ---------------- 1. HTML：修导入图标 ----------------
p = base + 'index.html'
s = io.open(p, encoding='utf-8').read()

old_svg = '<svg viewBox="0 0 24 24"><path d="M12 3v10m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>'
# 原来的 path 是「描边式」写法（m0 0l-4-4 这种），但全局 svg 是 fill 填充，
# 结果填成一坨横杠。换成纯填充图形。
new_svg = '<svg viewBox="0 0 24 24"><path d="M11 3h2v9.1l3.3-3.3 1.4 1.4L12 16.2 6.3 10.2l1.4-1.4L11 12.1zM4 18h16v2.4H4z"/></svg>'
assert old_svg in s, 'import svg not found'
s = s.replace(old_svg, new_svg, 1)

# 皮肤页用的 3D 库提前预取：它 477KB，等用户点进外观页再下会白一下
prefetch = '''  <!-- 外观页的 3D 库较大，空闲时先抓下来；进页面就不用等 -->
  <link rel="prefetch" href="vendor/skinview3d.bundle.js">
  <link rel="prefetch" href="img/background.png">
'''
anchor = '</head>'
assert anchor in s
s = s.replace(anchor, prefetch + anchor, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('html ok')


# ---------------- 2. CSS ----------------
p = base + 'app.css'
s = io.open(p, encoding='utf-8').read()

# 图标底色：透明图标（羽毛、绿宝石那些）后面不该垫一块灰方块
s = s.replace("""  border-radius: var(--r-md);
  object-fit: cover;
  background: var(--surface-3);
  image-rendering: auto;
}""",
"""  border-radius: var(--r-md);
  object-fit: cover;
  /* 图标本身通常带 alpha，垫底色会让它看起来像贴在一张灰卡片上 */
  background: none;
  image-rendering: auto;
}""", 1)

s += """

/* ---------- 内容列表的空状态 ----------
   之前 .empty 在 grid 里只占一格、贴着顶部。这里让它跨满整行并撑高，
   视觉上居中在列表区中间。 */
.ad-grid > .empty {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  max-width: none;
  text-align: center;
  line-height: 1.7;
}

/* ---------- 自绘下拉 ----------
   原生 <select> 的弹层在 WebView2 里是系统样式（灰底方角），
   和整个玻璃面板完全不搭，所以把 select 藏起来、自己画一个。 */
.cs-wrap { position: relative; flex: none; }

/* 原生 select 保留在 DOM 里（value / options / change 都在用它），只是看不见 */
.cs-native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  pointer-events: none;
}

.cs-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color var(--dur-fast), background var(--dur-fast);
}
.cs-btn:hover { background: var(--surface); }
.cs-btn.open { border-color: var(--accent); background: var(--surface); }

.cs-caret {
  width: 12px;
  height: 12px;
  flex: none;
  opacity: .55;
  transition: transform var(--dur-fast);
}
.cs-btn.open .cs-caret { transform: rotate(180deg); }

.cs-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 70;
  min-width: 100%;
  padding: 5px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-pop);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  backdrop-filter: blur(18px) saturate(160%);
}
.cs-menu.hidden { display: none; }

.cs-item {
  padding: 7px 10px;
  border-radius: var(--r-sm);
  color: var(--text);
  font-size: 12.5px;
  white-space: nowrap;
  cursor: pointer;
}
.cs-item:hover { background: var(--surface-2); }
.cs-item.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
"""

io.open(p, 'w', encoding='utf-8').write(s)
print('css ok')
