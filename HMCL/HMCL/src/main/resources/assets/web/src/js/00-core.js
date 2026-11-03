/* WebView UI 逻辑层

   契约：
     state      = {account, accounts[], instances[], selected, iconTypes[], theme}
     instance   = {id,name,gameVersion,loader,loaderVersion,java,size,lastLaunch,icon,isModpack}
     bridge     = window.nativeBridge（Java 注入），方法见文件末尾调用处
     java -> js = window.__hmcl.onState(json) / onNews(json) / onToast(text)

   结构（按文件顺序；函数声明会提升，跨区块互相调用是允许的）：
     1. 工具      tr / tf / el / fmt 系列 / apiBase / apiCall / call —— 不依赖 state，随处可用
     2. 状态      state / news / instId / instData / instTab —— 后端快照 + 当前页面上下文
     3. 渲染调度  render() 只重画当前页面；go() 切页并补一次首绘
     4. 页面      首页 / 实例列表 / 账号 / 设置 / 实例详情 / 下载 / 外观
     5. 弹窗      各功能自带一段，弹窗自己管自己的 DOM 和事件

   两条规矩：
     · 渲染函数只读 state，不发网络请求；要数据就走对应的 loadXxx()
     · 往 state 里加字段前先想清楚谁会重画 —— render() 只画看得见的那一页
*/

