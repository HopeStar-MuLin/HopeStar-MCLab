import io, os, re

base = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web'

# ==================== index.html ====================
p = os.path.join(base, 'index.html')
s = io.open(p, encoding='utf-8').read()

start = s.find('<div class="modal hidden" id="loader-modal">')
assert start > 0, 'loader-modal not found'
# 找到这个 div 的结束：从 start 起做括号配对
depth = 0
i = start
while i < len(s):
    if s.startswith('<div', i):
        depth += 1
    elif s.startswith('</div', i):
        depth -= 1
        if depth == 0:
            end = s.find('>', i) + 1
            break
    i += 1

new_modal = '''<div class="modal hidden" id="loader-modal">
  <div class="modal-body card im-body">
    <div class="modal-head">
      <h3>安装新游戏 · <span id="im-version"></span></h3>
      <button class="icon-btn" id="lm-close">✕</button>
    </div>

    <div class="im-name-row">
      <span class="im-name-label">游戏实例名称</span>
      <input class="im-name" id="im-name" type="text" spellcheck="false" maxlength="60">
      <button class="icon-btn" id="im-name-clear" title="清空">✕</button>
      <button class="icon-btn" id="im-name-reset" title="恢复默认名称">↻</button>
    </div>

    <!-- 卡片网格：Minecraft 固定，其余是可选加载器。
         互斥关系照 HMCL 的 InstallerItemGroup：Forge / NeoForge / Fabric / Quilt 两两冲突，
         OptiFine 不和任何东西冲突。 -->
    <div class="im-grid" id="im-grid"></div>

    <div class="modal-actions">
      <button class="btn ghost" id="lm-cancel">取消</button>
      <button class="btn primary" id="lm-confirm" disabled>安装</button>
    </div>
  </div>
</div>

<!-- 选加载器版本的小窗 -->
<div class="modal hidden" id="ver-modal">
  <div class="modal-body card ver-body">
    <div class="modal-head">
      <h3 id="ver-title">选择版本</h3>
      <button class="icon-btn" id="ver-close">✕</button>
    </div>
    <div class="lm-list" id="ver-list"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="ver-cancel">取消</button>
    </div>
  </div>
</div>'''

s = s[:start] + new_modal + s[end:]
io.open(p, 'w', encoding='utf-8').write(s)
print('html ok')

# ==================== app.css ====================
p = os.path.join(base, 'app.css')
css = '''

/* ---------- 安装新游戏（大弹窗） ---------- */
.im-body { width: 660px; }

.im-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: var(--sp-3) 0 var(--sp-4);
}
.im-name-label { font-size: 12.5px; color: var(--muted); flex: none; }
.im-name {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.im-name:focus { outline: none; border-color: var(--accent); background: var(--surface); }

.im-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--sp-3);
}

.im-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 16px 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  cursor: pointer;
  transition: border-color var(--dur-fast), background var(--dur-fast), transform var(--dur-fast);
}
.im-card:hover { border-color: var(--accent); background: var(--surface); transform: translateY(-1px); }
.im-card img { width: 40px; height: 40px; object-fit: contain; image-rendering: pixelated; }

.im-card .im-title { font-size: 13px; font-weight: 600; color: var(--text); }
.im-card .im-sub { font-size: 11.5px; color: var(--muted); text-align: center; line-height: 1.35; }

/* Minecraft 本体：只是显示当前版本，不可点 */
.im-card.fixed { cursor: default; }
.im-card.fixed:hover { border-color: var(--border); background: var(--surface-2); transform: none; }
.im-card.fixed img { width: 44px; height: 44px; }

/* 选中：蓝边 + 淡蓝底 */
.im-card.on { border-color: var(--accent); background: var(--accent-soft); }
.im-card.on .im-title { color: var(--accent); }

/* 互斥：压暗 + 划掉，点了不响应 */
.im-card.disabled { opacity: .45; cursor: not-allowed; }
.im-card.disabled:hover { border-color: var(--border); background: var(--surface-2); transform: none; }

.im-again {
  position: absolute;
  top: 6px;
  right: 6px;
  border: 0;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
  font-family: inherit;
}

.ver-body { width: 380px; }
'''
with io.open(p, 'a', encoding='utf-8') as f:
    f.write(css)
print('css ok')
