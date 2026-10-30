import io

# ---------- SkinGallery / OffscreenPreview：给 root 加透明背景 ----------
p = r'E:\MCLab\HMCL\HMCL\src\main\java\org\jackhuang\hmcl\ui\web\SkinGallery.java'
s = io.open(p, encoding='utf-8').read()
old = '''        box = new Pane(canvas);
        box.setPrefSize(VIEW_W, VIEW_H);'''
new = '''        box = new Pane(canvas);
        // Scene 的根节点会吃到 Modena 的 `.root` 样式（-fx-background-color: #f4f4f4）。
        // 不显式清掉的话，截出来的图就是一层不透明的浅灰，
        // 暗色主题下卡片里会显出一块白板。
        box.setBackground(javafx.scene.layout.Background.EMPTY);
        box.setPrefSize(VIEW_W, VIEW_H);'''
assert old in s, 'SkinGallery box not found'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8').write(s)
print('gallery ok')

p2 = r'E:\MCLab\HMCL\HMCL\src\main\java\org\jackhuang\hmcl\ui\web\OffscreenPreview.java'
s2 = io.open(p2, encoding='utf-8').read()
old2 = '''        root = new javafx.scene.layout.Pane(canvas);
        root.setPrefSize(WIDTH, HEIGHT);'''
new2 = '''        root = new javafx.scene.layout.Pane(canvas);
        // 同上：根节点带 `.root` 样式，不清掉会截出不透明的浅灰底
        root.setBackground(javafx.scene.layout.Background.EMPTY);
        root.setPrefSize(WIDTH, HEIGHT);'''
assert old2 in s2, 'OffscreenPreview root not found'
s2 = s2.replace(old2, new2)
io.open(p2, 'w', encoding='utf-8').write(s2)
print('preview ok')

# ---------- hero 改白色毛玻璃 ----------
p3 = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web\app.css'
s3 = io.open(p3, encoding='utf-8').read()

old3 = '''  border-radius: var(--r-xl);
  /* 半透明品牌色 + 背景模糊：既保留主卡的视觉重心，又不是一块死板的实心块 */
  background: linear-gradient(120deg, rgba(91, 124, 250, .86) 0%, rgba(122, 107, 255, .86) 58%, rgba(155, 107, 255, .86) 100%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  backdrop-filter: blur(20px) saturate(160%);
  color: #fff;
  box-shadow: 0 10px 28px rgba(91, 124, 250, .22);'''

new3 = '''  border-radius: var(--r-xl);
  /* 白色毛玻璃，不再用品牌色渐变 */
  background: var(--hero-bg);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  backdrop-filter: blur(22px) saturate(160%);
  border: 1px solid var(--hero-line);
  color: var(--text);
  box-shadow: 0 10px 28px rgba(16, 24, 40, .08);'''

assert old3 in s3, 'hero style not found'
s3 = s3.replace(old3, new3)

# hero 里的幽灵按钮跟着换深色
old4 = '''.hero .btn.ghost { border-color: rgba(255, 255, 255, .45); color: #fff; }
.hero .btn.ghost:hover { background: rgba(255, 255, 255, .16); }'''
new4 = '''.hero .btn.ghost { border-color: var(--border-strong); color: var(--text); }
.hero .btn.ghost:hover { background: var(--surface-2); }
/* 暗色下背景更深，描边要提亮一点才看得见 */
body[data-theme="dark"] .hero .btn.ghost { border-color: rgba(255, 255, 255, .22); }'''
assert old4 in s3, 'hero ghost button not found'
s3 = s3.replace(old4, new4)

# hero 图标底板：原来给白字做衬托，现在底色是浅的，压一下
old5 = '''.hero-icon {
  width: 72px; height: 72px; flex: 0 0 72px;
  border-radius: var(--r-lg);
  background: rgba(255, 255, 255, .18);'''
new5 = '''.hero-icon {
  width: 72px; height: 72px; flex: 0 0 72px;
  border-radius: var(--r-lg);
  background: var(--hero-icon-bg);'''
if old5 in s3:
    s3 = s3.replace(old5, new5)

# 变量
old6 = '''  --bg-shade: rgba(246, 248, 252, .68);'''
new6 = '''  --bg-shade: rgba(246, 248, 252, .68);
  --hero-bg: rgba(255, 255, 255, .72);
  --hero-line: rgba(255, 255, 255, .65);
  --hero-icon-bg: rgba(16, 24, 40, .06);'''
assert old6 in s3, 'bg-shade var not found'
s3 = s3.replace(old6, new6)

old7 = '''  --bg-shade: rgba(8, 10, 16, .68);'''
new7 = '''  --bg-shade: rgba(8, 10, 16, .68);
  --hero-bg: rgba(28, 31, 38, .66);
  --hero-line: rgba(255, 255, 255, .1);
  --hero-icon-bg: rgba(255, 255, 255, .08);'''
assert old7 in s3, 'dark bg-shade var not found'
s3 = s3.replace(old7, new7)

io.open(p3, 'w', encoding='utf-8').write(s3)
print('css ok')
