import io

base = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web'

# ---------- app.js ----------
p = base + r'\app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 新增状态变量
old = '''  // 版本小窗当前针对的类型。**不改 lmType**——点了取消就该保持原样，
  // 否则「选 Forge → 点重选 → 取消」之后别的卡已经变灰了，退不回去。
  var verTargetType = '';'''
new = '''  // 版本小窗当前针对的类型。**不改 lmType**——点了取消就该保持原样，
  // 否则「选 Forge → 点重选 → 取消」之后别的卡已经变灰了，退不回去。
  var verTargetType = '';

  // 非空 = 弹窗开在「已有实例」模式：卡片显示已装版本，右上角给 ↻ 重装
  var imInstanceId = '';
  var imInstalled = {};   // componentId -> version'''
assert old in s, 'vars not found'
s = s.replace(old, new)

# 2) openLoaderModal 支持 instanceId
old2 = '''  function openLoaderModal(gameVersion) {
    lmGame = gameVersion;
    lmType = '';
    lmVersion = null;
    lmVersions = null;
    lmAddon = '';
    verTargetType = '';
    imAutoName = '';

    document.getElementById('im-version').textContent = gameVersion;
    document.getElementById('im-name').value = '';
    syncDefaultName();
    renderInstallerCards();
    updateInstallButton();
    document.getElementById('loader-modal').classList.remove('hidden');
  }'''
new2 = '''  function openLoaderModal(gameVersion, instanceId) {
    lmGame = gameVersion;
    lmType = '';
    lmVersion = null;
    lmVersions = null;
    lmAddon = '';
    verTargetType = '';
    imAutoName = '';
    imInstanceId = instanceId || '';
    imInstalled = {};

    document.getElementById('im-version').textContent = gameVersion;
    document.getElementById('im-name').value = '';
    syncDefaultName();
    renderInstallerCards();
    updateInstallButton();
    document.getElementById('loader-modal').classList.remove('hidden');

    // 已有实例模式：拉一遍它已经装了些什么
    if (imInstanceId) {
      call('instanceInstallers', imInstanceId);
    }
  }'''
assert old2 in s, 'openLoaderModal not found'
s = s.replace(old2, new2)

# 3) renderInstallerCards：已装组件优先显示版本 + ↻
old3 = '''      var sub = '';
      var blocked = false;

      if (item.fixed) {
        sub = lmGame;
      } else if (picked) {'''
new3 = '''      var sub = '';
      var blocked = false;
      var installedVer = imInstalled[item.id] || '';

      if (item.fixed) {
        sub = lmGame;
      } else if (installedVer) {
        // 已经装在这个实例上了：显示版本，右上角给 ↻ 重装
        sub = installedVer;
        card.classList.add('on');
        var redo = el('button', 'im-again im-reinstall', '↻');
        redo.title = '重新安装';
        redo.addEventListener('click', function (e) {
          e.stopPropagation();
          openVersionPicker(item.id);
        });
        card.appendChild(redo);
      } else if (picked) {'''
assert old3 in s, 'renderInstallerCards branch not found'
s = s.replace(old3, new3)

# 已装组件不该再被当作「选中」重复处理
old4 = '''      if (picked && !item.addon && !installedVer) {'''
if old4 not in s:
    old4 = '''      if (picked && !item.addon && lmVersion) {'''
    new4 = '''      if (picked && !item.addon && lmVersion && !installedVer) {'''
else:
    new4 = old4
if old4 in s:
    s = s.replace(old4, new4)

# 4) 已装组件的卡片不再触发「选择」
old5 = '''      if (item.id !== '' && !blocked) {
        card.addEventListener('click', function () {
          if (item.addon) {'''
new5 = '''      if (item.id !== '' && !blocked && !installedVer) {
        card.addEventListener('click', function () {
          if (item.addon) {'''
assert old5 in s, 'card click not found'
s = s.replace(old5, new5)

# 5) 新增回调
old6 = '''    onSettings: function (json) {'''
new6 = '''    onInstanceInstallers: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !imInstanceId) { return; }
      imInstalled = {};
      (data.installed || []).forEach(function (it) {
        if (it && it.id) { imInstalled[it.id] = it.version || ''; }
      });
      renderInstallerCards();
    },
    onSettings: function (json) {'''
assert old6 in s, 'onSettings slot not found'
s = s.replace(old6, new6)

# 6) 实例卡片加「加载器管理」按钮
old7 = '''      var edit = el('button', 'icon-edit', '✎');
      edit.title = '更换图标';
      edit.addEventListener('click', function (e) {
        e.stopPropagation();
        openIconPicker(inst.id);
      });
      card.appendChild(edit);'''
new7 = '''      var edit = el('button', 'icon-edit', '✎');
      edit.title = '更换图标';
      edit.addEventListener('click', function (e) {
        e.stopPropagation();
        openIconPicker(inst.id);
      });
      card.appendChild(edit);

      // 直接从这个实例进安装弹窗：已经装了的加载器会显示版本 + ↻
      var manage = el('button', 'icon-edit icon-manage', '⚙');
      manage.title = '加载器管理';
      manage.addEventListener('click', function (e) {
        e.stopPropagation();
        openLoaderModal(inst.gameVersion, inst.id);
      });
      card.appendChild(manage);'''
assert old7 in s, 'instance card edit btn not found'
s = s.replace(old7, new7)

io.open(p, 'w', encoding='utf-8').write(s)
print('js ok')

# ---------- tauri-shim.js ----------
p2 = base + r'\tauri-shim.js'
s2 = io.open(p2, encoding='utf-8').read()
old8 = '''      // getSettings 同理：拉回来直接塞给 onSettings'''
new8 = '''      // instanceInstallers 同理
      if (method === 'instanceInstallers') {
        return function (id) {
          post('instanceInstallers', [id]).then(function (r) {
            if (r && r.ok && r.data != null && window.__hmcl && window.__hmcl.onInstanceInstallers) {
              window.__hmcl.onInstanceInstallers(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
            }
          });
          return null;
        };
      }
      // getSettings 同理：拉回来直接塞给 onSettings'''
assert old8 in s2, 'shim slot not found'
s2 = s2.replace(old8, new8)
io.open(p2, 'w', encoding='utf-8').write(s2)
print('shim ok')

# ---------- app.css ----------
p3 = base + r'\app.css'
css = '''

/* 实例卡片上的第二个小按钮（加载器管理），跟换图标那个错开 */
.icon-manage { right: 34px; }
'''
with io.open(p3, 'a', encoding='utf-8') as f:
    f.write(css)
print('css ok')
