import io, os

p = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web\app.js'
lines = io.open(p, encoding='utf-8').read().split('\n')

# 找到边界（0-based）
start = next(i for i, l in enumerate(lines) if l.startswith('  function openLoaderModal(gameVersion) {'))
end = next(i for i, l in enumerate(lines) if l.startswith('  function initLoaderModal() {'))
print('replacing lines', start + 1, 'to', end)

new_js = '''  // ---------------- 安装新游戏（大弹窗） ----------------
  //
  // 结构照 HMCL 的 InstallersPage：Minecraft 卡片固定显示当前版本，
  // 其余是可选加载器。互斥关系取自 InstallerItemGroup 的 mutualIncompatible：
  // Forge / NeoForge / Fabric / Quilt 两两冲突，OptiFine 不参与互斥。

  var INSTALLER_ITEMS = [
    { id: '',         name: 'Minecraft', icon: 'img/grass.png',    fixed: true },
    { id: 'forge',    name: 'Forge',     icon: 'img/forge.png' },
    { id: 'neoforge', name: 'NeoForge',  icon: 'img/neoforge.png' },
    { id: 'optifine', name: 'OptiFine',  icon: 'img/optifine.png' },
    { id: 'fabric',   name: 'Fabric',    icon: 'img/fabric.png' },
    { id: 'quilt',    name: 'Quilt',     icon: 'img/quilt.png' }
  ];

  var MUTEX_LOADERS = ['forge', 'neoforge', 'fabric', 'quilt'];

  // 上一次自动填进输入框的实例名，用来判断用户有没有手动改过
  var imAutoName = '';

  function installerLabel(id) {
    for (var i = 0; i < INSTALLER_ITEMS.length; i++) {
      if (INSTALLER_ITEMS[i].id === id) { return INSTALLER_ITEMS[i].name; }
    }
    return id;
  }

  function defaultInstanceName() {
    if (!lmGame) { return ''; }
    if (!lmType) { return lmGame; }
    return lmGame + '-' + lmType + (lmVersion ? '-' + lmVersion : '');
  }

  /// 只有输入框还是「上次自动填的值」时才覆盖，用户改过就别动
  function syncDefaultName() {
    var input = document.getElementById('im-name');
    if (!input) { return; }
    if (!input.value || input.value === imAutoName) {
      imAutoName = defaultInstanceName();
      input.value = imAutoName;
    }
  }

  function openLoaderModal(gameVersion) {
    lmGame = gameVersion;
    lmType = '';
    lmVersion = null;
    lmVersions = null;
    imAutoName = '';

    document.getElementById('im-version').textContent = gameVersion;
    document.getElementById('im-name').value = '';
    syncDefaultName();
    renderInstallerCards();
    updateInstallButton();
    document.getElementById('loader-modal').classList.remove('hidden');
  }

  function closeLoaderModal() {
    document.getElementById('loader-modal').classList.add('hidden');
  }

  function renderInstallerCards() {
    var grid = document.getElementById('im-grid');
    if (!grid) { return; }
    grid.innerHTML = '';

    INSTALLER_ITEMS.forEach(function (item) {
      var card = el('div', 'im-card');
      if (item.fixed) { card.classList.add('fixed'); }
      if (item.id !== '' && lmType === item.id) { card.classList.add('on'); }

      var icon = document.createElement('img');
      icon.src = item.icon;
      icon.alt = item.name;
      card.appendChild(icon);
      card.appendChild(el('div', 'im-title', item.name));

      var sub;
      if (item.fixed) {
        sub = lmGame;
      } else if (lmType === item.id) {
        sub = lmVersion || '选择版本';
      } else if (lmType && MUTEX_LOADERS.indexOf(lmType) >= 0 && MUTEX_LOADERS.indexOf(item.id) >= 0) {
        sub = '与 ' + installerLabel(lmType) + ' 不兼容';
        card.classList.add('disabled');
      } else {
        sub = '未选择';
      }
      card.appendChild(el('div', 'im-sub', sub));

      if (lmType === item.id && lmVersion) {
        var again = el('button', 'im-again', '重选');
        again.addEventListener('click', function (e) {
          e.stopPropagation();
          openVersionPicker(item.id);
        });
        card.appendChild(again);
      }

      if (item.id !== '' && !card.classList.contains('disabled')) {
        card.addEventListener('click', function () { openVersionPicker(item.id); });
      }
      grid.appendChild(card);
    });
  }

  function updateInstallButton() {
    var btn = document.getElementById('lm-confirm');
    if (!btn) { return; }
    // 选原版随时可装；选了加载器就必须先把版本定下来
    btn.disabled = lmType !== '' && !lmVersion;
  }

  function openVersionPicker(type) {
    lmType = type;
    lmVersion = null;
    lmVersions = null;

    document.getElementById('ver-title').textContent = '选择 ' + installerLabel(type) + ' 版本';
    var list = document.getElementById('ver-list');
    list.innerHTML = '';
    list.appendChild(el('div', 'lm-empty', '正在拉取版本列表…'));
    document.getElementById('ver-modal').classList.remove('hidden');

    renderInstallerCards();
    updateInstallButton();
    call('requestLoaderVersions', lmGame, type);
  }

  function closeVersionPicker() {
    document.getElementById('ver-modal').classList.add('hidden');
  }

  function renderVersionPicker() {
    var list = document.getElementById('ver-list');
    if (!list) { return; }
    list.innerHTML = '';

    if (!lmVersions || !lmVersions.length) {
      list.appendChild(el('div', 'lm-empty',
        '这个游戏版本没有可用的 ' + installerLabel(lmType) + ' 版本。'));
      return;
    }

    lmVersions.slice(0, LM_MAX).forEach(function (v) {
      var row = el('div', 'lm-item' + (lmVersion === v ? ' on' : ''));
      row.appendChild(el('span', null, v));
      row.appendChild(el('span', 'lm-radio'));
      row.addEventListener('click', function () {
        lmVersion = v;
        closeVersionPicker();
        syncDefaultName();
        renderInstallerCards();
        updateInstallButton();
      });
      list.appendChild(row);
    });

    if (lmVersions.length > LM_MAX) {
      list.appendChild(el('div', 'lm-empty',
        '还有 ' + (lmVersions.length - LM_MAX) + ' 个更早的版本未显示。'));
    }
  }

  function confirmInstall() {
    if (!lmGame) { return; }
    var game = lmGame;
    var type = lmType;
    var version = lmVersion;
    var nameInput = document.getElementById('im-name');
    var name = nameInput ? nameInput.value.trim() : '';
    closeLoaderModal();

    if (!type) {
      var plainId = name || game;
      dlInstalling = plainId;
      renderDownloadList();
      call('installVersionNamed', game, name);
      return;
    }
    if (!version) { return; }

    var taskId = name || (game + '-' + type + '-' + version);
    dlInstalling = taskId;
    renderDownloadList();
    call('installLoaderNamed', game, type, version, name);
  }

  function initLoaderModal() {
    var modal = document.getElementById('loader-modal');
    if (!modal) { return; }

    document.getElementById('lm-close').addEventListener('click', closeLoaderModal);
    document.getElementById('lm-cancel').addEventListener('click', closeLoaderModal);
    document.getElementById('lm-confirm').addEventListener('click', confirmInstall);

    document.getElementById('im-name-clear').addEventListener('click', function () {
      document.getElementById('im-name').value = '';
    });
    document.getElementById('im-name-reset').addEventListener('click', function () {
      imAutoName = '';
      syncDefaultName();
    });

    document.getElementById('ver-close').addEventListener('click', closeVersionPicker);
    document.getElementById('ver-cancel').addEventListener('click', closeVersionPicker);
  }
'''

lines[start:end] = new_js.split('\n')
io.open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print('js replaced')
