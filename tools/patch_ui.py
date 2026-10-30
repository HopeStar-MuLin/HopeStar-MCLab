import io, os

base = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web'

# ---------- index.html ----------
p = os.path.join(base, 'index.html')
s = io.open(p, encoding='utf-8').read()
old = '''    <p class="muted small lm-tip" id="lm-tip">原版只装游戏本体。选加载器会在同一个实例里一起装好，之后可以直接拖模组进去。</p>'''
new = '''    <!-- 安装到：默认新建实例；同版本已有实例可以直接叠加加载器（HMCL 的「安装到现有实例」） -->
    <div class="lm-target" id="lm-target-wrap" hidden>
      <span>安装到</span>
      <select id="lm-target"></select>
    </div>

    <p class="muted small lm-tip" id="lm-tip">原版只装游戏本体。选加载器会在同一个实例里一起装好，之后可以直接拖模组进去。</p>'''
assert old in s, 'lm-tip not found'
s = s.replace(old, new)
io.open(p, 'w', encoding='utf-8').write(s)

# ---------- app.css ----------
p = os.path.join(base, 'app.css')
css = '''

/* ---------- 安装弹窗里的「安装到」 ---------- */
.lm-target {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: var(--sp-2) 0;
  font-size: 12.5px;
  color: var(--muted);
}
.lm-target select {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
}
'''
with io.open(p, 'a', encoding='utf-8') as f:
    f.write(css)

# ---------- app.js ----------
p = os.path.join(base, 'app.js')
s = io.open(p, encoding='utf-8').read()

# 1) openLoaderModal 里填充目标实例
old = '''    document.getElementById('loader-modal').classList.remove('hidden');
  }

  function closeLoaderModal() {'''
new = '''    fillLoaderTarget(gameVersion);
    document.getElementById('loader-modal').classList.remove('hidden');
  }

  /// 填充「安装到」下拉。只列**同游戏版本**的实例——版本对不上装不了，
  /// 列出来只会让人点出一个必然失败的任务。
  function fillLoaderTarget(gameVersion) {
    var wrap = document.getElementById('lm-target-wrap');
    var sel = document.getElementById('lm-target');
    if (!wrap || !sel) { return; }

    sel.innerHTML = '';
    var fresh = document.createElement('option');
    fresh.value = '';
    fresh.textContent = '新建实例';
    sel.appendChild(fresh);

    var matches = (state && state.instances ? state.instances : []).filter(function (inst) {
      return inst.gameVersion === gameVersion;
    });
    matches.forEach(function (inst) {
      var o = document.createElement('option');
      o.value = inst.id;
      o.textContent = inst.name + '（' + (inst.loader || '原版') + '）';
      sel.appendChild(o);
    });
    sel.value = '';
    // 没选加载器时整块隐藏，装原版没必要指定实例
    wrap.hidden = true;
  }

  function closeLoaderModal() {'''
assert old in s, 'openLoaderModal end not found'
s = s.replace(old, new)

# 2) selectLoaderType：切到具体加载器时显示「安装到」
old = '''    if (!type) {
      list.hidden = true;
      list.innerHTML = '';
      confirm.disabled = false;
      confirm.textContent = '安装原版';
      document.getElementById('lm-tip').textContent =
        '原版只装游戏本体。选加载器会在同一个实例里一起装好，之后可以直接拖模组进去。';
      return;
    }'''
new = '''    var targetWrap = document.getElementById('lm-target-wrap');
    if (targetWrap) { targetWrap.hidden = !type; }

    if (!type) {
      list.hidden = true;
      list.innerHTML = '';
      confirm.disabled = false;
      confirm.textContent = '安装原版';
      document.getElementById('lm-tip').textContent =
        '原版只装游戏本体。选加载器会在同一个实例里一起装好，之后可以直接拖模组进去。';
      return;
    }'''
assert old in s, 'selectLoaderType branch not found'
s = s.replace(old, new)

# 3) confirmInstall：有目标实例就走 installLoaderTo
old = '''    if (!version) { return; }

    var instanceName = game + '-' + type + '-' + version;
    dlInstalling = instanceName;
    renderDownloadList();
    call('installLoader', game, type, version);'''
new = '''    if (!version) { return; }

    var target = document.getElementById('lm-target');
    var instanceId = target ? target.value : '';
    if (instanceId) {
      // 装进已有实例：失败不会破坏原实例（草稿只在成功时提交）
      dlInstalling = instanceId;
      renderDownloadList();
      call('installLoaderTo', instanceId, game, type, version);
      return;
    }

    var instanceName = game + '-' + type + '-' + version;
    dlInstalling = instanceName;
    renderDownloadList();
    call('installLoader', game, type, version);'''
assert old in s, 'confirmInstall body not found'
s = s.replace(old, new)

io.open(p, 'w', encoding='utf-8').write(s)
print('frontend patched')
