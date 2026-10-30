import io

p = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web\app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 卡片列表 + 互斥表
old_items = '''  var INSTALLER_ITEMS = [
    { id: '',         name: 'Minecraft', icon: 'img/grass.png',    fixed: true },
    { id: 'forge',    name: 'Forge',     icon: 'img/forge.png' },
    { id: 'neoforge', name: 'NeoForge',  icon: 'img/neoforge.png' },
    { id: 'optifine', name: 'OptiFine',  icon: 'img/optifine.png' },
    { id: 'fabric',   name: 'Fabric',    icon: 'img/fabric.png' },
    { id: 'quilt',    name: 'Quilt',     icon: 'img/quilt.png' }
  ];

  var MUTEX_LOADERS = ['forge', 'neoforge', 'fabric', 'quilt'];'''

new_items = '''  var INSTALLER_ITEMS = [
    { id: '',          name: 'Minecraft',  icon: 'img/grass.png',    fixed: true },
    { id: 'forge',     name: 'Forge',      icon: 'img/forge.png' },
    { id: 'neoforge',  name: 'NeoForge',   icon: 'img/neoforge.png' },
    { id: 'optifine',  name: 'OptiFine',   icon: 'img/optifine.png' },
    { id: 'fabric',    name: 'Fabric',     icon: 'img/fabric.png' },
    { id: 'fabricapi', name: 'Fabric API', icon: 'img/fabric.png', addon: true },
    { id: 'quilt',     name: 'Quilt',      icon: 'img/quilt.png' },
    { id: 'quiltapi',  name: 'QSL/QFAPI',  icon: 'img/quilt.png', addon: true }
  ];

  /// 照抄 `ui/InstallerItem.java` 的 incompatibleMap（去掉 cleanroom / liteloader /
  /// legacyfabric，我们没那几张卡）。每一对都是双向互斥。
  /// 注意 OptiFine 也参与互斥——它只和 Forge 能共存。
  var INCOMPATIBLE = {
    forge:     ['fabric', 'quilt', 'neoforge'],
    fabric:    ['forge', 'quilt', 'neoforge'],
    quilt:     ['forge', 'fabric', 'neoforge'],
    neoforge:  ['forge', 'fabric', 'quilt'],
    optifine:  ['fabric', 'quilt', 'neoforge'],
    fabricapi: ['forge', 'neoforge', 'optifine', 'quiltapi'],
    quiltapi:  ['forge', 'fabric', 'neoforge', 'optifine', 'fabricapi']
  };

  /// 附属组件跟在谁后面装（`isModLoader()` 为 false，不能单独装）
  var ADDON_NEEDS = { fabricapi: 'fabric', quiltapi: 'quilt' };'''

assert old_items in s, 'INSTALLER_ITEMS not found'
s = s.replace(old_items, new_items)

# 2) 变量：附加组件 + 版本小窗的目标类型
old_vars = '''  // 上一次自动填进输入框的实例名，用来判断用户有没有手动改过
  var imAutoName = '';'''
new_vars = '''  // 上一次自动填进输入框的实例名，用来判断用户有没有手动改过
  var imAutoName = '';

  // 附属组件（fabric-api / quilt-api）：勾选状态，随主加载器一起装
  var lmAddon = '';

  // 版本小窗当前针对的类型。**不改 lmType**——点了取消就该保持原样，
  // 否则「选 Forge → 点重选 → 取消」之后别的卡已经变灰了，退不回去。
  var verTargetType = '';'''
assert old_vars in s, 'imAutoName not found'
s = s.replace(old_vars, new_vars)

# 3) openLoaderModal 重置新状态
old_open = '''  function openLoaderModal(gameVersion) {
    lmGame = gameVersion;
    lmType = '';
    lmVersion = null;
    lmVersions = null;
    imAutoName = '';'''
new_open = '''  function openLoaderModal(gameVersion) {
    lmGame = gameVersion;
    lmType = '';
    lmVersion = null;
    lmVersions = null;
    lmAddon = '';
    verTargetType = '';
    imAutoName = '';'''
assert old_open in s, 'openLoaderModal head not found'
s = s.replace(old_open, new_open)

# 4) renderInstallerCards 重写
start = s.find('  function renderInstallerCards() {')
end = s.find('  function updateInstallButton() {')
assert start > 0 and end > start

