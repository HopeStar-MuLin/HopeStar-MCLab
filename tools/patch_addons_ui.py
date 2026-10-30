import io

p = 'E:/MCLab/HMCL/HMCL/src/main/resources/assets/web/app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 实例表加「内容」列
old = """    [['实例', 'col-name'], ['版本 / 加载器', 'col-ver'], ['Java', 'col-java'],
      ['占用', 'col-size'], ['上次启动', 'col-time']].forEach(function (c) {
      head.appendChild(el('span', c[1], c[0]));
    });"""

new = """    [['实例', 'col-name'], ['版本 / 加载器', 'col-ver'], ['Java', 'col-java'],
      ['占用', 'col-size'], ['上次启动', 'col-time'], ['', 'col-act']].forEach(function (c) {
      head.appendChild(el('span', c[1], c[0]));
    });"""

assert old in s, 'table head not found'
s = s.replace(old, new, 1)

old2 = """      row.appendChild(el('span', 'muted col-time', fmtTime(inst.lastLaunch)));
      table.appendChild(row);"""

new2 = """      row.appendChild(el('span', 'muted col-time', fmtTime(inst.lastLaunch)));

      var act = el('span', 'col-act');
      var manage = el('button', 'link', '内容');
      manage.addEventListener('click', function () { openAddons(inst.id); });
      act.appendChild(manage);
      row.appendChild(act);

      table.appendChild(row);"""

assert old2 in s, 'table row not found'
s = s.replace(old2, new2, 1)

# 2) 弹层逻辑，插在 initDownload 之前
anchor = "  function initDownload() {"

logic = r"""  // ---------------- 实例内容（模组 / 资源包 / 光影） ----------------

  var addonsInstance = '';
  var addonsKind = 'mod';

  function openAddons(instanceId) {
    addonsInstance = instanceId;
    addonsKind = 'mod';
    var seg = document.getElementById('addons-kinds');
    var buttons = seg.querySelectorAll('button[data-addon-kind]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-addon-kind') === 'mod');
    }
    document.getElementById('addons-title').textContent = '实例内容 · ' + instanceId;

    var list = document.getElementById('addon-list');
    list.innerHTML = '';
    list.appendChild(el('div', 'empty', '正在读取…'));

    document.getElementById('addons-modal').classList.remove('hidden');
    call('instanceAddons', instanceId, addonsKind);
  }

  function closeAddons() {
    document.getElementById('addons-modal').classList.add('hidden');
  }

  function renderAddons(data) {
    var list = document.getElementById('addon-list');
    if (!list) { return; }
    list.innerHTML = '';

    if (!data || data.error) {
      list.appendChild(el('div', 'empty', (data && data.error) || '读取失败'));
      return;
    }

    var items = data.items || [];
    if (!items.length) {
      list.appendChild(el('div', 'empty', '这个目录下还没有内容'));
      return;
    }

    items.forEach(function (item) {
      var row = el('div', 'addon-row' + (item.disabled ? ' off' : ''));

      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !item.disabled;
      toggle.title = item.disabled ? '点击启用' : '点击禁用';
      toggle.addEventListener('change', function () {
        call('setAddonEnabled', addonsInstance, addonsKind, item.fileName, this.checked);
      });
      row.appendChild(toggle);

      var name = el('span', 'addon-name', item.name);
      name.title = item.name;
      row.appendChild(name);

      row.appendChild(el('span', 'addon-size', fmtSize(item.size || 0)));

      var remove = el('button', 'icon-btn', '✕');
      remove.title = '删除';
      remove.addEventListener('click', function () {
        askConfirm('删除「' + item.name + '」？').then(function (yes) {
          if (yes) { call('removeAddon', addonsInstance, addonsKind, item.fileName); }
        });
      });
      row.appendChild(remove);

      list.appendChild(row);
    });
  }

  /// 简单的是/否确认框。浏览器 confirm() 在 WebView2 里标题是页面域名，
  /// 和重命名那个 prompt 一个毛病，所以自己画一个（借用 name-modal，把输入框藏掉）。
  function askConfirm(message) {
    return new Promise(function (resolve) {
      var modal = document.getElementById('name-modal');
      var input = document.getElementById('name-input');
      if (!modal || !input) { resolve(false); return; }

      document.getElementById('name-title').textContent = message;
      input.value = '';
      input.style.display = 'none';
      modal.classList.remove('hidden');

      function cleanup(result) {
        modal.classList.add('hidden');
        input.style.display = '';
        document.getElementById('name-ok').onclick = null;
        document.getElementById('name-cancel').onclick = null;
        document.getElementById('name-close').onclick = null;
        resolve(result);
      }

      document.getElementById('name-ok').onclick = function () { cleanup(true); };
      document.getElementById('name-cancel').onclick = function () { cleanup(false); };
      document.getElementById('name-close').onclick = function () { cleanup(false); };
    });
  }

  function initAddonsModal() {
    var seg = document.getElementById('addons-kinds');
    if (!seg) { return; }

    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-addon-kind]');
      if (!btn) { return; }
      var buttons = seg.querySelectorAll('button[data-addon-kind]');
      for (var i = 0; i < buttons.length; i++) { buttons[i].classList.remove('active'); }
      btn.classList.add('active');
      addonsKind = btn.getAttribute('data-addon-kind');

      var list = document.getElementById('addon-list');
      list.innerHTML = '';
      list.appendChild(el('div', 'empty', '正在读取…'));
      call('instanceAddons', addonsInstance, addonsKind);
    });

    document.getElementById('addons-close').addEventListener('click', closeAddons);
    document.getElementById('addons-done').addEventListener('click', closeAddons);
  }

  function initDownload() {"""

assert anchor in s, 'initDownload anchor not found'
s = s.replace(anchor, logic, 1)

# 3) initUi 里初始化
old3 = "    initDownload();\n    preloadAppearanceData();"
assert old3 in s, 'initUi anchor not found'
s = s.replace(old3, "    initDownload();\n    initAddonsModal();\n    preloadAppearanceData();", 1)

# 4) 回调
old4 = "    onAddonVersions: function (json) {"
new4 = """    onInstanceAddons: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderAddons(data);
    },

    onAddonVersions: function (json) {"""

assert old4 in s, 'callback anchor not found'
s = s.replace(old4, new4, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
