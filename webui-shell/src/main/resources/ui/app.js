/* Launcher UI 逻辑层
   - 所有原生能力都在 window.nativeBridge 上（Java 注入）
   - 页面加载完成后 Java 会派发 native-ready 事件
*/

(function () {
  'use strict';

  // ===== 能力自检：在 DOM 解析阶段就算好，Java 侧页面加载完成后直接取 =====
  var supports = function (prop, value) {
    try { return CSS.supports(prop, value); } catch (e) { return false; }
  };
  var selectorSupport = function (selector) {
    try {
      document.querySelector(selector);
      return typeof CSS.supports === 'function' && CSS.supports('selector(' + selector + ')');
    } catch (e) { return false; }
  };

  var webgl = false;
  try {
    var probe = document.createElement('canvas');
    webgl = !!(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
  } catch (e) { webgl = false; }

  window.__diagnostics = {
    userAgent: navigator.userAgent,
    cssGrid: supports('display', 'grid'),
    flexGap: supports('gap', '8px'),
    customProperties: supports('--probe', '0'),
    backdropFilter: supports('backdrop-filter', 'blur(4px)'),
    aspectRatio: supports('aspect-ratio', '16 / 9'),
    colorMix: supports('color', 'color-mix(in srgb, red, blue)'),
    sticky: supports('position', 'sticky'),
    hasSelector: selectorSupport(':has(*)'),
    optionalChaining: true,
    webgl: webgl,
    devicePixelRatio: window.devicePixelRatio
  };

  // ===== 桥 =====
  function bridge() {
    return window.nativeBridge || null;
  }

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var b = bridge();
    if (!b) { return null; }
    try {
      return b[method].apply(b, args);
    } catch (e) {
      console.error('bridge call failed: ' + method, e);
      return null;
    }
  }

  // ===== 渲染 =====
  var palette = {
    grass: 'linear-gradient(160deg,#9be3a8,#4fbf72 60%,#2f8f52)',
    stone: 'linear-gradient(160deg,#cfd4da,#9aa2ac 60%,#767d87)',
    dirt:  'linear-gradient(160deg,#c99a72,#a8764f 60%,#7d5433)',
    sand:  'linear-gradient(160deg,#f2e2b6,#e0c98a 60%,#c2a765)'
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text != null) { node.textContent = text; }
    return node;
  }

  function render(state) {
    if (!state) { return; }

    if (state.user) {
      document.getElementById('account-name').textContent = state.user.name;
      document.getElementById('account-type').textContent = state.user.type;
      document.getElementById('avatar').textContent = (state.user.name || '?').charAt(0).toUpperCase();
    }

    var versions = state.versions || [];
    var current = versions.filter(function (v) { return v.id === state.selectedInstance; })[0] || versions[0];

    if (current) {
      document.getElementById('hero-title').textContent = current.name;
      document.getElementById('hero-sub').textContent =
        [current.loader, 'Java ' + current.java, '上次启动 ' + current.lastPlayed].join(' · ');
      document.getElementById('hero-art').style.background = palette[current.icon] || palette.grass;
    }

    // 实例卡片
    var grid = document.getElementById('version-grid');
    grid.innerHTML = '';
    versions.forEach(function (v) {
      var card = el('div', 'version-card');
      var icon = el('div', 'version-icon');
      icon.style.background = palette[v.icon] || palette.grass;
      var body = el('div', 'version-body');
      body.appendChild(el('div', 'version-name', v.name));
      body.appendChild(el('div', 'version-meta', v.loader + ' · Java ' + v.java));
      var tags = el('div', 'version-tags');
      tags.appendChild(el('span', 'tag', v.size));
      tags.appendChild(el('span', 'tag', v.lastPlayed));
      body.appendChild(tags);
      card.appendChild(icon);
      card.appendChild(body);
      card.addEventListener('click', function () {
        document.getElementById('hero-title').textContent = v.name;
        document.getElementById('hero-sub').textContent =
          [v.loader, 'Java ' + v.java, '上次启动 ' + v.lastPlayed].join(' · ');
        document.getElementById('hero-art').style.background = palette[v.icon] || palette.grass;
        call('log', 'select instance ' + v.id);
      });
      grid.appendChild(card);
    });

    // 动态
    var news = document.getElementById('news-list');
    news.innerHTML = '';
    (state.news || []).forEach(function (n) {
      var item = el('div', 'news-item');
      var left = el('div', '');
      left.appendChild(el('strong', null, n.title));
      left.appendChild(el('p', null, n.desc));
      item.appendChild(left);
      item.appendChild(el('span', 'news-time', n.time));
      news.appendChild(item);
    });

    // 实例表格
    var table = document.getElementById('instance-table');
    table.innerHTML = '';
    var head = el('div', 'table-row head');
    ['名称', '加载器', 'Java', '上次启动'].forEach(function (t) {
      head.appendChild(el('span', null, t));
    });
    table.appendChild(head);
    versions.forEach(function (v) {
      var row = el('div', 'table-row');
      row.appendChild(el('span', null, v.name));
      row.appendChild(el('span', 'muted', v.loader));
      row.appendChild(el('span', 'muted', v.java));
      row.appendChild(el('span', 'muted', v.lastPlayed));
      table.appendChild(row);
    });

    // 自检面板
    var diag = document.getElementById('diag');
    diag.innerHTML = '';
    var d = window.__diagnostics || {};
    var labels = {
      cssGrid: 'CSS Grid',
      flexGap: 'flex gap',
      customProperties: 'CSS 变量',
      backdropFilter: 'backdrop-filter',
      aspectRatio: 'aspect-ratio',
      colorMix: 'color-mix()',
      sticky: 'position: sticky',
      hasSelector: ':has()',
      webgl: 'WebGL'
    };
    Object.keys(labels).forEach(function (key) {
      var item = el('div', 'diag-item');
      item.appendChild(el('span', null, labels[key]));
      var ok = !!d[key];
      item.appendChild(el('span', ok ? 'diag-ok' : 'diag-no', ok ? '支持' : '不支持'));
      diag.appendChild(item);
    });
    document.getElementById('ua').textContent = d.userAgent || '';
  }

  // ===== 交互 =====
  var titles = { home: '主页', instances: '实例', download: '下载', settings: '设置' };

  function initNav() {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var page = this.getAttribute('data-page');
        var all = document.querySelectorAll('.nav-item');
        for (var j = 0; j < all.length; j++) { all[j].classList.remove('active'); }
        this.classList.add('active');
        var pages = document.querySelectorAll('.page');
        for (var k = 0; k < pages.length; k++) { pages[k].classList.remove('active'); }
        document.getElementById('page-' + page).classList.add('active');
        document.getElementById('page-title').textContent = titles[page] || '';
      });
    }
  }

  function initWindow() {
    document.getElementById('btn-min').addEventListener('click', function () { call('minimize'); });
    document.getElementById('btn-max').addEventListener('click', function () { call('toggleMaximize'); });
    document.getElementById('btn-close').addEventListener('click', function () { call('close'); });

    document.getElementById('btn-theme').addEventListener('click', function () {
      var body = document.body;
      body.setAttribute('data-theme', body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('btn-launch').addEventListener('click', function () {
      var id = 'launch-target';
      call('log', 'launch ' + id);
      var btn = this;
      var original = btn.textContent;
      btn.textContent = '启动中…';
      btn.disabled = true;
      setTimeout(function () {
        btn.textContent = original;
        btn.disabled = false;
      }, 1500);
    });
  }

  function initDrag() {
    var dragging = false;
    var resizing = false;

    document.addEventListener('mousedown', function (e) {
      var target = e.target;
      if (target.hasAttribute && target.hasAttribute('data-drag')) {
        dragging = true;
        call('dragStart', e.screenX, e.screenY);
      }
    });

    document.getElementById('grip').addEventListener('mousedown', function (e) {
      resizing = true;
      call('resizeStart', e.screenX, e.screenY);
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (dragging) { call('dragMove', e.screenX, e.screenY); }
      if (resizing) { call('resizeMove', e.screenX, e.screenY); }
    });

    window.addEventListener('mouseup', function () {
      dragging = false;
      resizing = false;
    });
  }

  function boot() {
    initNav();
    initWindow();
    initDrag();

    var raw = call('getState');
    var state = null;
    try { state = raw ? JSON.parse(raw) : null; } catch (e) { console.error('bad state', e); }
    render(state);
  }

  document.addEventListener('native-ready', boot);

  // 直开浏览器（没有 Java 桥）时用空状态兜底，方便单独调样式
  setTimeout(function () {
    if (!bridge()) { boot(); }
  }, 50);
})();
