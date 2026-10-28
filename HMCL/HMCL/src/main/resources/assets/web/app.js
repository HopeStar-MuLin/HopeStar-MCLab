/* WebView UI 逻辑层
   契约：
     state      = {account, accounts[], instances[], selected, iconTypes[], theme}
     instance   = {id,name,gameVersion,loader,loaderVersion,java,size,lastLaunch,icon,isModpack}
     bridge     = window.nativeBridge（Java 注入），方法见文件末尾调用处
     java -> js = window.__hmcl.onState(json) / onNews(json) / onToast(text)
*/

(function () {
  'use strict';

  var state = null;
  var news = null;
  var currentIconInstance = null;

  // ---------------- 工具 ----------------

  function bridge() { return window.nativeBridge || null; }

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var b = bridge();
    if (!b || typeof b[method] !== 'function') { return null; }
    try { return b[method].apply(b, args); } catch (e) { console.error(method, e); return null; }
  }

  function fmtSize(bytes) {
    if (bytes == null || bytes < 0) { return '统计中…'; }
    if (bytes < 1024) { return bytes + ' B'; }
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }

  function fmtTime(ms) {
    if (!ms || ms <= 0) { return '从未启动'; }
    var diff = Date.now() - ms;
    if (diff < 60e3) { return '刚刚'; }
    if (diff < 3600e3) { return Math.floor(diff / 60e3) + ' 分钟前'; }
    if (diff < 86400e3) { return Math.floor(diff / 3600e3) + ' 小时前'; }
    if (diff < 2 * 86400e3) { return '昨天'; }
    if (diff < 7 * 86400e3) { return Math.floor(diff / 86400e3) + ' 天前'; }
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  function iconNode(inst, cls) {
    var img = document.createElement('img');
    img.className = cls;
    if (inst.icon) {
      img.src = inst.icon;
    } else {
      // 没有图标时用首字母 + 渐变兜底
      img.style.background = 'linear-gradient(135deg,#5b7cfa,#8f6bff)';
      img.removeAttribute('src');
      img.alt = (inst.name || '?').charAt(0).toUpperCase();
      var canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      var g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.font = 'bold 34px "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(img.alt, 32, 34);
      img.src = canvas.toDataURL('image/png');
      img.style.imageRendering = 'auto';
    }
    return img;
  }

  // ---------------- 渲染 ----------------

  function render() {
    if (!state) { return; }
    renderAccountChip();
    renderHero();
    renderInstanceGrid();
    renderAccountPage();
    renderInstanceTable();
    document.getElementById('about-env').textContent = state.env || '';
  }

  function selectedInstance() {
    if (!state || !state.instances) { return null; }
    for (var i = 0; i < state.instances.length; i++) {
      if (state.instances[i].id === state.selected) { return state.instances[i]; }
    }
    return state.instances[0] || null;
  }

  function renderAccountChip() {
    var acc = state.account;
    document.getElementById('chip-name').textContent = acc ? acc.name : '未登录';
    document.getElementById('chip-channel').textContent = acc ? acc.channel : '点击添加账号';
    setAvatar(document.getElementById('chip-avatar'), acc);
  }

  function setAvatar(img, acc) {
    if (acc && acc.avatar) {
      img.src = acc.avatar;
      img.style.background = 'transparent';
    } else {
      img.removeAttribute('src');
      img.style.background = 'linear-gradient(135deg,#6c8cff,#9b7bff)';
    }
  }

  function renderHero() {
    var inst = selectedInstance();
    var icon = document.getElementById('hero-icon');
    var name = document.getElementById('hero-name');
    var loader = document.getElementById('hero-loader');
    var sub = document.getElementById('hero-sub');
    var meta = document.getElementById('hero-meta');
    var modpack = document.getElementById('hero-modpack');

    if (!inst) {
      name.textContent = '没有实例';
      sub.textContent = '先去「下载」页装一个游戏版本';
      loader.textContent = '原版';
      meta.innerHTML = '';
      icon.removeAttribute('src');
      document.getElementById('btn-launch').disabled = true;
      return;
    }

    document.getElementById('btn-launch').disabled = false;
    icon.src = iconNode(inst, '').src;
    name.textContent = inst.name;
    loader.textContent = inst.loader || '原版';
    modpack.hidden = !inst.isModpack;
    sub.textContent = (inst.gameVersion || '') + (inst.loaderVersion ? ' · ' + inst.loaderVersion : '');

    meta.innerHTML = '';
    meta.appendChild(el('span', null, 'Java ' + (inst.java || '未知')));
    meta.appendChild(el('span', null, fmtSize(inst.size)));
    meta.appendChild(el('span', null, '上次启动 ' + fmtTime(inst.lastLaunch)));
  }

  function renderInstanceGrid() {
    var grid = document.getElementById('instance-grid');
    grid.innerHTML = '';
    var list = (state.instances || []).slice(0, 5);
    document.getElementById('instance-count').textContent = state.instances
      ? '（' + state.instances.length + ' 个，显示前 ' + list.length + ' 个）' : '';

    if (!list.length) {
      grid.appendChild(el('div', 'empty', '还没有实例。下载一个游戏版本后会自动出现在这里。'));
      return;
    }

    list.forEach(function (inst) {
      var card = el('div', 'instance-card' + (inst.id === state.selected ? ' current' : ''));
      card.appendChild(iconNode(inst, 'instance-icon'));

      var body = el('div', 'instance-body');
      body.appendChild(el('div', 'instance-name', inst.name));
      body.appendChild(el('div', 'instance-line',
        (inst.gameVersion || '') + ' · ' + (inst.loader || '原版') + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')));
      var tags = el('div', 'instance-tags');
      tags.appendChild(el('span', 'tag', fmtSize(inst.size)));
      tags.appendChild(el('span', 'tag', fmtTime(inst.lastLaunch)));
      body.appendChild(tags);
      card.appendChild(body);

      var edit = el('button', 'icon-edit', '✎');
      edit.title = '更换图标';
      edit.addEventListener('click', function (e) {
        e.stopPropagation();
        openIconPicker(inst.id);
      });
      card.appendChild(edit);

      card.addEventListener('click', function () {
        call('selectInstance', inst.id);
      });

      grid.appendChild(card);
    });
  }

  function renderAccountPage() {
    var acc = state.account;
    document.getElementById('account-name').textContent = acc ? acc.name : '未登录';
    document.getElementById('account-channel').textContent = acc ? acc.channel : '选择一个登录方式';
    document.getElementById('account-uuid').textContent = acc ? acc.uuid : '';
    setAvatar(document.getElementById('account-avatar'), acc);
    document.getElementById('btn-account-remove').disabled = !acc;

    var list = document.getElementById('account-list');
    list.innerHTML = '';
    var accounts = state.accounts || [];
    if (!accounts.length) {
      list.appendChild(el('div', 'empty', '还没有账号。上面三种方式任选一种登录。'));
      return;
    }
    accounts.forEach(function (a) {
      var row = el('div', 'account-row' + (a.selected ? ' current' : ''));
      var img = document.createElement('img');
      setAvatar(img, a);
      row.appendChild(img);
      var main = el('div', 'row-main');
      main.appendChild(el('div', 'row-name', a.name));
      main.appendChild(el('div', 'row-sub', a.channel));
      row.appendChild(main);
      if (!a.selected) {
        var del = el('button', 'row-del', '删除');
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          call('removeAccount', a.uuid);
        });
        row.appendChild(del);
      }
      row.addEventListener('click', function () {
        if (!a.selected) { call('selectAccount', a.uuid); }
      });
      list.appendChild(row);
    });
  }

  function renderInstanceTable() {
    var table = document.getElementById('instance-table');
    table.innerHTML = '';
    var head = el('div', 'table-row head');
    ['实例', '版本 / 加载器', 'Java', '占用', '上次启动'].forEach(function (t) {
      head.appendChild(el('span', null, t));
    });
    table.appendChild(head);

    (state.instances || []).forEach(function (inst) {
      var row = el('div', 'table-row');
      row.appendChild(el('span', null, inst.name));
      row.appendChild(el('span', 'muted',
        (inst.gameVersion || '') + ' / ' + (inst.loader || '原版') + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')));
      row.appendChild(el('span', 'muted', inst.java || '-'));
      row.appendChild(el('span', 'muted', fmtSize(inst.size)));
      row.appendChild(el('span', 'muted', fmtTime(inst.lastLaunch)));
      table.appendChild(row);
    });
  }

  function renderNews() {
    var box = document.getElementById('news-list');
    box.innerHTML = '';
    if (!news) {
      box.appendChild(el('div', 'empty', '正在从 Mojang 拉取更新日志…'));
      return;
    }
    if (news.error) {
      box.appendChild(el('div', 'empty', '动态加载失败：' + news.error));
      return;
    }
    (news.items || []).slice(0, 4).forEach(function (n) {
      var item = el('a', 'news-item');
      item.href = n.url || '#';
      if (n.image) {
        var thumb = document.createElement('img');
        thumb.className = 'news-thumb';
        thumb.src = n.image;
        item.appendChild(thumb);
      }
      var body = el('div', 'news-body');
      body.appendChild(el('div', 'news-title', n.title));
      body.appendChild(el('div', 'news-desc', n.summary || ''));
      item.appendChild(body);
      item.appendChild(el('div', 'news-time', fmtTime(n.date)));
      item.addEventListener('click', function (e) {
        e.preventDefault();
        if (n.url) { call('openLink', n.url); }
      });
      box.appendChild(item);
    });
  }

  // ---------------- 图标选择 / 裁剪 ----------------

  function openIconPicker(instanceId) {
    currentIconInstance = instanceId;
    var modal = document.getElementById('icon-modal');
    modal.classList.remove('hidden');
    document.getElementById('icon-step-pick').hidden = false;
    document.getElementById('icon-step-crop').hidden = true;

    var grid = document.getElementById('icon-grid');
    grid.innerHTML = '';
    (state.iconTypes || []).forEach(function (t) {
      var cell = el('button', 'icon-cell');
      cell.title = t.label || t.id;
      var img = document.createElement('img');
      img.src = t.preview;
      cell.appendChild(img);
      cell.addEventListener('click', function () {
        call('setBuiltinIcon', instanceId, t.id);
        closeIconPicker();
      });
      grid.appendChild(cell);
    });
  }

  function closeIconPicker() {
    document.getElementById('icon-modal').classList.add('hidden');
    currentIconInstance = null;
  }

  var crop = { img: null, scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0 };

  function startCrop(dataUrl) {
    var img = new Image();
    img.onload = function () {
      crop.img = img;
      var stage = 360;
      var fit = Math.min(stage / img.width, stage / img.height) * 1.0;
      crop.scale = fit;
      crop.x = (stage - img.width * fit) / 2;
      crop.y = (stage - img.height * fit) / 2;
      document.getElementById('icon-step-pick').hidden = true;
      document.getElementById('icon-step-crop').hidden = false;
      document.getElementById('crop-frame').style.cssText =
        'left:36px;top:36px;width:288px;height:288px';
      drawCrop();
    };
    img.src = dataUrl;
  }

  function drawCrop() {
    var canvas = document.getElementById('crop-canvas');
    var g = canvas.getContext('2d');
    g.clearRect(0, 0, 360, 360);
    if (!crop.img) { return; }
    g.imageSmoothingEnabled = true;
    g.drawImage(crop.img, crop.x, crop.y, crop.img.width * crop.scale, crop.img.height * crop.scale);
  }

  function initCropEvents() {
    var stage = document.getElementById('crop-stage');

    stage.addEventListener('mousedown', function (e) {
      crop.dragging = true;
      crop.lastX = e.clientX;
      crop.lastY = e.clientY;
    });
    window.addEventListener('mousemove', function (e) {
      if (!crop.dragging) { return; }
      crop.x += e.clientX - crop.lastX;
      crop.y += e.clientY - crop.lastY;
      crop.lastX = e.clientX;
      crop.lastY = e.clientY;
      drawCrop();
    });
    window.addEventListener('mouseup', function () { crop.dragging = false; });

    stage.addEventListener('wheel', function (e) {
      if (!crop.img) { return; }
      e.preventDefault();
      var f = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      var next = Math.min(20, Math.max(0.05, crop.scale * f));
      // 以窗口中心为锚点缩放
      var cx = 180, cy = 180;
      crop.x = cx - (cx - crop.x) * (next / crop.scale);
      crop.y = cy - (cy - crop.y) * (next / crop.scale);
      crop.scale = next;
      drawCrop();
    });

    document.getElementById('crop-confirm').addEventListener('click', function () {
      if (!crop.img || !currentIconInstance) { return; }
      var out = document.createElement('canvas');
      out.width = out.height = 256;
      var g = out.getContext('2d');
      // 取裁剪框（36,36,288,288）对应原图区域
      var sx = (36 - crop.x) / crop.scale;
      var sy = (36 - crop.y) / crop.scale;
      var sw = 288 / crop.scale;
      g.drawImage(crop.img, sx, sy, sw, sw, 0, 0, 256, 256);
      call('setIconData', currentIconInstance, out.toDataURL('image/png'));
      closeIconPicker();
    });
  }

  // ---------------- 交互 ----------------

  var titles = { home: '主页', instances: '实例', download: '下载', settings: '设置', accounts: '账号' };

  function go(page) {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].getAttribute('data-page') === page);
    }
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) {
      pages[j].classList.toggle('active', pages[j].id === 'page-' + page);
    }
    var tb = document.getElementById('tb-title');
    if (tb) { tb.textContent = titles[page] || ''; }
  }

  function initUi() {
    var navs = document.querySelectorAll('.nav-item');
    for (var i = 0; i < navs.length; i++) {
      navs[i].addEventListener('click', function () { go(this.getAttribute('data-page')); });
    }

    document.getElementById('account-chip').addEventListener('click', function () { go('accounts'); });
    document.getElementById('btn-launch').addEventListener('click', function () {
      var inst = selectedInstance();
      if (inst) { call('launch', inst.id); }
    });
    document.getElementById('btn-folder').addEventListener('click', function () {
      var inst = selectedInstance();
      if (inst) { call('openFolder', inst.id); }
    });
    document.getElementById('btn-refresh').addEventListener('click', function () {
      call('refresh');
    });
    document.getElementById('win-min').addEventListener('click', function () { call('minimize'); });
    document.getElementById('win-max').addEventListener('click', function () { call('toggleMaximize'); });
    document.getElementById('win-close').addEventListener('click', function () { call('close'); });
    document.querySelector('.titlebar').addEventListener('dblclick', function (e) {
      if (e.target.closest('.tb-actions')) { return; }
      call('toggleMaximize');
    });
    initWindowDrag();

    document.getElementById('btn-theme').addEventListener('click', function () {
      var body = document.body;
      body.setAttribute('data-theme', body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('btn-account-remove').addEventListener('click', function () {
      if (state.account) { call('removeAccount', state.account.uuid); }
    });

    var logins = document.querySelectorAll('[data-login]');
    for (var k = 0; k < logins.length; k++) {
      logins[k].addEventListener('click', function () {
        var kind = this.getAttribute('data-login');
        if (kind === 'offline') { call('loginOffline'); }
        else if (kind === 'microsoft') { call('loginMicrosoft'); }
        else { call('loginAuthlib'); }
      });
    }

    document.getElementById('icon-close').addEventListener('click', closeIconPicker);
    document.getElementById('icon-custom').addEventListener('click', function () {
      if (!currentIconInstance) { return; }
      var dataUrl = call('pickImage');
      if (dataUrl) { startCrop(dataUrl); }
    });
    document.getElementById('crop-cancel').addEventListener('click', function () {
      document.getElementById('icon-step-crop').hidden = true;
      document.getElementById('icon-step-pick').hidden = false;
    });
    initCropEvents();
  }

  function initWindowDrag() {
    var dragging = false;
    var resizeEdge = null;

    document.querySelector('.titlebar').addEventListener('mousedown', function (e) {
      if (e.button !== 0 || e.target.closest('.tb-actions')) { return; }
      dragging = true;
      call('dragStart', e.screenX, e.screenY);
    });

    var handles = document.querySelectorAll('[data-resize]');
    for (var i = 0; i < handles.length; i++) {
      (function (handle) {
        handle.addEventListener('mousedown', function (e) {
          resizeEdge = handle.getAttribute('data-resize');
          call('resizeStart', e.screenX, e.screenY, resizeEdge);
          e.preventDefault();
          e.stopPropagation();
        });
      })(handles[i]);
    }

    window.addEventListener('mousemove', function (e) {
      if (dragging) { call('dragMove', e.screenX, e.screenY); }
      if (resizeEdge) { call('resizeMove', e.screenX, e.screenY); }
    });

    window.addEventListener('mouseup', function () {
      dragging = false;
      resizeEdge = null;
    });
  }

  // ---------------- Java 回调入口 ----------------

  window.__hmcl = {
    onState: function (json) {
      try { state = JSON.parse(json); } catch (e) { console.error('bad state', e); return; }
      if (state.theme) { document.body.setAttribute('data-theme', state.theme); }
      render();
    },
    onNews: function (json) {
      try { news = JSON.parse(json); } catch (e) { news = { error: String(e) }; }
      renderNews();
    },
    onToast: function (text) {
      console.log('[toast] ' + text);
    }
  };

  // ---------------- 启动 ----------------

  document.addEventListener('native-ready', function () {
    initUi();
    var raw = call('getState');
    if (raw) { window.__hmcl.onState(raw); }
    call('requestNews');
  });

  // 没有 Java 桥时（直接用浏览器打开调样式）用兜底数据
  setTimeout(function () {
    if (bridge()) { return; }
    initUi();
    window.__hmcl.onState(JSON.stringify({
      account: { uuid: 'demo', name: 'Steve', channel: '微软登录', avatar: null },
      accounts: [
        { uuid: 'demo', name: 'Steve', channel: '微软登录', avatar: null, selected: true },
        { uuid: 'demo2', name: 'Alex', channel: 'LittleSkin', avatar: null, selected: false }
      ],
      selected: '1.21.1-fabric',
      instances: [
        { id: '1.21.1-fabric', name: '1.21.1-Fabric', gameVersion: '1.21.1', loader: 'Fabric', loaderVersion: '0.16.5', java: '21', size: 1288490188, lastLaunch: Date.now() - 3600e3, isModpack: false },
        { id: '1.20.1-forge', name: '1.20.1-Forge', gameVersion: '1.20.1', loader: 'Forge', loaderVersion: '47.2.0', java: '17', size: 1027604480, lastLaunch: Date.now() - 86400e3, isModpack: false },
        { id: 'gtnh', name: 'GTNH 2.7', gameVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4', java: '8', size: 6657199308, lastLaunch: Date.now() - 5 * 86400e3, isModpack: true },
        { id: '1.21.4-neoforge', name: '1.21.4-NeoForge', gameVersion: '1.21.4', loader: 'NeoForge', loaderVersion: '21.4.20', java: '21', size: 734003200, lastLaunch: 0, isModpack: false }
      ],
      iconTypes: [],
      theme: 'light',
      env: 'standalone preview'
    }));
    window.__hmcl.onNews(JSON.stringify({ items: [
      { title: 'Minecraft 26.4 Snapshot 6', summary: 'Kai is ice fishing, sitting on a light blue cushion…', date: Date.now() - 7200e3 },
      { title: 'Minecraft 1.21.10', summary: 'Stability fixes and a new block variant.', date: Date.now() - 3 * 86400e3 }
    ] }));
  }, 60);
})();