new_render = '''  function renderInstallerCards() {
    var grid = document.getElementById('im-grid');
    if (!grid) { return; }
    grid.innerHTML = '';

    var activeIds = [];
    if (lmType) { activeIds.push(lmType); }
    if (lmAddon) { activeIds.push(lmAddon); }

    INSTALLER_ITEMS.forEach(function (item) {
      var card = el('div', 'im-card');
      if (item.fixed) { card.classList.add('fixed'); }

      var picked = item.id !== '' && (lmType === item.id || lmAddon === item.id);
      if (picked) { card.classList.add('on'); }

      var icon = document.createElement('img');
      icon.src = item.icon;
      icon.alt = item.name;
      card.appendChild(icon);
      card.appendChild(el('div', 'im-title', item.name));

      var sub = '';
      var blocked = false;

      if (item.fixed) {
        sub = lmGame;
      } else if (picked) {
        sub = item.addon
          ? ('随 ' + installerLabel(ADDON_NEEDS[item.id]) + ' 安装')
          : (lmVersion || '选择版本');
      } else if (item.addon) {
        var need = ADDON_NEEDS[item.id];
        if (lmType !== need) {
          // 主加载器没选对：已经选了别的就报不兼容，什么都没选就说缺什么
          sub = lmType ? ('与 ' + installerLabel(lmType) + ' 不兼容') : ('需要 ' + installerLabel(need));
          blocked = true;
        } else {
          var addonClash = clashWith(item.id, activeIds);
          if (addonClash) { sub = '与 ' + installerLabel(addonClash) + ' 不兼容'; blocked = true; }
          else { sub = '可选'; }
        }
      } else {
        var clash = clashWith(item.id, activeIds);
        if (clash) { sub = '与 ' + installerLabel(clash) + ' 不兼容'; blocked = true; }
        else { sub = '未选择'; }
      }

      if (blocked) { card.classList.add('disabled'); }
      card.appendChild(el('div', 'im-sub', sub));

      if (picked && !item.addon && lmVersion) {
        var again = el('button', 'im-again', '重选');
        again.addEventListener('click', function (e) {
          e.stopPropagation();
          openVersionPicker(item.id);
        });
        card.appendChild(again);
      }

      if (item.id !== '' && !blocked) {
        card.addEventListener('click', function () {
          if (item.addon) {
            lmAddon = (lmAddon === item.id) ? '' : item.id;
            syncDefaultName();
            renderInstallerCards();
            updateInstallButton();
          } else {
            openVersionPicker(item.id);
          }
        });
      }
      grid.appendChild(card);
    });
  }

  /// item 与当前已选的组件是否冲突，返回冲突的那个 id
  function clashWith(itemId, activeIds) {
    for (var i = 0; i < activeIds.length; i++) {
      var list = INCOMPATIBLE[activeIds[i]] || [];
      if (list.indexOf(itemId) >= 0) { return activeIds[i]; }
    }
    return null;
  }

'''
s = s[:start] + new_render + s[end:]

# 5) openVersionPicker：不动 lmType
old_picker = '''  function openVersionPicker(type) {
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
  }'''
new_picker = '''  function openVersionPicker(type) {
    // 只记「这次在给谁选」，不动 lmType——用户点取消时其他卡片应该还是原样
    verTargetType = type;
    lmVersions = null;

    document.getElementById('ver-title').textContent = '选择 ' + installerLabel(type) + ' 版本';
    var list = document.getElementById('ver-list');
    list.innerHTML = '';
    list.appendChild(el('div', 'lm-empty', '正在拉取版本列表…'));
    document.getElementById('ver-modal').classList.remove('hidden');

    call('requestLoaderVersions', lmGame, type);
  }'''
assert old_picker in s, 'openVersionPicker not found'
s = s.replace(old_picker, new_picker)

# 6) 选版本时才写入 lmType
old_pick = '''      row.addEventListener('click', function () {
        lmVersion = v;
        closeVersionPicker();
        syncDefaultName();
        renderInstallerCards();
        updateInstallButton();
      });'''
new_pick = '''      row.addEventListener('click', function () {
        lmType = verTargetType;
        lmVersion = v;
        // 换了主加载器，附属组件要重新判断（Fabric API 不能跟 Quilt 一起装）
        lmAddon = '';
        closeVersionPicker();
        syncDefaultName();
        renderInstallerCards();
        updateInstallButton();
      });'''
assert old_pick in s, 'version pick handler not found'
s = s.replace(old_pick, new_pick)

# 7) onLoaderVersions 比对 verTargetType
old_cb = '''      if (!data || data.game !== lmGame || data.type !== lmType) { return; }'''
new_cb = '''      if (!data || data.game !== lmGame || data.type !== verTargetType) { return; }'''
assert old_cb in s, 'loader versions guard not found'
s = s.replace(old_cb, new_cb)

# 8) confirmInstall 带 addon
old_confirm = '''    if (!version) { return; }

    var taskId = name || (game + '-' + type + '-' + version);
    dlInstalling = taskId;
    renderDownloadList();
    call('installLoaderNamed', game, type, version, name);
  }'''
new_confirm = '''    if (!version) { return; }

    var taskId = name || (game + '-' + type + '-' + version);
    dlInstalling = taskId;
    renderDownloadList();
    if (lmAddon) {
      call('installLoaderWithAddon', game, type, version, name, lmAddon);
    } else {
      call('installLoaderNamed', game, type, version, name);
    }
  }'''
assert old_confirm in s, 'confirmInstall tail not found'
s = s.replace(old_confirm, new_confirm)

io.open(p, 'w', encoding='utf-8').write(s)
print('frontend patched')