(function () {
  'use strict';

  var state = null;
  var news = null;
  var currentIconInstance = null;

  // ---------------- 工具 ----------------

  /// 翻译一句文案。i18n.js 没加载（比如 JavaFX 模式的旧页面）就原样返回。
  /// 单独包一层是为了不跟文件里那堆 `var t` 打交道。
  function tr(text) {
    return window.t ? window.t(text) : text;
  }

  /// 带占位符的翻译：tf('删除「{0}」？', name)。
  ///
  /// 中英文语序不一样的地方必须走这个 —— 引号、前缀这种，直接用 + 拼出来的话
  /// 英文只会换掉半句，剩下一个中文右引号挂在那儿。
  function tf(template, a, b) {
    var args = [a, b];
    return tr(template).replace(/\{(\d)\}/g, function (m, i) {
      var v = args[+i];
      return v == null ? '' : String(v);
    });
  }

  function bridge() { return window.nativeBridge || null; }

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    var b = bridge();
    if (!b || typeof b[method] !== 'function') { return null; }
    try { return b[method].apply(b, args); } catch (e) { console.error(method, e); return null; }
  }

  /// 直接打本地 HTTP 接口并拿到返回值。
  ///
  /// 为什么不能只用 call()：桥（tauri-shim）对普通方法一律返回 null，
  /// 值要靠后端 SSE 推回来。需要「同步拿到结果」的方法（选目录、查默认路径）
  /// 必须走这条路，否则 call(...).then 会直接在 null 上炸。
  /// 后端抛上来的网络错误翻成人话。直接甩 "Connect timed out" 用户不知道要干什么。
  function friendlyError(err) {
    var msg = String(err || '');
    if (!msg) { return '加载失败，请重试'; }
    if (/timed out|timeout|Connect|UnknownHost|Network is unreachable/i.test(msg)) {
      return '连不上 api.modrinth.com，检查一下网络或代理再重试';
    }
    if (/429|rate limit/i.test(msg)) {
      return '请求太频繁了，等几秒再试';
    }
    return msg;
  }

  /// 后端有些方法返回的是「JSON 字符串」而不是对象（Java 侧签名是 String），
  /// 经 HTTP 原样传回来就是一段文本。这里统一解析成对象，调用点不必各自判断。
  function asJson(value) {
    if (value == null) { return null; }
    if (typeof value !== 'string') { return value; }
    try { return JSON.parse(value); } catch (e) { return null; }
  }

  /// 本地 HTTP 端点（port + token）。查询串只在启动时解析一次 ——
  /// 这里原来每次调用都 new URLSearchParams(location.search)，纯属浪费。
  var API_BASE = null;
  function apiBase() {
    if (API_BASE !== null) { return API_BASE; }
    var q = new URLSearchParams(location.search);
    var port = q.get('port');
    API_BASE = port ? { port: port, token: q.get('token') || '' } : false;
    return API_BASE;
  }

  function apiCall(method, args) {
    var base = apiBase();
    if (!base) { return Promise.resolve(null); }
    return fetch('http://127.0.0.1:' + base.port + '/api/' + method + '?token=' + encodeURIComponent(base.token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || [])
    }).then(function (r) { return r.json(); })
      .then(function (j) { return j && j.ok ? j.data : null; })
      .catch(function () { return null; });
  }

  function fmtSize(bytes) {
    if (bytes == null || bytes < 0) { return '统计中…'; }
    if (bytes < 1024) { return bytes + ' B'; }
    var units = ['KB', 'MB', 'GB', 'TB'];
    var v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
  }

  /// 下载量这类大数字：12.3万 / 1.2万 / 845
  function fmtCount(n) {
    if (!n) { return '0'; }
    if (n >= 10000) { return (n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + tr(' 万'); }
    return String(n);
  }

  function fmtTime(ms) {
    if (!ms || ms <= 0) { return '从未启动'; }
    var diff = Date.now() - ms;
    if (diff < 60e3) { return '刚刚'; }
    if (diff < 3600e3) { return Math.floor(diff / 60e3) + tr(' 分钟前'); }
    if (diff < 86400e3) { return Math.floor(diff / 3600e3) + tr(' 小时前'); }
    if (diff < 2 * 86400e3) { return '昨天'; }
    if (diff < 7 * 86400e3) { return Math.floor(diff / 86400e3) + tr(' 天前'); }
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    // 文案统一过一遍 i18n：语言包里有就换掉，没有就原样用（中文本身就是原文）
    if (text != null) { node.textContent = window.t ? window.t(text) : text; }
    return node;
  }

  /* 批量进场：给子元素编号，CSS 用 --i 做 24ms 递进延迟。
     超过 6 个就不再累加——再长用户已经在看内容了，动画反而像卡住。 */
  function stagger(container) {
    if (!container) { return; }
    container.classList.add('stagger');
    var kids = container.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].style.setProperty('--i', Math.min(i, 5));
    }
  }

  // ---------------- Toast ----------------

  function toast(text, kind) {
    var wrap = document.getElementById('toast-wrap');
    if (!wrap || !text) { return; }
    var node = el('div', 'toast' + (kind ? ' ' + kind : ''), String(text));
    wrap.appendChild(node);

    // 最多同时挂 3 条，多了把最早的挤掉，避免糊住整个底部
    while (wrap.children.length > 3) { wrap.removeChild(wrap.firstChild); }

    var timer = setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { if (node.parentNode) { node.parentNode.removeChild(node); } }, 160);
    }, 2600);
  }

  /// 下载完成的右下角提示。
  ///
  /// 和 toast 分开：toast 在页面底部中间偏下，是「操作反馈」；
  /// 这个是「任务结束」通知，贴在屏幕右下角、任务栏之上，可堆叠，3 秒自动消失。
  var doneToastTimers = [];

  function notifyDone(title) {
    var wrap = document.getElementById('done-toasts');
    if (!wrap) { return; }
    var name = String(title || '文件');

    var node = el('div', 'done-toast');
    var icon = el('span', 'dt-icon');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6 12-12L20.2 5.6z"/></svg>';
    var body = el('div', 'dt-body');
    body.appendChild(el('span', 'dt-name', name));
    body.appendChild(el('span', 'dt-sub', '已下载完成'));
    node.appendChild(icon);
    node.appendChild(body);
    wrap.appendChild(node);

    // 进栈动画：先量高度再让后面的往上顶，避免一出现就跳
    requestAnimationFrame(function () { node.classList.add('in'); });

    var timer = setTimeout(function () {
      node.classList.remove('in');
      node.classList.add('out');
      setTimeout(function () {
        if (node.parentNode) { node.parentNode.removeChild(node); }
      }, 260);
    }, 3000);
    doneToastTimers.push(timer);

    // 最多同时堆 4 条，再多把最早的收掉
    while (wrap.children.length > 4) {
      var first = wrap.children[0];
      first.classList.add('out');
      (function (n) { setTimeout(function () { if (n.parentNode) { n.parentNode.removeChild(n); } }, 260); })(first);
    }
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

  /// 一次 state 变化只重画「看得见」的那一页。
  ///
  /// 以前不管停在哪一页，都把首页网格、实例表格、账号页、设置页全重建一遍：
  /// 停在实例页时那三块是 display:none 的节点，白烧 CPU，每个实例卡片还要
  /// 重新解码一次 base64 图标。现在切页由 go() 补一次首绘，两边各管一半。
  function render() {
    if (!state) { return; }
    renderAccountChip();

    var page = currentPage();
    if (page === 'home') {
      renderHero();
      renderInstanceGrid();
    } else if (page === 'instances') {
      renderInstanceTable();
    } else if (page === 'accounts') {
      renderAccountPage();
    } else if (page === 'settings') {
      renderSettingsBasics();
    }

    translatePage();
  }

  /// 当前可见页面（`page-home` → `home`）。一个都没 .on 时按首页算。
  function currentPage() {
    var node = document.querySelector('.page.on');
    if (!node || !node.id) { return 'home'; }
    return node.id.indexOf('page-') === 0 ? node.id.slice(5) : 'home';
  }

  /// 兜底翻译：上面那些函数大多用 innerHTML 拼字符串，绕过了 el() 里的 t()。
  /// 渲染完统一把当前页面再过一遍 —— 语言包里有就换，没有就留着中文。
  /// 只扫一个 section，几十到几百个节点，开销可以忽略。
  function translatePage() {
    var i18n = window.__HMCL_I18N__;
    if (!i18n || !i18n.active()) { return; }
    // 页面显隐靠 `.on`，不是 `.hidden`。原来这里选 `.page:not(.hidden)`，
    // 实际每次拿到的都是第一个 page（首页），英文下等于翻错了地方。
    var page = document.querySelector('.page.on');
    i18n.apply(page || document.body);
  }

  /// 设置页里跟 state 有关的那几行（其余走 getSettings）
  function renderSettingsBasics() {
    var env = document.getElementById('set-env');
    if (env) { env.textContent = state ? (state.env || '') : ''; }

    var count = document.getElementById('set-instance-count');
    if (count) { count.textContent = ((state && state.instances) || []).length + tr(' 个'); }

    var ua = document.getElementById('about-ua');
    if (ua) {
      // 只留内核标识，完整 UA 太长会撑破 kv 行
      var m = /AppleWebKit\/[\d.]+|Chrome\/[\d.]+/.exec(navigator.userAgent);
      var shell = window.__HMCL_SHIM__ ? 'WebView2' : 'JavaFX WebView';
      ua.textContent = (m ? m[0] : navigator.userAgent) + '（' + shell + '）';
    }
  }

  /// 设置页数据回填。
  ///
  /// 结构来自 SettingsService.snapshot()：`launcher` / `download` / `java` / `game` 四段。
  /// 所有值都按「后端说了算」回填——内存、线程数这类会被夹到合法范围，
  /// 界面必须显示真实值，不能停在用户输入的假值上。
  function renderSettings(s) {
    if (!s) { return; }

    function put(id, text) {
      var node = document.getElementById(id);
      if (node) { node.textContent = text == null || text === '' ? '—' : String(text); }
    }

    var launcherLabel = s.launcherVersion
      ? (s.launcherName || 'HopeStar-MCLab') + ' ' + s.launcherVersion
      : '';
    put('set-launcher-version', launcherLabel);
    put('about-version', s.launcherVersion || '');
    put('set-game-dir', s.gameDirectory);
    // 快照是分段的：{ launcher: {...}, download: {...}, game: {...} }。
    // 这里以前直接传了整个 s，applyDownloadSettings 里读 s.fileDownloadSource
    // 全是 undefined —— 于是「下载线程」点手动后后端改了、界面却一直显示自动，
    // 下载源下拉也永远回到默认值。
    applyDownloadSettings(s.download || {});

    // ---------- 启动器 ----------
    var L = s.launcher || {};
    fillSelect('set-language',
      (L.languages || []).map(function (l) { return { value: l.name, label: l.display }; }),
      L.language);
    setCheck('set-accept-preview', L.acceptPreviewUpdate);
    setCheck('set-auto-update-dialog', L.disableAutoUpdateDialog != null ? !L.disableAutoUpdateDialog : null);
    setCheck('set-animation', L.animationDisabled != null ? !L.animationDisabled : null);
    // 关掉动画时给 body 挂 no-anim，CSS 里把所有 transition/animation 压成 0
    document.body.classList.toggle('no-anim', !!L.animationDisabled);
    applyAnimSpeed(L.animationSpeed || 'fast');
    syncAnimSpeedState(!!L.animationDisabled);
    setValue('set-log-lines', L.logLines > 0 ? L.logLines : '');
    setValue('set-log-retention', L.logRetention);
    setCheck('set-auto-backup', L.autoBackupOnExit !== false);
    setValue('set-backup-keep', L.backupKeep > 0 ? L.backupKeep : 5);

    // 代理：类型 + 地址/端口/账号密码
    var proxyType = String(L.proxyType || 'system').toLowerCase();
    setValue('set-proxy-type', proxyType);
    setValue('set-proxy-host', L.proxyHost || '');
    setValue('set-proxy-port', L.proxyPort > 0 ? L.proxyPort : '');
    setValue('set-proxy-user', L.proxyUser || '');
    setValue('set-proxy-pass', '');
    syncProxyFields();

    // ---------- Java ----------
    var J = s.java || {};
    fillSelect('set-java-type', [
      { value: 'auto', label: '自动选择' },
      { value: 'version', label: '指定版本号' },
      { value: 'detected', label: '手动指定' }
    ], J.javaType || 'auto');
    setValue('set-java-custom', J.customJavaPath);
    setValue('set-jvm-options', J.jvmOptions);
    setCheck('set-no-jvm-opt', J.noOptimizingJVMOptions);
    setCheck('set-not-use-javaw', J.notUseJavaw);
    setCheck('set-not-check-jvm', J.notCheckJVM);
    toggleRow('row-java-custom', (J.javaType || 'auto') !== 'auto');

    // ---------- 游戏 ----------
    var G = s.game || {};
    setCheck('set-auto-memory', G.autoMemory);
    lastGlobalGame = G;
    renderMemoryMeter('', G.maxMemory || 0, G.minMemory || 0, {
      total: G.totalMemory,
      used: G.usedMemory,
      available: G.availableMemory
    }, !!G.autoMemory);

    fillSelect('set-window-type', [
      { value: 'windowed', label: '窗口化' },
      { value: 'fullscreen', label: '全屏' },
      { value: 'maximized', label: '最大化' }
    ], G.windowType || 'windowed');
    setValue('set-width', G.width ? Math.round(G.width) : '');
    setValue('set-height', G.height ? Math.round(G.height) : '');
    toggleRow('row-window-size', (G.windowType || 'windowed') === 'windowed');

    setValue('set-running-dir', G.runningDirectory);
    fillSelect('set-priority', [
      { value: 'low', label: '低' },
      { value: 'below_normal', label: '低于正常' },
      { value: 'normal', label: '正常' },
      { value: 'above_normal', label: '高于正常' }
    ], G.processPriority || 'normal');
    fillSelect('set-visibility', [
      { value: 'hide', label: '隐藏启动器' },
      { value: 'keep', label: '保持显示' },
      { value: 'close', label: '关闭启动器' },
      { value: 'hide_and_reopen', label: '隐藏，游戏退出后再打开' }
    ], G.launcherVisibility || 'hide');
    setValue('set-game-args', G.gameArguments);

    renderSettingsBasics();
  }


