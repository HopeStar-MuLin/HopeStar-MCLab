/* 自动生成，不要直接改这个文件。
   源码在 src/js/ 下（按文件名顺序拼接），改完执行：node tools/web-build.js */
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


  // ---------------- 内存滑条 ----------------
  //
  // 刻度换算照 PCL-CE 的 GetRamFromTick（PageSetupLaunch.xaml.cs）：
  // 分段线性，0.3~1.5 每档 0.1，1.5~8 每档 0.5，8~16 每档 1，之后每档 2。
  // 一条滑条就能覆盖 0.3~48 GB，比让人手填 MB 数字好用得多——
  // 填数字既要知道自己有多少内存，又容易填成 2048 这种一看就知道是猜的值。

  var RAM_TICK_MAX = 49;

  /// 最近一次从后端读到的物理内存（MB）。
  /// 滑条拖动时要不停重画三段条，不能每动一下就问后端一次。
  var memInfo = { total: 0, used: 0, available: 0 };

  /// 档位 -> GB
  function ramFromTick(tick) {
    if (tick <= 0) { return 0; }
    if (tick <= 12) { return tick * 0.1 + 0.3; }
    if (tick <= 25) { return (tick - 12) * 0.5 + 1.5; }
    if (tick <= 33) { return (tick - 25) + 8; }
    return (tick - 33) * 2 + 16;
  }

  /// GB -> 档位。取最接近的一档，而不是向上取整：
  /// 用户原来的值可能是 6144MB（6GB），向上取整会变成 6.5，看起来像被改了。
  function tickFromRam(gb) {
    if (!(gb > 0)) { return 0; }
    var best = 1;
    var bestDiff = Infinity;
    for (var t = 1; t <= RAM_TICK_MAX; t++) {
      var diff = Math.abs(ramFromTick(t) - gb);
      if (diff < bestDiff) { bestDiff = diff; best = t; }
    }
    return best;
  }

  /// 滑条上界。不能让人把物理内存全分出去，按总量分段留余量（同 PCL）。
  function maxTickFor(totalMb) {
    var total = totalMb / 1024;
    if (!(total > 0)) { return RAM_TICK_MAX; }
    var tick;
    if (total <= 1.5) { tick = Math.floor((total - 0.3) / 0.1); }
    else if (total <= 8) { tick = Math.floor((total - 1.5) / 0.5) + 12; }
    else if (total <= 16) { tick = Math.floor((total - 8) / 1) + 25; }
    else { tick = Math.floor((total - 16) / 2) + 33; }
    return Math.max(1, Math.min(RAM_TICK_MAX, tick));
  }

  /// 最近一次读到的全局游戏设置。勾选「自动分配内存」时要重画面板，
  /// 但那时候手上没有新的后端数据，用这份缓存就够。
  var lastGlobalGame = null;

  function withGlobalMemory(fn) {
    if (lastGlobalGame) { fn(lastGlobalGame); }
  }

  function fmtGb(gb) {
    return (gb > 0 ? gb : 0).toFixed(1) + ' GB';
  }

  /// 画三段条：已用 / 游戏分配 / 空闲。
  ///
  /// 「游戏分配」这段特意画成半透明：分配超过当前可用内存时，实际能吃到的
  /// 只有可用那部分，超出的部分在条上不应该显示成「已经占住了」。
  function drawMemoryBar(prefix, gameMb, auto) {
    var segUsed = document.getElementById(prefix + 'mem-seg-used');
    var segGame = document.getElementById(prefix + 'mem-seg-game');
    var segFree = document.getElementById(prefix + 'mem-seg-free');
    if (!segUsed) { return; }

    var total = memInfo.total;
    if (!(total > 0)) {
      segUsed.style.width = '0%';
      segGame.style.width = '0%';
      segFree.style.width = '100%';
      setText(prefix + 'mem-used-text', '—');
      setText(prefix + 'mem-game-text', '—');
      setText(prefix + 'mem-free-text', '—');
      return;
    }

    var usedGb = memInfo.used / 1024;
    var availGb = memInfo.available / 1024;
    var gameGb = gameMb > 0 ? Math.min(gameMb / 1024, availGb) : 0;
    var totalGb = total / 1024;

    var usedPct = Math.max(0, Math.min(100, (usedGb / totalGb) * 100));
    var gamePct = auto ? 0 : Math.max(0, Math.min(100 - usedPct, (gameGb / totalGb) * 100));
    var freePct = Math.max(0, 100 - usedPct - gamePct);

    segUsed.style.width = usedPct + '%';
    segGame.style.width = gamePct + '%';
    segFree.style.width = freePct + '%';

    setText(prefix + 'mem-used-text', usedGb.toFixed(1) + ' / ' + totalGb.toFixed(1) + ' GB');
    setText(prefix + 'mem-game-text', auto ? '自动' : (gameGb.toFixed(1) + ' GB'));
    setText(prefix + 'mem-free-text', (totalGb - usedGb - gameGb > 0
      ? (totalGb - usedGb - gameGb).toFixed(1) : '0.0') + ' GB');

    // 分配超过 75% 物理内存就提醒一句：这时候系统本身已经没多少余量了
    var warn = document.getElementById(prefix + 'mem-warn');
    if (warn) {
      var tooMuch = !auto && gameGb / totalGb > 0.75;
      warn.hidden = !tooMuch;
      if (tooMuch) {
        warn.textContent = tr('分配了物理内存的 ') + Math.round((gameGb / totalGb) * 100)
          + tr('%，系统可能因为内存不足而卡顿，也可能启动失败。');
      }
    }
  }

  /// 把后端给的内存值和设置值铺到一组控件上。
  ///
  /// @param prefix 空串 = 全局设置，'inst-' = 实例设置
  function renderMemoryMeter(prefix, maxMb, minMb, info, auto) {
    if (info && info.total) {
      memInfo.total = info.total;
      memInfo.used = info.used || 0;
      memInfo.available = info.available || 0;
    }

    var maxRange = document.getElementById(prefix + 'mem-max-range');
    if (!maxRange) { return; }

    var tmax = maxTickFor(memInfo.total);
    maxRange.max = String(tmax);

    var maxTick = maxMb > 0 ? tickFromRam(maxMb / 1024) : Math.min(tmax, Math.round(tmax * 0.5));
    maxTick = Math.max(1, Math.min(tmax, maxTick));
    maxRange.value = String(maxTick);

    // 自动模式下锁住滑条：值由启动器按整合包和机器情况估算
    maxRange.disabled = !!auto;

    // 显示用「配置里的真实值」而不是刻度换算值：老配置可能是 8064MB 这种
    // 不落在刻度上的数，按刻度显示会变成 8.0 GB，与实际启动参数不符。
    setText(prefix + 'mem-max-value', auto ? '自动' : fmtGb(maxMb / 1024));

    drawMemoryBar(prefix, auto ? 0 : maxMb, auto);
  }

  /// 当前可见的页面 id（去掉 `page-` 前缀）
  function currentPageId() {
    var on = document.querySelector('.page.on');
    return on ? on.id.replace(/^page-/, '') : '';
  }

  /// 每 30 秒取一次物理内存，重画设置页 / 实例页里的内存条。
  ///
  /// 只在两个用得到内存数据的页面刷新：别的页面（下载、账号）没有内存条，
  /// 每半分钟发一次请求纯属浪费。
  function refreshMemorySnapshot() {
    var page = currentPageId();
    if (page !== 'settings' && page !== 'instance') { return; }

    apiCall('memorySnapshot', []).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.total) { return; }
      var info = { total: d.total, used: d.used, available: d.available };

      if (page === 'settings' && lastGlobalGame) {
        renderMemoryMeter('', lastGlobalGame.maxMemory || 0, 0, info, !!lastGlobalGame.autoMemory);
      } else if (page === 'instance' && instData && instData.game) {
        renderMemoryMeter('inst-', instData.game.maxMemory || 0, 0, info, !!instData.game.autoMemory);
      }
    });
  }

  /// 绑定滑条交互。
  ///
  /// `input` 只更新界面、`change` 才落盘——拖动一次会触发几十个 input，
  /// 每个都发一次 HTTP 请求既浪费又会让后端反复写配置文件。
  function mountMemoryMeter(prefix, apply) {
    var maxRange = document.getElementById(prefix + 'mem-max-range');
    if (!maxRange) { return; }

    maxRange.addEventListener('input', function () {
      var gb = ramFromTick(Number(this.value));
      setText(prefix + 'mem-max-value', fmtGb(gb));
      drawMemoryBar(prefix, gb * 1024, false);
    });
    maxRange.addEventListener('change', function (e) {
      // 只认用户操作。renderMemoryMeter 会用代码改 value（回填后端数据、
      // 或者在 max 变小时被浏览器夹紧），那些都不该反过来写进配置文件——
      // 曾经因为这样把 maxMemory 写成了 410MB。
      if (!e.isTrusted) { return; }
      apply('maxMemory', Math.round(ramFromTick(Number(this.value)) * 1024));
    });

  }


  // ---------------- 百宝箱 ----------------
  //
  // 两个功能：自定义下载（分段并发）+ 清理垃圾文件。
  // 下载进度由 Java 侧每 200ms 推一次，这里只负责画。

  var tbState = { running: false, done: 0, total: 0, fileName: '' };

  function fmtBytes(n) {
    if (!(n > 0)) { return '0 B'; }
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function renderToolboxProgress(d) {
    var fill = document.getElementById('tb-fill');
    var stage = document.getElementById('tb-stage');
    var pct = document.getElementById('tb-percent');
    if (!fill) { return; }

    if (d.error) {
      fill.style.width = '100%';
      fill.style.background = 'var(--danger)';
      if (stage) { stage.textContent = tr('下载失败：') + d.error; }
      if (pct) { pct.textContent = ''; }
      tbState.running = false;
      return;
    }

    fill.style.background = '';
    var percent = d.total > 0 ? Math.min(100, (d.done / d.total) * 100) : 0;
    fill.style.width = Math.max(d.done > 0 ? 2 : 0, percent) + '%';

    if (stage) {
      if (d.finished) {
        stage.textContent = tr('已保存 ') + (d.fileName || '文件') + '（' + fmtBytes(d.done || d.total) + '）';
      } else if (d.total > 0) {
        stage.textContent = fmtBytes(d.done) + ' / ' + fmtBytes(d.total);
      } else {
        stage.textContent = fmtBytes(d.done) + tr(' 已下载');
      }
    }
    if (pct) {
      pct.textContent = d.total > 0 ? Math.round(percent) + '%' : '';
    }
    if (d.finished) { tbState.running = false; }
  }

  function initToolbox() {
    var start = document.getElementById('tb-start');
    if (start) { start.addEventListener('click', startDownload); }

    var pick = document.getElementById('tb-pick-dir');
    if (pick) {
      pick.addEventListener('click', function () {
        // 后端只会把选中的路径用 toast 报出来（它在 Java 侧拿不到输入框），
        // 所以这里直接弹系统目录选择器并把结果回填到输入框
        apiCall('chooseDownloadFolder', []).then(function (raw) {
          var path = typeof raw === 'string' ? raw : '';
          if (path) { document.getElementById('tb-dir').value = path; }
        });
      });
    }

    var openFolder = document.getElementById('tb-open-folder');
    if (openFolder) {
      openFolder.addEventListener('click', function () {
        var dir = document.getElementById('tb-dir').value.trim();
        call('openPath', dir);
      });
    }

    var clean = document.getElementById('tb-clean');
    if (clean) {
      clean.addEventListener('click', function () {
        var out = document.getElementById('tb-clean-result');
        if (out) { out.textContent = tr('正在清理…'); }
        call('cleanupJunk');
      });
    }

    initMirrorPanel();
  }

  // ---------------- GitHub 镜像加速 ----------------
  //
  // 默认收起、默认不测速：镜像站都是公益服务，一口气测一百多个会占带宽，
  // 平时不下载 GitHub 文件的人完全用不上。展开后点「测速」才真正跑，
  // 测出来可用的节点才能选；没测过一律直连。

  var mirrorData = null;     // { mirrors, results, best, testedAt }
  var mirrorResults = {};    // id -> result，测速过程中逐条填充
  var mirrorTesting = false;
  var mirrorDone = 0;

  function mirrorTotal() {
    return (mirrorData && mirrorData.mirrors || []).length;
  }

  function mirrorLatClass(ms) {
    if (ms < 400) { return 'fast'; }
    if (ms < 900) { return 'mid'; }
    return 'slow';
  }

  function mirrorById(id) {
    var list = (mirrorData && mirrorData.mirrors) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  /// 造一个格子。`state` 决定它能不能点、显示什么。
  function mirrorCell(meta) {
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'mirror-cell';
    cell.setAttribute('data-id', meta.id);
    cell.appendChild(el('span', 'mc-name', meta.name));

    var r = mirrorResults[meta.id];
    if (r) {
      if (r.ok) {
        cell.classList.add('ready', mirrorLatClass(r.ttfb));
        cell.appendChild(el('span', 'mc-lat', Math.round(r.ttfb) + ' ms'));
      } else {
        cell.classList.add('bad');
        cell.appendChild(el('span', 'mc-lat', r.error || tr('不可用')));
      }
    } else {
      cell.appendChild(el('span', 'mc-lat', mirrorTesting ? '…' : tr('未测')));
    }

    if (mirrorData && mirrorData.best === meta.id) {
      cell.classList.add('on');
    }
    return cell;
  }

  /// 重建整个网格。只在「加载 / 测速结束」时调用；测速过程中走单格更新，
  /// 免得每回来一个结果就重排一次，列表一直在跳。
  function renderMirrorGrid() {
    var grid = document.getElementById('mirror-grid');
    if (!grid) { return; }
    var list = ((mirrorData && mirrorData.mirrors) || []).slice();

    // 有结果的按延迟升序排前面，不可用的沉底，没测的排中间
    list.sort(function (a, b) {
      var ra = mirrorResults[a.id];
      var rb = mirrorResults[b.id];
      var va = ra ? (ra.ok ? ra.ttfb : 1e9) : 5e8;
      var vb = rb ? (rb.ok ? rb.ttfb : 1e9) : 5e8;
      return va - vb;
    });

    grid.innerHTML = '';
    list.forEach(function (m) { grid.appendChild(mirrorCell(m)); });
  }

  /// 只更新一格：测速过程中每回来一个结果调一次。
  function updateMirrorCell(result) {
    var grid = document.getElementById('mirror-grid');
    if (!grid) { return; }
    var cell = grid.querySelector('[data-id="' + result.id + '"]');
    if (!cell) { return; }

    var meta = mirrorById(result.id);
    if (!meta) { return; }

    cell.className = 'mirror-cell';
    cell.innerHTML = '';
    cell.appendChild(el('span', 'mc-name', meta.name));
    if (result.ok) {
      cell.classList.add('ready', mirrorLatClass(result.ttfb));
      cell.appendChild(el('span', 'mc-lat', Math.round(result.ttfb) + ' ms'));
    } else {
      cell.classList.add('bad');
      cell.appendChild(el('span', 'mc-lat', result.error || tr('不可用')));
    }
    if (mirrorData && mirrorData.best === result.id) {
      cell.classList.add('on');
    }
  }

  function updateMirrorCount() {
    var node = document.getElementById('mirror-count');
    if (!node) { return; }
    var total = mirrorTotal();
    if (mirrorTesting) {
      node.textContent = tf('已测 {0} / {1}', mirrorDone, total);
    } else if ((mirrorData && mirrorData.results || []).length) {
      node.textContent = tf('{0} 个节点', total);
    } else {
      node.textContent = tf('{0} 个节点待测速', total);
    }
  }

  function updateFoldSub() {
    var sub = document.getElementById('mirror-fold-sub');
    if (!sub) { return; }
    if (mirrorTesting) {
      sub.textContent = tf('测速中 {0} / {1}', mirrorDone, mirrorTotal());
      return;
    }
    var best = mirrorData && mirrorData.best;
    var meta = best ? mirrorById(best) : null;
    var tested = ((mirrorData && mirrorData.results) || []).length > 0;
    // 测过速又主动选回直连，也要显示「当前镜像：直连 GitHub」，
    // 不能一句「未测速」把用户刚才的操作抹掉
    sub.textContent = (best && meta && (best !== 'direct' || tested))
      ? tf('当前镜像：{0}', meta.name)
      : tr('未测速，直连下载');
  }

  /// 下载地址下面的那行提示：告诉用户这个链接会走哪条路。
  function updateUrlHint() {
    var input = document.getElementById('tb-url');
    var hint = document.getElementById('tb-url-hint');
    if (!input || !hint) { return; }
    var url = input.value.trim();

    if (!url) {
      hint.textContent = '';
      hint.className = 'url-hint';
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      hint.textContent = tr('地址要以 http:// 或 https:// 开头');
      hint.className = 'url-hint';
      return;
    }
    if (!/github(usercontent)?\.com/i.test(url)) {
      hint.textContent = tr('普通链接 · 直连下载');
      hint.className = 'url-hint';
      return;
    }

    var best = mirrorData && mirrorData.best;
    var meta = (best && best !== 'direct') ? mirrorById(best) : null;
    if (meta) {
      hint.textContent = tf('GitHub 文件 · 经 {0} 加速', meta.name);
      hint.className = 'url-hint ok';
    } else {
      hint.textContent = tr('GitHub 文件 · 直连下载（展开下方可测速选镜像）');
      hint.className = 'url-hint';
    }
  }

  function toggleMirrorFold() {
    var fold = document.getElementById('mirror-fold');
    var body = document.getElementById('mirror-fold-body');
    if (!fold || !body) { return; }
    var open = body.hidden;
    body.hidden = !open;
    fold.classList.toggle('open', open);
    if (open) { updateMirrorCount(); }
  }

  function loadMirrorStatus() {
    if (mirrorTesting) { return; }
    apiCall('mirrorStatus', []).then(function (raw) {
      var d = asJson(raw);
      if (!d) { return; }
      mirrorData = d;
      mirrorResults = {};
      (d.results || []).forEach(function (r) { mirrorResults[r.id] = r; });
      renderMirrorGrid();
      updateMirrorCount();
      updateFoldSub();
      updateUrlHint();
    });
  }

  /// 选镜像。只有测出结果的可用节点能选，没测过的一律不让点。
  function pickMirror(id) {
    // 直连永远可选：镜像全挂的时候得让人切回来
    if (id !== 'direct') {
      var r = mirrorResults[id];
      if (!r || !r.ok) { return; }
    }
    if (mirrorData && mirrorData.best === id) { return; }
    apiCall('mirrorPick', [id]).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.ok) { return; }
      if (!mirrorData) { mirrorData = {}; }
      mirrorData.best = d.best;
      renderMirrorGrid();
      updateFoldSub();
      updateUrlHint();
      toast(tf('已切换到 {0}', d.name || d.best), 'ok');
    });
  }

  function startMirrorTest() {
    if (mirrorTesting) { return; }
    mirrorTesting = true;
    mirrorDone = 0;
    var state = document.getElementById('mirror-state');
    if (state) { state.textContent = tr('测速中，每个站最多等 6 秒…'); }
    renderMirrorGrid();
    updateMirrorCount();
    updateFoldSub();

    apiCall('mirrorTest', []).then(function (started) {
      if (started) { return; }
      mirrorTesting = false;
      if (state) { state.textContent = tr('测速请求没发出去'); }
      updateMirrorCount();
      updateFoldSub();
    });
  }

  function startDownload() {
    if (tbState.running) { return; }
    var url = document.getElementById('tb-url').value.trim();
    if (!url) { toast(tr('先填个下载地址')); return; }
    if (!/^https?:\/\//i.test(url)) { toast(tr('地址要以 http:// 或 https:// 开头')); return; }

    var dir = document.getElementById('tb-dir').value.trim();
    var name = document.getElementById('tb-name').value.trim();
    var threads = Number(document.getElementById('tb-threads').value) || 8;

    var isGithub = /github(usercontent)?\.com/i.test(url);
    var best = mirrorData && mirrorData.best;
    var useMirror = isGithub && best && best !== 'direct';

    tbState.running = true;
    renderToolboxProgress({ done: 0, total: 0 });
    if (useMirror) {
      call('toolboxDownloadMirrored', url, dir, name, threads, best);
    } else {
      call('toolboxDownload', url, dir, name, threads);
    }
  }

  function initMirrorPanel() {
    var toggle = document.getElementById('mirror-fold-toggle');
    if (toggle) { toggle.addEventListener('click', toggleMirrorFold); }

    var test = document.getElementById('mirror-test');
    if (test) { test.addEventListener('click', startMirrorTest); }

    var grid = document.getElementById('mirror-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest('.mirror-cell');
        if (cell) { pickMirror(cell.getAttribute('data-id')); }
      });
    }

    var url = document.getElementById('tb-url');
    if (url) {
      url.addEventListener('input', updateUrlHint);
      // 粘贴要等浏览器把值填进去，下一帧再判断
      url.addEventListener('paste', function () { setTimeout(updateUrlHint, 0); });
    }

    loadMirrorStatus();
  }

  function setCheck(id, value) {
    var node = document.getElementById(id);
    if (node && value != null) { node.checked = !!value; }
  }

  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) { node.textContent = text == null ? '' : String(text); }
  }

  function setValue(id, value) {
    var node = document.getElementById(id);
    if (node && document.activeElement !== node) {
      node.value = value == null ? '' : String(value);
    }
  }

  function toggleRow(id, visible) {
    var node = document.getElementById(id);
    if (node) { node.hidden = !visible; }
  }

  /// 填一个自绘下拉。内容没变就只改选中值，避免重建导致焦点丢失。
  function fillSelect(id, items, current) {
    var sel = document.getElementById(id);
    if (!sel) { return; }
    var sig = items.map(function (i) { return i.value; }).join(',');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = '';
      items.forEach(function (i) {
        var o = el('option', null, i.label);
        o.value = i.value;
        sel.appendChild(o);
      });
      sel.dataset.sig = sig;
      if (window.csRegistry && csRegistry[id]) { csRegistry[id].rebuild(); }
    }
    if (document.activeElement !== sel) {
      sel.value = current == null ? '' : String(current);
    }
  }

  /// Java 列表。数据来自 onJavaList，进设置页时 requestJavaList 拉一次。
  function renderJavaList(list) {
    var box = document.getElementById('java-list');
    if (!box) { return; }
    box.innerHTML = '';

    if (!list || !list.length) {
      box.appendChild(el('div', 'empty', '没有检测到 Java。装一个 JRE 8 或 JDK 17/21，再点「重新扫描」。'));
      return;
    }

    list.forEach(function (j) {
      var item = el('div', 'java-item');
      var main = el('div', 'java-main');

      var title = el('div', 'java-title');
      title.appendChild(el('span', null,
        (j.vendor || '未知') + ' ' + (j.jdk ? 'JDK' : 'JRE') + ' ' + (j.version || '?')));
      title.appendChild(el('span', 'java-tag', j.arch || ''));
      main.appendChild(title);
      main.appendChild(el('div', 'java-path', j.path || ''));
      item.appendChild(main);

      var acts = el('div', 'java-acts');
      var open = el('button', 'btn ghost small', '打开目录');
      open.type = 'button';
      open.addEventListener('click', function () { call('revealJava', j.path); });
      acts.appendChild(open);

      var del = el('button', 'btn ghost small', '移除');
      del.type = 'button';
      del.title = j.managed ? '这是 HMCL 自己下载的 Java，移除不会删除文件' : '这只是把它从列表里去掉，不会动磁盘上的文件';
      del.addEventListener('click', function () {
        call('removeJava', j.path);
        toast('已从列表移除');
      });
      acts.appendChild(del);

      item.appendChild(acts);
      box.appendChild(item);
    });
  }

  // ---------------- 下载 Java ----------------
  //
  // 后端一条龙：foojay 拿当前平台可装的版本 → FileDownloadTask 下载（带 sha256）
  // → JavaInstallTask 解压成托管 Java 并注册。前端只管列出来、点一下、看进度。

  /// 最近一次列表，装完要把对应那条标成「已安装」
  var javaDlData = null;

  function openJavaDownload() {
    openModal('java-dl-modal');
    var box = document.getElementById('java-dl-list');
    if (box) {
      box.innerHTML = '';
      var load = el('div', 'loading-block small');
      load.appendChild(loadingRow('正在获取可安装的版本…'));
      box.appendChild(load);
    }
    call('listInstallableJava');
  }

  function renderJavaDownloadList(data) {
    var box = document.getElementById('java-dl-list');
    if (!box) { return; }
    box.innerHTML = '';
    javaDlData = data;

    var hint = document.getElementById('java-dl-hint');
    if (hint && data && data.warning) {
      hint.textContent = data.warning;
    }

    var list = (data && data.list) || [];
    if (!list.length) {
      box.appendChild(el('div', 'empty', '没拿到可安装的版本。检查网络后重开这个窗口。'));
      return;
    }

    list.forEach(function (it) {
      var row = el('div', 'java-dl-item');

      var main = el('div', 'java-dl-main');
      var title = el('div', 'java-dl-title');
      title.appendChild(el('span', null, 'Java ' + it.jdkVersion));
      if (it.lts) { title.appendChild(el('span', 'java-dl-badge lts', 'LTS')); }
      if (it.distro === 'temurin') { title.appendChild(el('span', 'java-dl-badge rec', '推荐')); }
      main.appendChild(title);
      main.appendChild(el('div', 'java-dl-sub',
        (it.vendor || '') + ' · ' + (it.javaVersion || '') + (it.sizeText ? ' · ' + it.sizeText : '')));
      row.appendChild(main);

      var btn = el('button', 'btn ghost small', it.installed ? '已安装' : '安装');
      btn.type = 'button';
      if (it.installed) {
        btn.disabled = true;
        btn.title = tr('这个版本已经在列表里了');
      } else {
        btn.addEventListener('click', function () { installJavaItem(it); });
      }
      row.appendChild(btn);

      box.appendChild(row);
    });
  }

  /// 点「安装」：交给后端跑，进度进右上角的下载任务列表，
  /// 窗口直接关掉 —— 几百 MB 的东西没必要占着一个弹窗等。
  function installJavaItem(item) {
    call('installJava', item.id);
    closeModal('java-dl-modal');
    toast(tr('已加入下载任务：Java ') + item.jdkVersion + tr('，进度看右上角'));
  }

  // ---------------- 迁移旧启动器 ----------------
  //
  // 只搬配置不搬游戏：旧的 .minecraft 留在原地，导入后按原路径登记成游戏目录。
  // 扫描结果、导入结果都从 Java 侧回调过来（onLegacyScanned / onLegacyImported）。

  /// 最近一次扫描结果。导入时要把 data 路径原样传回后端。
  var legacyScan = null;
  /// 旧文件怎么处理：move = 搬完删掉旧的；reference = 只复制一份，旧的留着
  var legacyMode = 'move';

  function renderLegacyMode() {
    var box = document.getElementById('legacy-mode');
    var hint = document.getElementById('legacy-mode-hint');
    if (!box) { return; }
    Array.prototype.forEach.call(box.querySelectorAll('button'), function (btn) {
      btn.classList.toggle('active', btn.dataset.legacyMode === legacyMode);
    });
    if (hint) {
      hint.textContent = legacyMode === 'move'
        ? '搬完把旧目录里这几个文件删掉'
        : '旧的留着，只复制一份过来';
    }
  }

  function renderLegacy() {
    var list = document.getElementById('legacy-list');
    var pathEl = document.getElementById('legacy-data');
    var doBtn = document.getElementById('legacy-do');
    if (!list || !legacyScan) { return; }
    if (pathEl) { pathEl.textContent = legacyScan.data || ''; }
    if (doBtn) { doBtn.disabled = false; doBtn.textContent = tr('导入'); }

    var rows = [
      {
        key: 'accounts',
        title: '账号',
        // 账号列表和登录凭据是两个文件：只有 config 没有 private 的目录搬过来，
        // 账号会全部加载失败，先提醒一句
        sub: (legacyScan.accounts > 0 && legacyScan.credentials === false)
          ? '只有账号列表，没带登录凭据，搬过来要重新登录'
          : '微软、离线、外置登录都在',
        count: legacyScan.accounts || 0,
        unit: '个'
      },
      { key: 'dirs', title: '游戏目录', sub: '游戏还在老地方，这边只记个路径', count: legacyScan.gameDirs || 0, unit: '个' },
      {
        key: 'appearance',
        title: '皮肤、披风与背景图',
        // 旧启动器的背景图有两处不在 appearance/ 下（config/background.*、
        // hmcl.json 里记的那个路径），后端会一并收进外观库
        sub: (legacyScan.backgrounds > 0
          ? '含 ' + legacyScan.backgrounds + ' 张旧背景图，'
          : '') + '并到当前外观库',
        count: legacyScan.appearance || 0,
        unit: '张'
      }
    ];

    list.innerHTML = '';
    rows.forEach(function (row) {
      var empty = row.count <= 0;
      var label = el('label', 'legacy-item' + (empty ? ' disabled' : ' on'));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = row.key;
      cb.checked = !empty;
      cb.disabled = empty;
      label.appendChild(cb);

      var main = el('span', 'legacy-main');
      main.appendChild(el('span', 'legacy-title', row.title));
      main.appendChild(el('span', 'legacy-sub', row.sub));
      label.appendChild(main);
      label.appendChild(el('span', 'legacy-count', empty ? '没找到' : row.count + ' ' + row.unit));

      cb.addEventListener('change', function () {
        label.classList.toggle('on', cb.checked);
      });
      list.appendChild(label);
    });
    renderLegacyMode();
  }

  /// 设置页的控件绑定。只在初始化时跑一次，之后靠 renderSettings 回填。
  function initSettingsControls() {
    // 启动器
    bindSetting('set-language', 'setLauncherSetting', 'language');
    var langSel = document.getElementById('set-language');
    if (langSel) {
      // 语言包是启动时加载的，改了要重启才换过来。不给提示的话
      // 用户会以为设置没生效，反复点。
      langSel.addEventListener('change', function () {
        toast('语言会在下次启动时生效');
      });
    }
    bindSetting('set-accept-preview', 'setLauncherSetting', 'acceptPreviewUpdate');
    bindSetting('set-log-lines', 'setLauncherSetting', 'logLines');
    // 退出后自动备份：开关和保留份数一起绑，改完下一次退出就生效
    bindSetting('set-auto-backup', 'setLauncherSetting', 'autoBackupOnExit');
    bindSetting('set-backup-keep', 'setLauncherSetting', 'backupKeep');

    bindSetting('set-proxy-type', 'setLauncherSetting', 'proxyType');
    bindSetting('set-proxy-host', 'setLauncherSetting', 'proxyHost');
    bindSetting('set-proxy-port', 'setLauncherSetting', 'proxyPort');
    bindSetting('set-proxy-user', 'setLauncherSetting', 'proxyUser');
    bindSetting('set-proxy-pass', 'setLauncherSetting', 'proxyPassword');
    var proxyTypeSel = document.getElementById('set-proxy-type');
    if (proxyTypeSel) {
      proxyTypeSel.addEventListener('change', syncProxyFields);
      syncProxyFields();
    }
    bindSetting('set-addon-source', 'setLauncherSetting', 'defaultAddonSource');

    var exportLog = document.getElementById('set-export-log');
    if (exportLog) {
      exportLog.addEventListener('click', function () { call('exportLogs'); });
    }
    var cleanCache = document.getElementById('set-clean-cache');
    if (cleanCache) {
      cleanCache.addEventListener('click', function () {
        askConfirm('清理下载缓存？只删缓存文件，不影响已安装的游戏和模组。').then(function (yes) {
          if (yes) { call('cleanCache'); }
        });
      });
    }

    var openLog = document.getElementById('set-open-log');
    if (openLog) {
      openLog.addEventListener('click', function () { call('openLogFolder'); });
    }
    bindSetting('set-log-retention', 'setLauncherSetting', 'logRetention');

    // 清理界面缓存（WebView2 的浏览器缓存，在系统盘上，跟启动器目录不在一起）。
    // 只有桌面版能清：JavaFX 模式走的是 WebEngine，没有这套东西。
    var cleanWebview = document.getElementById('set-clean-webview');
    if (cleanWebview) {
      cleanWebview.addEventListener('click', function () {
        var tauri = window.__TAURI__;
        if (!tauri || !tauri.core || !tauri.core.invoke) {
          toast('这个版本没有界面缓存需要清理');
          return;
        }
        askConfirm('清理界面缓存？只删浏览内核的缓存文件，不影响账号和游戏。').then(function (yes) {
          if (!yes) { return; }
          cleanWebview.disabled = true;
          tauri.core.invoke('clean_webview_cache').then(function (bytes) {
            cleanWebview.disabled = false;
            toast(bytes > 0 ? tr('已清理 ') + fmtSize(bytes) : '缓存已经是干净的');
          }).catch(function (err) {
            cleanWebview.disabled = false;
            toast(tr('清理失败：') + (err && err.message ? err.message : err), 'error');
          });
        });
      });
    }

    // 迁移旧启动器。目录选择框在 Java 侧弹（壳模式没有 JavaFX 窗口），
    // 选完由 onLegacyScanned 回调把清单推回来。
    var migrateBtn = document.getElementById('set-migrate');
    if (migrateBtn) {
      migrateBtn.addEventListener('click', function () {
        migrateBtn.disabled = true;
        migrateBtn.textContent = tr('等一下…');
        call('chooseLegacyLauncher');
      });
    }
    var legacyModeBox = document.getElementById('legacy-mode');
    if (legacyModeBox) {
      Array.prototype.forEach.call(legacyModeBox.querySelectorAll('button'), function (btn) {
        btn.addEventListener('click', function () {
          legacyMode = btn.dataset.legacyMode || 'move';
          renderLegacyMode();
        });
      });
    }
    ['legacy-close', 'legacy-cancel'].forEach(function (id) {
      var btn = document.getElementById(id);
      if (btn) { btn.addEventListener('click', function () { closeModal('legacy-modal'); }); }
    });
    var legacyDo = document.getElementById('legacy-do');
    if (legacyDo) {
      legacyDo.addEventListener('click', function () {
        if (!legacyScan) { return; }
        var parts = [];
        Array.prototype.forEach.call(
          document.querySelectorAll('#legacy-list input[type="checkbox"]'),
          function (cb) { if (cb.checked && !cb.disabled) { parts.push(cb.value); } });
        if (!parts.length) { toast('先勾一样', 'error'); return; }
        legacyDo.disabled = true;
        legacyDo.textContent = tr('搬呢…');
        call('importLegacyLauncher', legacyScan.data, parts.join(','), legacyMode);
      });
    }

    // 「有新版本时自动提示」「界面动画」在配置里是反的，单独接
    var autoDialog = document.getElementById('set-auto-update-dialog');
    if (autoDialog) {
      autoDialog.addEventListener('change', function () {
        call('setLauncherSetting', 'disableAutoUpdateDialog', String(!autoDialog.checked));
      });
    }
    var anim = document.getElementById('set-animation');
    if (anim) {
      anim.addEventListener('change', function () {
        call('setLauncherSetting', 'animationDisabled', String(!anim.checked));
        document.body.classList.toggle('no-anim', !anim.checked);
        syncAnimSpeedState(!anim.checked);
      });
    }

    var animSpeed = document.getElementById('set-anim-speed');
    if (animSpeed) {
      animSpeed.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-speed]');
        if (!btn) { return; }
        var name = btn.getAttribute('data-speed');
        // 先应用再存：手感反馈不能等后端往返
        applyAnimSpeed(name);
        call('setLauncherSetting', 'animationSpeed', name);
      });
    }

    // Java
    bindSetting('set-java-type', 'setGameSetting', 'javaType');

    // 版本隔离策略：新建实例时怎么摆 mods / saves
    var isolationSel = document.getElementById('set-isolation');
    if (isolationSel) {
      apiCall('getIsolationType').then(function (v) {
        if (typeof v === 'string' && v) { isolationSel.value = v; }
        if (typeof enhanceAllSelects === 'function') { enhanceAllSelects(); }
      });
      isolationSel.addEventListener('change', function () {
        call('setIsolationType', isolationSel.value);
      });
    }
    bindSetting('set-java-custom', 'setGameSetting', 'customJavaPath');
    bindSetting('set-jvm-options', 'setGameSetting', 'jvmOptions');
    bindSetting('set-no-jvm-opt', 'setGameSetting', 'noOptimizingJVMOptions');
    bindSetting('set-not-use-javaw', 'setGameSetting', 'notUseJavaw');
    bindSetting('set-not-check-jvm', 'setGameSetting', 'notCheckJVM');

    var javaType = document.getElementById('set-java-type');
    if (javaType) {
      javaType.addEventListener('change', function () {
        toggleRow('row-java-custom', javaType.value !== 'auto');
      });
    }

    var javaDownload = document.getElementById('java-download');
    if (javaDownload) {
      javaDownload.addEventListener('click', openJavaDownload);
    }
    var javaDlClose = document.getElementById('java-dl-close');
    if (javaDlClose) {
      javaDlClose.addEventListener('click', function () { closeModal('java-dl-modal'); });
    }
    var javaDlDone = document.getElementById('java-dl-done');
    if (javaDlDone) {
      javaDlDone.addEventListener('click', function () { closeModal('java-dl-modal'); });
    }

    var javaRefresh = document.getElementById('java-refresh');
    if (javaRefresh) {
      javaRefresh.addEventListener('click', function () {
        var box = document.getElementById('java-list');
        if (box) {
          box.innerHTML = '';
          var load = el('div', 'loading-block small');
          load.appendChild(loadingRow('正在扫描…'));
          box.appendChild(load);
        }
        call('refreshJava');
      });
    }
    // 浏览：壳模式下 JavaFX 没有窗口，FileChooser 弹不出来，
    // 后端改用 Windows 原生的打开文件对话框，选完直接加进列表。
    var javaBrowse = document.getElementById('java-browse');
    if (javaBrowse) {
      javaBrowse.addEventListener('click', function () {
        call('pickJavaFile');
        toast('在弹出的窗口里选 javaw.exe');
      });
    }
    var javaAdd = document.getElementById('java-add');
    if (javaAdd) {
      javaAdd.addEventListener('click', function () {
        var input = document.getElementById('java-path');
        var path = input ? input.value.trim() : '';
        if (!path) { toast('先填 java / javaw 的完整路径'); return; }
        call('addJava', path);
        if (input) { input.value = ''; }
        toast('正在检测这个 Java…');
      });
    }

    // 游戏
    bindSetting('set-auto-memory', 'setGameSetting', 'autoMemory');
    bindSetting('set-window-type', 'setGameSetting', 'windowType');
    bindSetting('set-width', 'setGameSetting', 'width');
    bindSetting('set-height', 'setGameSetting', 'height');
    bindSetting('set-running-dir', 'setGameSetting', 'runningDirectory');
    bindSetting('set-priority', 'setGameSetting', 'processPriority');
    bindSetting('set-visibility', 'setGameSetting', 'launcherVisibility');
    bindSetting('set-game-args', 'setGameSetting', 'gameArguments');

    // 内存滑条：拖动只改界面，松手才写盘
    mountMemoryMeter('', function (key, mb) {
      call('setGameSetting', key, String(mb));
    });

    // 勾上「自动分配」时不再把面板藏起来，而是把两根滑条锁住并显示「自动」——
    // 面板里的三段条是用户了解自己机器内存状况的唯一入口，藏了反而什么都看不到
    var autoMemory = document.getElementById('set-auto-memory');
    if (autoMemory) {
      autoMemory.addEventListener('change', function () {
        withGlobalMemory(function (G) {
          renderMemoryMeter('', G.maxMemory || 0, G.minMemory || 0, G, autoMemory.checked);
        });
      });
    }
    var winType = document.getElementById('set-window-type');
    if (winType) {
      winType.addEventListener('change', function () {
        toggleRow('row-window-size', winType.value === 'windowed');
      });
    }
  }

  /// 一个控件对上一个设置项。change 而不是 input——
  /// 输入框每敲一个字就写盘和推状态，光标会被回填打断。
  function bindSetting(id, method, key) {
    var node = document.getElementById(id);
    if (!node) { return; }
    node.addEventListener('change', function () {
      var value = node.type === 'checkbox' ? String(node.checked) : node.value;
      call(method, key, value);
    });
  }

  /// 代理类型选了 http / socks 才显示地址那一行
  function syncProxyFields() {
    var box = document.getElementById('set-proxy-fields');
    var sel = document.getElementById('set-proxy-type');
    if (!box || !sel) { return; }
    var t = String(sel.value || '').toLowerCase();
    box.hidden = !(t === 'http' || t === 'socks');
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
    // 三种情况：
    //   有账号且有头像   → 用它
    //   有账号但头像没到 → 退回内置 Steve（此时确实已经登录了，给张脸合理）
    //   一个账号都没有   → 什么都不显示，换成虚线框 + 「空」
    // 最后一条是重点：以前没账号也画 Steve，看着像已经登录了。
    var src = acc ? (acc.avatar || (state && state.defaultAvatar) || '') : '';
    var empty = img.parentNode ? img.parentNode.querySelector('.avatar-empty') : null;

    img.style.background = 'transparent';
    if (src) {
      img.src = src;
      if (empty) { img.hidden = false; empty.hidden = true; }
    } else {
      img.removeAttribute('src');
      // 有占位元素就交给占位元素，没有（账号列表里那种）就保持原样
      if (empty) { img.hidden = true; empty.hidden = false; }
    }
  }

  function renderHero() {
    var inst = selectedInstance();
    var icon = document.getElementById('hero-icon');
    var name = document.getElementById('hero-name');
    var loader = document.getElementById('hero-loader');
    var meta = document.getElementById('hero-meta');
    var modpack = document.getElementById('hero-modpack');

    if (!inst) {
      name.textContent = tr('当前无已安装实例版本');
      // 没有实例就别挂「原版」这个标签，那个是描述实例加载器的
      loader.hidden = true;
      meta.innerHTML = '';
      // 没实例就没图标可显示。留着会露出 .hero-icon 的灰底方块，
      // 看着像"图片加载失败"
      icon.hidden = true;
      icon.removeAttribute('src');
      // 按钮保持可点：点了弹引导弹窗（下载 / 整合包 / 导入已有目录）。
      // 灰掉的话用户只知道点不动，不知道下一步该干什么。
      document.getElementById('btn-launch').classList.add('no-instance');
      document.getElementById('btn-folder').classList.add('no-instance');
      return;
    }

    document.getElementById('btn-launch').classList.remove('no-instance');
    document.getElementById('btn-folder').classList.remove('no-instance');
    icon.hidden = false;
    icon.src = iconNode(inst, '').src;
    name.textContent = inst.name;
    loader.hidden = false;
    loader.textContent = inst.loader || '原版';
    modpack.hidden = !inst.isModpack;

    meta.innerHTML = '';
    meta.appendChild(el('span', null, 'Java ' + (inst.java || '未知')));
    meta.appendChild(el('span', null, fmtSize(inst.size)));
    meta.appendChild(el('span', null, tr('上次启动 ') + fmtTime(inst.lastLaunch)));
  }

  /// 首页实例网格每页放几个。第 6 格留给翻页卡片，所以是 5。
  var HOME_PAGE_SIZE = 5;
  var homeInstPage = 0;
  /// 只在首次渲染时把页面对齐到「当前启动实例」所在的页；
  /// 之后用户自己翻过就别再拽回来（和下载页实例下拉一个道理）。
  var homeInstAligned = false;

  function renderInstanceGrid() {
    var grid = document.getElementById('instance-grid');
    var all = (state && state.instances) ? state.instances : [];

    var pages = Math.max(1, Math.ceil(all.length / HOME_PAGE_SIZE));
    if (!homeInstAligned && all.length) {
      homeInstAligned = true;
      // 重启后选中的实例可能在第 2 页，先翻到它那一页，
      // 否则卡片里一个「当前」都没有，看着像没选中
      for (var k = 0; k < all.length; k++) {
        if (all[k].id === (state && state.selected)) {
          homeInstPage = Math.floor(k / HOME_PAGE_SIZE);
          break;
        }
      }
    }
    if (homeInstPage >= pages) { homeInstPage = 0; }
    if (homeInstPage < 0) { homeInstPage = 0; }

    var start = homeInstPage * HOME_PAGE_SIZE;
    var list = all.slice(start, start + HOME_PAGE_SIZE);

    grid.innerHTML = '';

    // 空实例时整块隐藏——连「实例 / 查看全部」那一行标题也一起收掉，
    // 只留一张 hero 卡在引导。留个空标题下面什么都没有，看着像加载失败。
    var head = document.getElementById('home-inst-head');
    if (!list.length) {
      grid.hidden = true;
      if (head) { head.hidden = true; }
      grid.removeAttribute('data-count');
      return;
    }
    grid.hidden = false;
    if (head) { head.hidden = false; }

    list.forEach(function (inst) {
      var card = el('div', 'instance-card' + (inst.id === state.selected ? ' current' : ''));
      // 左侧色条按加载器着色（见 app.css）
      card.setAttribute('data-loader', inst.loader || '原版');
      card.appendChild(iconNode(inst, 'instance-icon'));

      var body = el('div', 'instance-body');
      body.appendChild(el('div', 'instance-name', inst.name));
      body.appendChild(el('div', 'instance-line',
        (inst.gameVersion || '') + ' · ' + (inst.loader || '原版') + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')));
      var tags = el('div', 'instance-tags');
      var upd = modpackUpdates[inst.id];
      if (upd && upd.ok && upd.hasUpdate) {
        var badge = el('span', 'tag upd', '可更新');
        badge.title = tf('整合包有新版本 {0}', upd.latestVersion || '');
        tags.appendChild(badge);
      }
      tags.appendChild(el('span', 'tag', fmtSize(inst.size)));
      tags.appendChild(el('span', 'tag', fmtTime(inst.lastLaunch)));
      body.appendChild(tags);
      card.appendChild(body);

      var edit = el('button', 'icon-edit', '✎');
      edit.title = tr('更换图标');
      edit.addEventListener('click', function (e) {
        e.stopPropagation();
        openIconPicker(inst.id);
      });
      card.appendChild(edit);

      // 和实例列表里的「管理」同一去处：进这个实例的设置页。
      // 以前这里直接开安装弹窗，一个 ⚙ 点出「安装新游戏」很容易误触，也跟列表不一致。
      var manage = el('button', 'icon-edit icon-manage', '⚙');
      manage.title = tr('管理');
      manage.addEventListener('click', function (e) {
        e.stopPropagation();
        showInstancePage(inst.id);
      });
      card.appendChild(manage);

      card.addEventListener('click', function () {
        if (inst.id !== state.selected) { call('selectInstance', inst.id); }
      });
      card.addEventListener('dblclick', function () { call('launchInstance'); });

      grid.appendChild(card);
    });

    // 超过一页时，第 6 格换成翻页卡片。点一下翻到下一页，翻到头回到第一页。
    var hasPager = all.length > HOME_PAGE_SIZE;
    if (hasPager) {
      var pager = el('div', 'instance-card instance-page');
      pager.title = tr('点击切换到第 ') + (homeInstPage + 2 > pages ? 1 : homeInstPage + 2) + tr(' 页');
      pager.appendChild(el('span', 'pg-count', (homeInstPage + 1) + ' / ' + pages));
      pager.appendChild(el('strong', null,
        homeInstPage + 1 >= pages ? '回到第一页' : '下一页'));
      pager.appendChild(el('span', 'pg-hint', tr('共 ') + all.length + tr(' 个实例')));
      pager.addEventListener('click', function () {
        homeInstPage = (homeInstPage + 1) % pages;
        renderInstanceGrid();
      });
      grid.appendChild(pager);
    }

    grid.setAttribute('data-count', String(list.length + (hasPager ? 1 : 0)));

    // 「查看全部」按钮不再隐藏：翻页卡片占的是第 6 格，两者不冲突
    var allBtn = document.querySelector('#page-home .section-head [data-page="instances"]');
    if (allBtn) { allBtn.hidden = false; }
  }
  // ---------------- 无实例引导 ----------------
  //
  // 没有实例时点「启动游戏 / 打开目录」不静默失败、也不是把按钮灰掉就完事：
  // 弹一个三选一。第三条是重点——很多人电脑上已经有 PCL2 / HMCL 的 .minecraft，
  // 指过去就能用，不用重下十几个 G。

  function openNoInstance() {
    var modal = document.getElementById('noinst-modal');
    if (modal) { modal.classList.remove('hidden'); }
  }

  function closeNoInstance() {
    var modal = document.getElementById('noinst-modal');
    if (modal) { modal.classList.add('hidden'); }
  }

  function initNoInstanceModal() {
    var modal = document.getElementById('noinst-modal');
    if (!modal) { return; }

    var close = document.getElementById('noinst-close');
    if (close) { close.addEventListener('click', closeNoInstance); }
    var cancel = document.getElementById('noinst-cancel');
    if (cancel) { cancel.addEventListener('click', closeNoInstance); }
    // 点遮罩关闭，和别的弹窗一致
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeNoInstance(); }
    });

    var items = modal.querySelectorAll('.noinst-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var kind = this.getAttribute('data-noinst');
        if (kind === 'dir') {
          closeNoInstance();
          // 原生目录选择框在 Java 侧弹，选完由 onGameDirectoryImported 回调
          call('chooseGameDirectory');
          return;
        }
        closeNoInstance();
        go('download');
        switchDownloadTab(kind === 'modpack' ? 'modpack' : 'game');
      });
    }
  }

  // ---------------- 登录（离线 / 微软 / 外置认证） ----------------
  //
  // 三个弹窗都在页面里画：壳模式没有 JavaFX 窗口，HMCL 自带的登录面板弹不出来。
  // 后端只负责「拿凭据 → 建账号 → 加进列表 → 推状态」，界面全在这里。

  var authlibList = [];
  var loginFlow = '';          // 当前正在登录的方式，用来忽略过期的回调
  /// 微软登录是否还在跑。设备码流程背后是一个最长 15 分钟的轮询，
  /// 用户关掉弹窗就得把它掐掉，否则后台一直转、还可能悄悄登进去一个账号。
  var msLoginActive = false;
  /// 这个构建有没有微软登录的 client id。null = 还没问过后端。
  /// 发行版在 Mojang 审核期不带 id，前端据此把入口置灰。
  var msAuthAvailable = null;

  function openLogin(kind) {
    if (kind === 'microsoft' && msAuthAvailable === false) {
      toast('本版暂未开放微软正版登录，请使用离线登录或外置认证');
      return;
    }
    loginFlow = kind;
    if (kind === 'offline') {
      document.getElementById('lo-name').value =
        (state && state.account && state.account.name) ? '' : '';
      showModal('login-offline');
      syncOfflineHint();
      setTimeout(function () { document.getElementById('lo-name').focus(); }, 60);
      return;
    }
    if (kind === 'microsoft') {
      // 每次都重新申请设备码，旧码可能已经过期
      document.getElementById('lm-stage').textContent = tr('正在申请登录代码…');
      document.getElementById('lm-code-box').hidden = true;
      document.getElementById('lm-open').hidden = true;
      msLoginActive = true;
      showModal('login-ms');
      call('loginMicrosoft');
      return;
    }
    // 外置认证
    showModal('login-authlib');
    document.getElementById('la-add').hidden = true;
    document.getElementById('la-user').value = '';
    document.getElementById('la-pass').value = '';
    document.getElementById('la-url').value = '';
    document.getElementById('la-add-hint').textContent = tr('名称等信息会自动从皮肤站读取');
    call('requestAuthlibServers');
  }

  /// 关闭微软登录弹窗。真在登录的时候顺手把后台轮询掐掉。
  ///
  /// 以前这里只是 hideModal：弹窗关了看不见了，Java 那边的设备码轮询还在跑，
  /// 最长 15 分钟；这期间用户去浏览器授权，账号仍然会登进来——人已经取消了却还是登上了。
  function closeMicrosoftLogin() {
    if (msLoginActive) {
      msLoginActive = false;
      call('cancelMicrosoftLogin');
    }
    hideModal('login-ms');
  }

  function showModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.remove('hidden'); }
  }

  function hideModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.add('hidden'); }
  }

  function renderAuthlibServers(list) {
    authlibList = list || [];
    var sel = document.getElementById('la-server');
    if (!sel) { return; }
    var prev = sel.value;
    sel.innerHTML = '';
    if (!authlibList.length) {
      var empty = el('option', null, '还没有可用的皮肤站');
      empty.value = '';
      sel.appendChild(empty);
      return;
    }
    authlibList.forEach(function (s) {
      var o = el('option', null, s.name + (s.builtin ? '（内置）' : ''));
      o.value = s.url;
      sel.appendChild(o);
    });
    // 尽量保持用户原来选的那个
    if (prev && authlibList.some(function (s) { return s.url === prev; })) {
      sel.value = prev;
    }
  }

  /// 用户名规则照抄 HMCL：`^[A-Za-z0-9_]+$`，不超过 16 个字符
  /// （CreateAccountPane.USERNAME_CHECKER_PATTERN）
  var PROFILE_NAME_RE = /^[A-Za-z0-9_]+$/;

  function offlineNameError(name) {
    if (!name) { return ''; }
    if (name.length > 16) { return tr('不能超过 16 个字符'); }
    if (!PROFILE_NAME_RE.test(name)) { return tr('只能用英文字母、数字和下划线'); }
    return '';
  }

  function syncOfflineHint() {
    var input = document.getElementById('lo-name');
    var hint = document.getElementById('lo-hint');
    var ok = document.getElementById('lo-ok');
    if (!input) { return; }
    var err = offlineNameError(input.value.trim());
    if (hint) {
      hint.textContent = err ? tf('用户名{0}', err) : '';
      hint.hidden = !err;
    }
    if (ok) {
      ok.disabled = !!err || !input.value.trim();
    }
  }

  function submitOffline() {
    var name = document.getElementById('lo-name').value.trim();
    var err = offlineNameError(name);
    if (err) { toast(tf('用户名{0}', err), 'error'); return; }
    if (!name) { toast('先填个用户名', 'error'); return; }
    hideModal('login-offline');
    call('loginOffline', name);
  }

  function submitAuthlib() {
    var url = document.getElementById('la-server').value;
    var user = document.getElementById('la-user').value.trim();
    var pass = document.getElementById('la-pass').value;
    if (!url) { toast('先选一个皮肤站', 'error'); return; }
    if (!user || !pass) { toast('邮箱/用户名和密码都要填', 'error'); return; }
    hideModal('login-authlib');
    call('loginAuthlib', url, user, pass);
  }

  function addAuthlibServer() {
    var url = document.getElementById('la-url').value.trim();
    if (!url) { toast('填一下皮肤站的 API 根地址', 'error'); return; }
    var hint = document.getElementById('la-add-hint');
    hint.textContent = tr('正在读取皮肤站信息…');
    apiCall('addAuthlibServer', [url]).then(function () {
      // 结果由 onAuthlibServers 推回来，这里只兜住失败时把提示还原
      setTimeout(function () {
        if (hint.textContent === '正在读取皮肤站信息…') {
          hint.textContent = tr('名称等信息会自动从皮肤站读取');
        }
      }, 8000);
    });
  }

  // ---------------- 启动器更新 ----------------
  //
  // 走 GitHub Releases：检查 → 下载 → 写一个延迟脚本，退出后解压覆盖再启动。
  // 运行中的 exe 是锁着的，所以最后一步必须等进程退干净才做。

  var updateState = { info: null, ready: false };

  function setUpdateStatus(text) {
    var el = document.getElementById('update-status');
    if (el) { el.textContent = text || ''; }
  }

  function setUpdateBar(percent) {
    var wrap = document.getElementById('update-bar-wrap');
    var bar = document.getElementById('update-bar');
    if (!wrap || !bar) { return; }
    wrap.hidden = percent == null;
    if (percent != null) { bar.style.width = Math.max(0, Math.min(100, percent)) + '%'; }
  }

  function initUpdateUi() {
    var check = document.getElementById('check-update');
    if (check) {
      check.addEventListener('click', function () {
        if (check.disabled) { return; }
        check.disabled = true;
        check.textContent = tr('检查中…');
        var card = document.getElementById('update-card');
        if (card) { card.hidden = true; }
        call('checkLauncherUpdate');
      });
    }
    var now = document.getElementById('update-now');
    if (now) {
      now.addEventListener('click', function () {
        if (now.disabled) { return; }
        if (updateState.ready) { call('applyLauncherUpdate'); return; }
        if (!updateState.info || !updateState.info.url) { return; }
        now.disabled = true;
        now.textContent = tr('下载中…');
        setUpdateStatus('正在下载更新包…');
        setUpdateBar(0);
        call('downloadLauncherUpdate', updateState.info.url, updateState.info.size || 0);
      });
    }
  }

  function initLoginModals() {
    // 三张登录卡片
    var cards = document.querySelectorAll('[data-login]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function () {
        openLogin(this.getAttribute('data-login'));
      });
    }

    // 没有内置 client id 的构建（发行版在 Mojang 审核期就是这种）把微软入口置灰，
    // 别让用户点了才看到失败提示
    apiCall('isMicrosoftAuthAvailable').then(function (raw) {
      var v = asJson(raw);
      msAuthAvailable = (v === true || v === 'true' || raw === true || raw === 'true');
      if (msAuthAvailable) { return; }
      var card = document.querySelector('[data-login="microsoft"]');
      if (!card) { return; }
      card.classList.add('disabled');
      card.setAttribute('aria-disabled', 'true');
      card.title = tr('Mojang 审核通过后开放');
      var sub = card.querySelector('span:last-child');
      if (sub) { sub.textContent = tr('暂未开放，请用离线或外置认证'); }
    }).catch(function () { /* 问不到就按可用处理，不挡用户 */ });

    var bindClose = function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', function () { hideModal(id.replace('-close', '').replace('-cancel', '')); }); }
    };
    // 关掉对应的弹窗（close / cancel 两个按钮都绑）
    ['lo-close', 'lo-cancel'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', function () { hideModal('login-offline'); }); }
    });
    ['lm-close', 'lm-cancel'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', closeMicrosoftLogin); }
    });
    ['la-close', 'la-cancel'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', function () { hideModal('login-authlib'); }); }
    });

    var loOk = document.getElementById('lo-ok');
    if (loOk) { loOk.addEventListener('click', submitOffline); }
    var loName = document.getElementById('lo-name');
    if (loName) {
      loName.addEventListener('input', syncOfflineHint);
      loName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitOffline(); }
      });
    }

    var laOk = document.getElementById('la-ok');
    if (laOk) { laOk.addEventListener('click', submitAuthlib); }
    var laPass = document.getElementById('la-pass');
    if (laPass) {
      laPass.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { submitAuthlib(); }
      });
    }

    var laToggle = document.getElementById('la-toggle-add');
    if (laToggle) {
      laToggle.addEventListener('click', function () {
        var box = document.getElementById('la-add');
        box.hidden = !box.hidden;
        if (!box.hidden) { document.getElementById('la-url').focus(); }
      });
    }
    var laAddOk = document.getElementById('la-add-ok');
    if (laAddOk) { laAddOk.addEventListener('click', addAuthlibServer); }

    var lmOpen = document.getElementById('lm-open');
    if (lmOpen) {
      lmOpen.addEventListener('click', function () {
        var url = document.getElementById('lm-url').href;
        if (url && url !== '#') { call('openLink', url); }
      });
    }
  }

  function renderAccountPage() {
    var acc = state.account;
    document.getElementById('account-name').textContent = acc ? acc.name : '未登录';
    document.getElementById('account-channel').textContent = acc ? acc.channel : '选择一个登录方式';
    document.getElementById('account-uuid').textContent = acc ? acc.uuid : '';
    setAvatar(document.getElementById('account-avatar'), acc);
    document.getElementById('btn-account-remove').disabled = !acc;

    var list = document.getElementById('account-list');
    var accounts = state.accounts || [];
    if (!accounts.length) {
      list.innerHTML = '';
      list.appendChild(el('div', 'empty', '还没有账号。上面三种方式任选一种登录。'));
      return;
    }
    var emptyNode = list.querySelector('.empty');
    if (emptyNode) { emptyNode.remove(); }

    // 按 uuid 复用行，不整段重建。
    // 以前每次 push 都 innerHTML='' 再来一遍：<img> 变成新节点，浏览器得重新
    // 解码一次头像 PNG，于是界面一更新头像就闪 —— 换皮肤、头像异步到货、
    // 点任何按钮都会触发。
    var reuse = {};
    Array.prototype.forEach.call(list.children, function (node) {
      var key = node.getAttribute('data-uuid');
      if (key) { reuse[key] = node; }
    });

    accounts.forEach(function (a, index) {
      var row = reuse[a.uuid];
      if (!row) {
        row = el('div', 'account-row');
        row.setAttribute('data-uuid', a.uuid);
        row.appendChild(document.createElement('img'));
        var main = el('div', 'row-main');
        main.appendChild(el('div', 'row-name'));
        main.appendChild(el('div', 'row-sub'));
        row.appendChild(main);
        row.appendChild(el('button', 'row-del', '删除'));

        // 事件里一律读 data-uuid，不用闭包里的 a：
        // 行是复用的，闭包捕获的那个 a 早就过期了，点删除会删错账号
        row.querySelector('.row-del').addEventListener('click', function (e) {
          e.stopPropagation();
          call('removeAccount', row.getAttribute('data-uuid'));
        });
        row.addEventListener('click', function () {
          if (!row.classList.contains('current')) {
            call('selectAccount', row.getAttribute('data-uuid'));
          }
        });
        // 右键：改名 / 复制账号 ID / 删除。正版与外置认证不给改名——
        // 它们的名字由服务器决定，本地改了下次拉 profile 又变回去。
        row.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          var acc = null;
          (state.accounts || []).forEach(function (x) {
            if (x.uuid === row.getAttribute('data-uuid')) { acc = x; }
          });
          openAccountMenu(e.clientX, e.clientY, acc);
        });
      }

      // 这一行必须写在 if 外面。
      // 原来只在「新建行」的分支里删，复用的行留在 reuse 表里，
      // 函数末尾「清理后端已经不存在的账号」就会把刚复用的行一起 remove 掉 ——
      // 表现就是切换账号后列表整个空白，切走再切回来（列表已空、全部重建）才恢复。
      delete reuse[a.uuid];

      row.classList.toggle('current', !!a.selected);
      setAvatar(row.querySelector('img'), a);
      row.querySelector('.row-name').textContent = a.name;
      row.querySelector('.row-sub').textContent = a.channel;
      // 当前账号不给删除按钮，和以前一致
      row.querySelector('.row-del').hidden = !!a.selected;

      if (list.children[index] !== row) {
        list.insertBefore(row, list.children[index] || null);
      }
    });

    // 后端已经没有的账号，把残留的行清掉
    Object.keys(reuse).forEach(function (key) {
      var node = reuse[key];
      if (node.parentNode) { node.parentNode.removeChild(node); }
    });
    stagger(list);
  }

  /// 账号行右键菜单。
  ///
  /// 离线账号：改名 / 复制账号 ID / 删除
  /// 正版、外置认证：只有复制账号 ID / 删除（名字由服务器决定，改了也没用）
  function openAccountMenu(x, y, acc) {
    if (!acc) { return; }
    var offline = (acc.channel || '').indexOf('离线') >= 0;
    var items = [];

    if (offline) {
      items.push({
        label: '修改昵称',
        action: function () {
          askName(tf('修改「{0}」的昵称', acc.name), acc.name).then(function (value) {
            if (value) { call('renameAccount', acc.uuid, value); }
          });
        }
      });
    }
    items.push({
      label: '复制账号 ID',
      action: function () { call('copyText', acc.uuid); }
    });
    items.push({
      label: '删除账号',
      danger: true,
      action: function () {
        askConfirm(tf('删除账号「{0}」？', acc.name)).then(function (yes) {
          if (yes) { call('removeAccount', acc.uuid); }
        });
      }
    });

    showContextMenu(x, y, items);
  }

  // ---------------- 胶囊指示器 ----------------
  //
  // 导航/分段控件的选中态不再由按钮自己画底，而是一块 .nav-pill 滑过去。
  // 这是最「系统 UI」的一处细节：点哪一格，底色从上一格滑到这一格，
  // 视线不用重新定位，也不会有两帧「旧的高亮没了、新的还没亮」的空档。
  //
  // 为什么必须用 JS：想让滑块跟着选中项，CSS 只有 :has() 和锚点定位两条路，
  // JavaFX WebEngine 两个都没有（它连 ES module 都不支持）。所以老实算坐标。
  //
  // 为什么用 MutationObserver 而不是在每个切换函数里插一句：
  // 会改选中态的地方有七八处（settings 的滚动高亮、下载页切分类、实例页切 tab、
  // syncSeg 到处用、语言切换重建文案……），逐个插迟早漏一个，漏了就是滑块卡住。
  // 观察 class 变化是唯一不漏的挂法。

  var PILL_NAVS = '.dl-tabs, .settings-nav, .seg, .tabs';

  function pillOf(nav) {
    for (var i = 0; i < nav.children.length; i++) {
      if (nav.children[i].classList.contains('nav-pill')) { return nav.children[i]; }
    }
    return null;
  }

  /// 把滑块挪到当前选中项下面。
  ///
  /// 尺寸走 rect 而不是 offsetWidth：按钮可能被 flex 拉伸、被 transform 缩放过，
  /// offsetWidth 拿到的是布局尺寸，和眼睛看到的对不上。
  function syncPill(nav, instant) {
    var pill = pillOf(nav);
    if (!pill) { return; }
    // 选中态标记有几个名字（.on / .active）。滑块自己的显隐**不能**用这两个，
    // 否则 querySelector('.on') 第一个命中的是滑块自己，从此自指、再也动不了。
    var btn = nav.querySelector('.on, .active');
    var nr = nav.getBoundingClientRect();
    var br = btn ? btn.getBoundingClientRect() : null;

    // 页面不可见（display:none）时量出来是 0，收起滑块。
    // 但注意 snap 必须清掉——留着它等于把过渡永久关掉，切回来就是硬跳。
    if (!br || br.width < 1 || br.height < 1) {
      pill.classList.remove('shown', 'snap');
      return;
    }

    // left/top 是相对 nav 的 padding box，rect 差是相对 border box，补掉边框
    var x = br.left - nr.left - nav.clientLeft;
    var y = br.top - nr.top - nav.clientTop;

    if (instant) { pill.classList.add('snap'); }
    pill.style.width = br.width + 'px';
    pill.style.height = br.height + 'px';
    pill.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    pill.classList.add('shown');
    if (instant) {
      // 读一次布局，让浏览器把「无过渡的初始位置」吃进去，
      // 再把过渡还回去 —— 否则第一帧会从 (0,0) 滑过来
      void pill.offsetWidth;
      pill.classList.remove('snap');
    }
  }

  function schedulePill(nav) {
    if (nav.__pillRaf) { return; }
    nav.__pillRaf = requestAnimationFrame(function () {
      nav.__pillRaf = 0;
      syncPill(nav, false);
    });
  }

  function watchPill(nav) {
    if (nav.__pillWatched) { return; }
    nav.__pillWatched = true;

    if (!pillOf(nav)) {
      var pill = document.createElement('span');
      pill.className = 'nav-pill snap';
      nav.insertBefore(pill, nav.firstChild);
    }

    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        // 滑块自己也在改 class（.on / .snap），不排除就是死循环
        if (t && t.classList && t.classList.contains('nav-pill')) { continue; }
        schedulePill(nav);
        return;
      }
    });
    // hidden 也要看：分段控件是一组一组显隐的（盔甲四部位那种），
    // 显示出来的那一刻得重新量一次，否则滑块停在上一次的位置
    mo.observe(nav, {
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
      subtree: true
    });

    nav.classList.add('pill-on');
    syncPill(nav, true);
  }

  /// 窗口尺寸变了所有滑块都要重量：按钮是 flex 撑出来的，宽度全变了。
  function resizePills() {
    var navs = document.querySelectorAll(PILL_NAVS);
    for (var i = 0; i < navs.length; i++) { syncPill(navs[i], true); }
  }

  function initNavPills() {
    var navs = document.querySelectorAll(PILL_NAVS);
    for (var i = 0; i < navs.length; i++) { watchPill(navs[i]); }

    var t = 0;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(resizePills, 120);
    });
  }
  // ---------------- 右键菜单 ----------------
  //
  // 目前只服务实例列表：右键一行把它设成「当前启动实例」。
  // 自己画不用系统菜单——壳里 WebView2 的原生菜单已经被 guard.js 挡掉了，
  // 剩下的「重新加载 / 检查」在应用里本来也不该出现。

  var ctxMenuEl = null;

  function closeContextMenu() {
    if (ctxMenuEl && ctxMenuEl.parentNode) {
      ctxMenuEl.parentNode.removeChild(ctxMenuEl);
    }
    ctxMenuEl = null;
  }

  function showContextMenu(x, y, items) {
    closeContextMenu();
    var menu = el('div', 'ctx-menu');
    items.forEach(function (item) {
      var row = el('button', 'ctx-item' + (item.danger ? ' danger' : ''));
      row.textContent = item.label;
      if (item.disabled) {
        row.disabled = true;
        row.classList.add('off');
      } else {
        row.addEventListener('click', function (e) {
          e.stopPropagation();
          closeContextMenu();
          item.action();
        });
      }
      menu.appendChild(row);
    });
    document.body.appendChild(menu);

    // 先挂上去量尺寸，再决定往左/往上翻，否则贴边时会被裁掉一半
    var rect = menu.getBoundingClientRect();
    var left = x;
    var top = y;
    if (left + rect.width + 8 > window.innerWidth) { left = window.innerWidth - rect.width - 8; }
    if (top + rect.height + 8 > window.innerHeight) { top = window.innerHeight - rect.height - 8; }
    menu.style.left = Math.max(6, left) + 'px';
    menu.style.top = Math.max(6, top) + 'px';
    ctxMenuEl = menu;
  }

  function bindContextMenuDismiss() {
    // 用 mousedown 而不是 click：点空白处要「立刻」收起来，
    // 等到 click 才收的话，按下那一刻菜单还盖在上面
    document.addEventListener('mousedown', function (e) {
      if (!ctxMenuEl) { return; }
      if (ctxMenuEl.contains(e.target)) { return; }
      closeContextMenu();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (ctxMenuEl && e.key === 'Escape') { closeContextMenu(); }
    }, true);
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
  }

  function renderInstanceTable() {
    var table = document.getElementById('instance-table');
    table.innerHTML = '';

    var all = (state && state.instances) || [];
    if (!all.length) {
      // 空表只剩一行表头，看着像坏了。这里只留一句说明：
      // 右上角已经有「导入游戏目录」按钮，再放一个蓝色链接是重复入口
      var hint = el('div', 'empty');
      hint.appendChild(el('div', null, '还没有实例'));
      hint.appendChild(el('div', 'muted small', '点右上角「导入游戏目录」选一个已有的 .minecraft 文件夹'));
      table.appendChild(hint);
      return;
    }

    var head = el('div', 'table-row head');
    // 表头与单元格都带列类名：窄窗口下靠 .col-java 直接隐藏「Java」这一列，
    // 而不是把五列硬压到 400px 宽互相压盖
    [['实例', 'col-name'], ['版本 / 加载器', 'col-ver'], ['Java', 'col-java'],
      ['占用', 'col-size'], ['上次启动', 'col-time'], ['', 'col-act']].forEach(function (c) {
      head.appendChild(el('span', c[1], c[0]));
    });
    table.appendChild(head);

    (state.instances || []).forEach(function (inst) {
      var row = el('div', 'table-row');
      var nameCell = el('span', 'col-name');
      // 图标放名字前面：一排全是文字时，整合包和原版分不出来，
      // 界面上又只有这一处能一眼认出是哪个实例
      var ico = iconNode(inst, 'tbl-ico');
      ico.alt = '';
      nameCell.appendChild(ico);
      nameCell.appendChild(el('span', 'tbl-name', inst.name));
      // 标一下当前启动的是哪个：右键能直接改这个状态，不标出来就无从对照
      if (state && state.selected === inst.id) {
        nameCell.appendChild(el('span', 'tag cur-tag', '当前'));
      }
      row.appendChild(nameCell);
      row.appendChild(el('span', 'muted col-ver',
        (inst.gameVersion || '') + ' / ' + (inst.loader || '原版') + (inst.loaderVersion ? ' ' + inst.loaderVersion : '')));
      row.appendChild(el('span', 'muted col-java', inst.java || '-'));
      row.appendChild(el('span', 'muted col-size', fmtSize(inst.size)));
      row.appendChild(el('span', 'muted col-time', fmtTime(inst.lastLaunch)));

      var act = el('span', 'col-act');
      var manage = el('button', 'link', '管理');
      manage.addEventListener('click', function (e) {
        e.stopPropagation();
        showInstancePage(inst.id);
      });
      act.appendChild(manage);
      row.appendChild(act);

      // 整行可点：点名字、点空白都进管理页，和 HMCL 的实例卡片一致。
      // 不用 <a>，避免让 WebView 觉得这是个可导航的文档。
      row.style.cursor = 'pointer';
      row.title = tf('打开「{0}」的管理页面', inst.name);
      row.addEventListener('click', function () { showInstancePage(inst.id); });

      // 右键：切换「启动哪个实例」。在列表里翻的时候不用先回主页选中，
      // 少一次往返——这是最常用的动作，值得单独给一个入口。
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var current = !!(state && state.selected === inst.id);
        showContextMenu(e.clientX, e.clientY, [
          {
            label: current ? '已是当前启动实例' : '设为当前启动实例',
            disabled: current,
            action: function () { call('selectInstance', inst.id); }
          },
          { label: '打开管理页面', action: function () { showInstancePage(inst.id); } },
          { label: '打开游戏目录', action: function () { call('openFolder', inst.id); } }
        ]);
      });

      table.appendChild(row);
    });
  }

  function renderNews() {
    var box = document.getElementById('news-list');
    box.innerHTML = '';
    if (!news) {
      var newsLoad = el('div', 'empty');
      newsLoad.appendChild(loadingRow('正在从 Mojang 拉取更新日志…'));
      box.appendChild(newsLoad);
      return;
    }
    if (news.error) {
      box.appendChild(el('div', 'empty', tr('动态加载失败：') + news.error));
      return;
    }
    (news.items || []).slice(0, 4).forEach(function (n) {
      // 用 div 不用 a：这是个应用，点它不该有任何导航语义
      var item = el('div', 'news-item');
      item.tabIndex = 0;
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
      item.addEventListener('click', function () { openNewsDetail(n); });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openNewsDetail(n);
        }
      });
      box.appendChild(item);
    });
    stagger(box);
  }

  // ---------------- 动态正文（内置阅读） ----------------
  //
  // Mojang 的正文是 HTML 片段，直接 innerHTML 等于把外部页面塞进来：
  // script、iframe、onclick 属性都会跟着执行。这里用 DOMParser 建一棵树，
  // 只留白名单标签，属性只留 href / src / alt / title，其余全删。

  var NEWS_ALLOWED = {
    P: 1, BR: 1, HR: 1, DIV: 1, SPAN: 1,
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    UL: 1, OL: 1, LI: 1,
    STRONG: 1, EM: 1, B: 1, I: 1, U: 1, S: 1, SMALL: 1,
    A: 1, IMG: 1, FIGURE: 1, FIGCAPTION: 1,
    BLOCKQUOTE: 1, CODE: 1, PRE: 1,
    TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1
  };

  function sanitizeNewsHtml(html) {
    var doc;
    try {
      doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
    } catch (e) {
      return '';
    }
    var root = doc.getElementById('r');
    if (!root) { return ''; }

    function walk(node) {
      var kids = [].slice.call(node.childNodes);
      kids.forEach(function (child) {
        if (child.nodeType === 3) { return; }
        if (child.nodeType !== 1) { child.remove(); return; }

        if (!NEWS_ALLOWED[child.tagName]) {
          // 不认识的标签不留结构，只留里面的文字
          var text = doc.createTextNode(child.textContent || '');
          child.parentNode.replaceChild(text, child);
          return;
        }

        [].slice.call(child.attributes).forEach(function (attr) {
          var name = attr.name.toLowerCase();
          if (name === 'href') {
            if (/^\s*javascript:/i.test(attr.value)) { child.removeAttribute(attr.name); }
            return;
          }
          if (child.tagName === 'IMG' && (name === 'src' || name === 'alt')) { return; }
          if (name === 'alt' || name === 'title' || name === 'colspan' || name === 'rowspan') { return; }
          child.removeAttribute(attr.name);
        });

        walk(child);
      });
    }

    walk(root);
    return root.innerHTML;
  }

  var newsCurrent = null;

  function openNewsDetail(n) {
    if (!n) { return; }
    newsCurrent = n;
    document.getElementById('news-title').textContent = n.title || '动态';
    document.getElementById('news-meta').textContent =
      [fmtTime(n.date), n.version || ''].filter(Boolean).join('  ·  ');

    var art = document.getElementById('news-article');
    art.innerHTML = '';
    art.appendChild(loadingRow('正在加载正文…'));

    document.getElementById('news-modal').classList.remove('hidden');

    if (n.contentPath) {
      call('openNews', n.contentPath);
    } else {
      art.innerHTML = '';
      art.appendChild(el('div', 'news-empty', '这条动态没有正文，只有摘要'));
    }
  }

  function closeNewsDetail() {
    document.getElementById('news-modal').classList.add('hidden');
    newsCurrent = null;
  }

  function renderNewsDetail(data) {
    var art = document.getElementById('news-article');
    if (!art) { return; }

    if (!data || data.loading) {
      art.innerHTML = '';
      art.appendChild(loadingRow('正在加载正文…'));
      return;
    }
    if (data.error) {
      art.innerHTML = '';
      art.appendChild(el('div', 'news-empty', friendlyError(data.error)));
      return;
    }

    var d = data.detail || {};
    if (d.title) {
      document.getElementById('news-title').textContent = d.title;
    }

    art.innerHTML = '';
    var wrap = el('div', 'news-html');
    wrap.innerHTML = sanitizeNewsHtml(d.body || '');
    art.appendChild(wrap);

    // 正文里的图来自 launchercontent.mojang.com，国内偶尔加载不出来，
    // 失败的直接藏掉——留着就是个裂图占位
    [].forEach.call(wrap.querySelectorAll('img'), function (img) {
      img.addEventListener('error', function () { img.style.display = 'none'; });
    });

    // 链接不走站内导航，一律交给系统浏览器
    [].forEach.call(wrap.querySelectorAll('a[href]'), function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var href = a.getAttribute('href');
        if (href && !/^#/.test(href)) { call('openLink', href); }
      });
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

  /* 页面元数据：侧栏高亮、页头标题/描述/图标三处共用一份，
     否则「侧栏点进实例、页头还写着主页」这种不同步迟早出现 */
  var PAGES = {
    home: { title: '主页', desc: '当前实例、快捷启动与官方动态' },
    instances: { title: '实例', desc: '全部实例、加载器与磁盘占用' },
    instance: { title: '实例', desc: '' },
    appearance: { title: '外观', desc: '皮肤与披风修改' },
    lan: { title: '多人联机', desc: 'Terracotta | 陶瓦联机' },
    download: { title: '下载', desc: '游戏版本、模组加载器与整合包' },
    toolbox: { title: '百宝箱', desc: '自定义下载与清理' },
    settings: { title: '设置', desc: '启动器信息与偏好' },
    accounts: { title: '账号', desc: '离线 / 微软 / 外置认证' }
  };

  function setPageHead(page) {
    var meta = PAGES[page] || { title: '', desc: '' };
    var title = document.getElementById('ph-title');
    var desc = document.getElementById('ph-desc');
    var icon = document.getElementById('ph-icon');
    if (title) { title.textContent = tr(meta.title); }
    if (desc) { desc.textContent = tr(meta.desc); }
    // 页头图标直接复刻对应侧栏项的图标；账号页没有侧栏入口，用内置的人像兜底
    if (icon) {
      // 实例详情页（instance）在侧栏里对应的是 instances——直接按自己的 key 查
      // 会查不到，页头就只剩一个空方块（截图里那个白框就是这么来的）
      var railKey = page === 'instance' ? 'instances' : page;
      var src = document.querySelector('.rail-nav .rail-item[data-page="' + railKey + '"] svg');
      if (!src && page === 'accounts') {
        src = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        src.setAttribute('viewBox', '0 0 24 24');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c4 0 7 1.8 7 4v2H5v-2c0-2.2 3-4 7-4z');
        src.appendChild(path);
      }
      icon.innerHTML = src ? src.outerHTML : '';
      var svg = icon.querySelector('svg');
      if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); }
      // 换页面时图标轻弹一下：视线不在页头的人也能感到「换页了」。
      // 摘掉再加回同一个 class，浏览器才会重播动画（改 innerHTML 不重播）。
      icon.classList.remove('pop');
      void icon.offsetWidth;
      icon.classList.add('pop');
    }
  }

  /// 第一次进页面必须完整走一遍（设标题、停预览、补首绘），
  /// 之后同页再点才跳过。HTML 里本来就有一个 `.page.on`，不区分会把首帧吞掉。
  var goBooted = false;

  function go(page) {
    // 已经停在这一页：什么都不做。
    // 以前再点一次导航会把整页重新走一遍 —— 切页、首绘、滚回顶部。
    // 停在账号页再点「账号」，列表会被重建一次（闪一下）、位置弹回顶部，
    // 用户看到的就是「又重新进了一次」。
    var active = document.querySelector('.page.on');
    if (goBooted && active && active.id === 'page-' + page) { return; }
    goBooted = true;

    var items = document.querySelectorAll('.rail-nav .rail-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('on', items[i].getAttribute('data-page') === page);
    }
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) {
      pages[j].classList.toggle('on', pages[j].id === 'page-' + page);
    }
    setPageHead(page);

    var scroller = document.getElementById('page-body');
    if (scroller) { scroller.scrollTop = 0; }

    // 离开实例页就回到「按当前选中实例」的主题；目标没变则保持原样
    if (page !== 'instance') { refreshInstanceThemeIfNeeded(); }

    // 外观页的待机摆动靠 Java 侧定期重绘，离开页面要停掉
    call('setPreviewActive', page === 'appearance');

    // 联机页只在停在页面上时轮询进程状态，走开就停
    if (page !== 'lan' && typeof lanStopPoll === 'function') { lanStopPoll(); }

    if (page === 'download') {
      showDownload();
    } else if (page === 'lan') {
      showLan();
    } else if (page === 'toolbox') {
      // 自动测速可能已经跑完了，切进来时拉一次最新结果
      loadMirrorStatus();
    } else if (page === 'appearance') {
      showAppearance();
    } else {
      if (call('hidePreview') === null) { /* 老版本桥没有这个方法时忽略 */ }
    }

    // render() 只画当前页，所以切过来时补一次首绘。
    // 这几个函数都只读 state、只改 DOM，不会发请求。
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

    // 设置页的分区导航是滚动锚点式的，复位必须放在 translatePage 之后：
    // 翻译会改文字长度，版面高度跟着变，早一步算出来的滚动位置会差一截。
    if (page === 'settings') { restoreSettingsAnchor(); }

    // 页面刚由 display:none 变可见，之前量到的胶囊是 0×0（已收起）。
    // 这里重量一次，让它直接就位 —— 不需要"从上一页滑过来"，
    // 那是同一个页面内部的动效，跨页切换应该是新的开始。
    resizePills();
  }

  // ---------------- 侧栏开合（沿用「记住上次状态」的习惯） ----------------

  var RAIL_KEY = 'mclab.rail.open';

  function railOpen() {
    return document.body.classList.contains('rail-open');
  }

  function setRail(open) {
    document.body.classList.toggle('rail-open', open);
    var btn = document.getElementById('rail-toggle');
    var label = document.getElementById('rail-toggle-label');
    if (btn) { btn.title = tr(open ? '收起侧栏' : '展开侧栏'); }
    if (label) { label.textContent = tr(open ? '收起侧栏' : '展开侧栏'); }
    try { localStorage.setItem(RAIL_KEY, open ? '1' : '0'); } catch (e) { /* 无痕模式无所谓 */ }
    syncSeg('rail-seg', 'data-rail-set', open ? 'open' : 'closed');
  }

  /* 窗口宽度决定 rail 是否强制收起。
     900 是「侧栏摊开 196 之后内容区还剩不到 700」的临界点：
     再窄就该把宽度让给内容，而不是继续摊着侧栏。 */
  var NARROW = 900;
  var narrow = false;

  /// 窗口能缩到多小。
  ///
  /// 后端（tauri 的 min_inner_size）只在用户拖边框时生效，
  /// 程序改尺寸、或某些外接屏的 DPI 缩放会让窗口变小到布局撑不住
  /// （下载页工具栏、六列标签都会溢出到看不见的地方）。
  /// 这里再兜一道：一旦发现比下限还小，立刻拉回来。
  var MIN_W = 880;
  var MIN_H = 620;
  var clamping = false;

  function clampWindowSize() {
    if (clamping) { return; }
    if (window.innerWidth >= MIN_W && window.innerHeight >= MIN_H) { return; }
    var t = window.__TAURI__;
    if (!t || !t.window) { return; }
    clamping = true;
    try {
      var w = t.window.getCurrentWindow ? t.window.getCurrentWindow() : t.window.getCurrent();
      w.setSize(new t.window.LogicalSize(
        Math.max(MIN_W, window.innerWidth),
        Math.max(MIN_H, window.innerHeight)
      )).then(function () {
        setTimeout(function () { clamping = false; }, 200);
      }).catch(function () { clamping = false; });
    } catch (e) {
      clamping = false;
    }
  }

  /// 窄窗口下把**内容区**整体缩一点。
  ///
  /// 下载页的版本表格是六列（版本 / 类型 / 日期 / 两个按钮）定宽加间距，
  /// 880 宽时最右一列会被挤出可视区，用户得拖横向滚动条才看得到下载按钮。
  /// 按可用宽度等比缩，缩到最窄也还有 0.8，再小字就看不清了。
  ///
  /// 用 zoom 不用 transform:scale —— zoom 是真改布局尺寸，里面的 flex/grid
  /// 会照着新的可用宽度重排；transform 只是把已经溢出的结果拍扁，
  /// 该被裁的还是被裁。侧栏不缩：它只有几个图标，缩了反而更难点。
  function applyUiScale() {
    var content = document.querySelector('.content');
    if (!content) { return; }
    var rail = document.getElementById('rail');
    var railW = rail ? rail.getBoundingClientRect().width : 60;
    var availW = window.innerWidth - railW;
    // 1000×690 是「所有页面都不需要横向滚动」的最小内容区
    var scale = Math.min(1, Math.max(0.8,
      Math.min(availW / 1000, window.innerHeight / 690)));
    var next = scale >= 0.995 ? '' : String(Math.round(scale * 1000) / 1000);
    if (content.style.zoom !== next) {
      content.style.zoom = next;
    }
  }

  function syncNarrow() {
    clampWindowSize();
    applyUiScale();
    var now = window.innerWidth < NARROW;
    if (now === narrow) { return; }
    narrow = now;
    document.body.classList.toggle('narrow', now);
    // 从窄变宽时把用户原来选的展开状态还回来（窄的时候是被 CSS 压住的）
    var btn = document.getElementById('rail-toggle');
    if (btn) { btn.title = tr((!now && railOpen()) ? '收起侧栏' : '展开侧栏'); }
    // 侧栏宽度变了，可用宽度跟着变，缩放要重算一次
    applyUiScale();
  }

  /// 崩溃条 / 依赖条的按钮只绑一次。条本身按需显隐。
  function initInstanceHealth() {
    var view = document.getElementById('inst-crash-view');
    if (view) {
      view.addEventListener('click', showCrashModal);
    }
    var close = document.getElementById('inst-crash-close');
    if (close) {
      close.addEventListener('click', function () {
        // 只是这次不看：下次进实例还会提示，报告还在那儿
        var bar = document.getElementById('inst-crash-bar');
        if (bar) { bar.hidden = true; }
      });
    }
    var scanView = document.getElementById('inst-scan-view');
    if (scanView) {
      scanView.addEventListener('click', showScanModal);
    }
    var crashClose = document.getElementById('crash-close');
    if (crashClose) {
      crashClose.addEventListener('click', function () { closeModal('crash-modal'); });
    }
    var modal = document.getElementById('crash-modal');
    if (modal) {
      // 点遮罩关窗；点内容区不关
      modal.addEventListener('click', function (e) {
        if (e.target === modal) { closeModal('crash-modal'); }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeModal('crash-modal'); }
    });
  }

  function initRail() {
    var saved = null;
    try { saved = localStorage.getItem(RAIL_KEY); } catch (e) { /* 忽略 */ }
    // 默认展开：第一次打开就能看清每个入口叫什么
    setRail(saved !== '0');

    document.getElementById('rail-toggle').addEventListener('click', function () {
      if (narrow) { return; }
      setRail(!railOpen());
    });

    var railSeg = document.getElementById('rail-seg');
    if (railSeg) {
      railSeg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-rail-set]');
        if (b) { setRail(b.getAttribute('data-rail-set') === 'open'); }
      });
    }

    syncNarrow();
    window.addEventListener('resize', syncNarrow);
  }

  // ---------------- 主题 ----------------

  var THEME_KEY = 'mclab.theme';
  /// 界面风格（win / mac）和 macOS 皮肤的玻璃开关。
  /// 都是前端状态，不落后端配置 —— 和 theme 一样，换台机器重新选就行，
  /// 而且切换时不用等一次往返。
  var UI_KEY = 'mclab.ui';
  var MAC_GLASS_KEY = 'mclab.macGlass';

  function syncSeg(id, attr, value) {
    var seg = document.getElementById(id);
    if (!seg) { return; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', btns[i].getAttribute(attr) === value);
    }
  }

  function applyTheme(theme, persist) {
    document.body.setAttribute('data-theme', theme);
    if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 忽略 */ } }
    syncSeg('theme-seg', 'data-theme-set', theme);
    // 遮罩的颜色是分主题的（亮色提亮 / 暗色压暗），换主题必须重算一遍，
    // 否则切到暗色后会留着一层白色的遮罩，整个界面发灰
    if (typeof APPEARANCE !== 'undefined' && APPEARANCE.shade) {
      applyShade(APPEARANCE.shade);
    }
  }


  // ---------------- 拖拽安装 ----------------
  //
  // 文件由 Tauri 的原生拖放事件给进来，拿到的是**绝对路径**。
  // 网页的 HTML5 drop 在 WebView2 里被原生接管了，拿不到 File，也不方便处理文件夹。
  // 类型判定交给后端（要看压缩包内部结构），前端只负责转路径和画提示。
  //
  // 落点：实例管理页 → 当前打开的那个实例；其它页面 → 首页选中的那个实例。

  var dropMask = null;

  /// 当前正显示的页面 id（去掉 `page-` 前缀）。
  ///
  /// 页面切换靠 `.on` 这个类，不是 `hidden` —— 之前按 `hidden` 判断「在不在实例页」，
  /// 条件恒为真，于是任何页面都被当成实例页。
  function currentPageId() {
    var active = document.querySelector('.page.on');
    return active ? active.id.replace(/^page-/, '') : '';
  }

  /// 这一页能接住什么。
  ///
  /// - `texture`：外观页，收皮肤 / 披风纹理
  /// - `instance`：首页 / 实例列表 / 实例内容页，收模组、整合包、世界、资源包
  /// - 空串：这一页不收，拖进来直接拒绝
  ///
  /// 以前是「哪儿都能拖」，在下载页、设置页拖个 jar 进去也会静默装到上次选中的实例，
  /// 用户根本不知道装哪去了。
  function dropMode() {
    var page = currentPageId();
    if (page === 'appearance') { return 'texture'; }
    if (page === 'home' || page === 'instances' || page === 'instance') { return 'instance'; }
    return '';
  }

  function dropTargetInstanceId() {
    // 实例内容页正在看哪个实例就装到哪个，其次是首页选中的那个
    if (currentPageId() === 'instance' && instId) { return instId; }
    var inst = selectedInstance();
    return inst ? inst.id : '';
  }

  function dropTargetLabel() {
    var id = dropTargetInstanceId();
    if (!id) { return ''; }
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i].name || id; }
    }
    return id;
  }

  function ensureDropMask() {
    if (dropMask) { return dropMask; }
    dropMask = el('div', 'drop-mask');
    var card = el('div', 'drop-card');
    card.appendChild(el('div', 'drop-arrow', '↓'));
    card.appendChild(el('div', 'drop-title', '松开以安装'));
    card.appendChild(el('div', 'drop-sub', ''));
    card.appendChild(el('div', 'drop-hint', '模组 / 资源包 / 光影 / 存档 / 整合包'));
    dropMask.appendChild(card);
    document.body.appendChild(dropMask);
    return dropMask;
  }

  function showDropMask() {
    var mask = ensureDropMask();
    var sub = mask.querySelector('.drop-sub');
    var hint = mask.querySelector('.drop-hint');
    if (dropMode() === 'texture') {
      sub.textContent = '松开导入皮肤或披风';
      if (hint) { hint.textContent = '自动识别是皮肤还是披风，可以一次拖多张'; }
    } else {
      var label = dropTargetLabel();
      sub.textContent = label ? ('安装到「' + label + '」') : '先选择一个实例';
      if (hint) { hint.textContent = '模组 / 资源包 / 光影 / 存档 / 整合包'; }
    }
    mask.classList.add('show');
  }

  function hideDropMask() {
    if (dropMask) { dropMask.classList.remove('show'); }
  }

  function importDroppedPath(path, instanceId) {
    apiCall('classifyDrop', [path]).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.kind || d.kind === 'unknown') {
        toast((d && d.detail) || ('认不出这个文件：' + path), 'error');
        return;
      }
      if (d.kind === 'schematic') {
        toast('蓝图文件不能直接装进实例', 'error');
        return;
      }
      if (d.kind === 'modpack') {
        // 整合包要联网匹配平台项目，耗时几秒，先给个回执
        toast('正在识别整合包「' + (d.name || '') + '」…');
        apiCall('importDroppedModpack', [path, instanceId]).then(function () {
          refreshAfterDrop('modpack');
        });
        return;
      }
      toast('正在安装 ' + (d.detail || d.name || '') + ' →「' + dropTargetLabel() + '」');
      apiCall('importDropped', [d.kind, path, instanceId]).then(function () {
        refreshAfterDrop(d.kind);
      });
    });
  }

  /// 安装是异步任务，这里只是给界面一个「过一会儿自己刷新」的机会。
  /// 真正的完成信号在下载任务面板里（右上角进度）。
  function refreshAfterDrop(kind) {
    setTimeout(function () {
      call('refresh');
      var page = document.getElementById('page-instances');
      var onInstances = page && !page.classList.contains('hidden');
      if (onInstances && instContentKind && (kind === 'modpack' || instContentKind === kind)) {
        refreshInstContent(instContentKind);
      }
    }, 2500);
  }

  /// 拖到外观页的纹理：路径整批交给后端，它自己读盘、判定类型、去重。
  ///
  /// 不走「一张一张读成 dataUrl 再调 importSkinData」：那样每张都要 base64 一遍，
  /// 批量拖十张就是十次全量编码加十次刷新，中间还会连弹十个 toast。
  function dropTextures(paths) {
    apiCall('importTextures', [JSON.stringify(paths)]).then(function (raw) {
      var d = asJson(raw);
      if (!d || d.ok === false) {
        toast((d && d.error) || '导入失败', 'error');
        return;
      }
      var parts = [];
      if (d.skins) { parts.push('皮肤 ' + d.skins); }
      if (d.capes) { parts.push('披风 ' + d.capes); }
      if (d.existing) { parts.push('已在库中 ' + d.existing); }
      if (d.skipped) { parts.push('跳过 ' + d.skipped); }
      if (!parts.length) {
        toast('没有认出可导入的皮肤或披风', 'error');
        return;
      }
      toast('已导入：' + parts.join('，'));
    });
  }

  function handleDroppedPaths(paths) {
    var mode = dropMode();
    if (!mode) {
      toast('这一页不支持拖入文件。模组整合包拖到首页或实例页，皮肤披风拖到外观页', 'error');
      return;
    }
    if (!paths || !paths.length) { return; }

    if (mode === 'texture') {
      dropTextures(paths);
      return;
    }

    var target = dropTargetInstanceId();
    if (!target) {
      toast('先在首页选一个实例，再拖文件进来', 'error');
      return;
    }
    // 整批交给后端：它要读 zip 元数据才能分清模组和资源包，多个文件最后
    // 只推一条汇总（onDropResult）。之前是一个文件一次请求，拖十个就弹十条 toast。
    toast('正在识别 ' + paths.length + ' 个文件…');
    call('dropImport', JSON.stringify(paths), target);
  }

  function initDragDrop() {
    var api = window.__TAURI__ && window.__TAURI__.webview;
    if (!api || typeof api.getCurrentWebview !== 'function') {
      return;   // JavaFX 模式没有原生拖放，静默跳过
    }
    var webview;
    try { webview = api.getCurrentWebview(); } catch (e) { return; }
    if (!webview || typeof webview.onDragDropEvent !== 'function') { return; }

    webview.onDragDropEvent(function (event) {
      var payload = (event && event.payload) || {};
      if (payload.type === 'enter' || payload.type === 'over') {
        // 接不住的页面连遮罩都不出：弹一个「松开以安装」然后什么都不做，
        // 比干脆没反应更让人困惑
        if (!dropMode()) { return; }
        showDropMask();
        return;
      }
      hideDropMask();
      if (payload.type === 'drop') {
        handleDroppedPaths(payload.paths || []);
      }
    });
  }

  function savedUi() {
    try { return localStorage.getItem(UI_KEY); } catch (e) { return null; }
  }

  /// 切换界面风格。只动 body 上的一个属性，所有差异都在 ui-mac.css 里，
  /// 布局骨架（标题栏 → rail → 页头 → 单滚动容器）一行没改。
  function applyUi(ui, persist) {
    var v = ui === 'mac' ? 'mac' : 'win';
    document.body.setAttribute('data-ui', v);
    if (persist) { try { localStorage.setItem(UI_KEY, v); } catch (e) { /* 忽略 */ } }
    syncSeg('ui-seg', 'data-ui-set', v);
    // 玻璃开关只对 macOS 皮肤有意义，别的皮肤下藏起来省得点
    var row = document.getElementById('mac-glass-row');
    if (row) { row.hidden = (v !== 'mac'); }
  }

  /// macOS 皮肤的毛玻璃开关。
  ///
  /// 关掉后标题栏 / 侧栏换成不透明底色 —— 给老显卡和远程桌面留的出口：
  /// WebView2 一旦退化成软件合成，backdrop-filter 会直接把滚动拖到 30fps。
  function applyMacGlass(on, persist) {
    document.body.classList.toggle('no-glass', !on);
    var box = document.getElementById('set-mac-glass');
    if (box) { box.checked = on; }
    if (persist) { try { localStorage.setItem(MAC_GLASS_KEY, on ? '1' : '0'); } catch (e) { /* 忽略 */ } }
  }

  function initUiSkin() {
    applyUi(savedUi(), false);

    var seg = document.getElementById('ui-seg');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-ui-set]');
        if (b) { applyUi(b.getAttribute('data-ui-set'), true); }
      });
    }

    // 默认开玻璃：macOS 的观感一半来自这层材质
    var glass = true;
    try { glass = localStorage.getItem(MAC_GLASS_KEY) !== '0'; } catch (e) { /* 默认开 */ }
    applyMacGlass(glass, false);

    var box = document.getElementById('set-mac-glass');
    if (box) {
      box.addEventListener('change', function () { applyMacGlass(this.checked, true); });
    }
  }

  // ---------------- 外观：主题色 / 背景图 ----------------
  //
  // 借用 QQ-Bot 的配色模型：主色 + soft 两档，亮色/暗色各存一套。
  // 同一个色相在深底上必须提亮，否则按钮文字和背景糊在一起。
  // 背景图那边也一样：格式按文件头判断（后端做），SVG 一律拒绝。

  /// 默认配色 = 实例主题里用的那个绿 #2fa96b（hsl 150 56% 42%）。
  /// 预设色块的饱和度是 86%，这里单独带一个 56 —— 不然同色相会艳出一截。
  var APPEARANCE = { hue: 150, lum: 42, sat: 56, shade: 68 };

  function hsl(h, s, l) {
    return 'hsl(' + h + ' ' + s + '% ' + l + '%)';
  }

  /// 把主题色铺到 CSS 变量上，顺带更新色相环上的小圆点
  /// @param sat 饱和度（%）。不传按 86 算 —— 六个预设都是这个值，
  ///            只有默认的「松绿」是 56（要跟实例主题那个绿对齐）。
  function applyAccent(hue, lum, sat) {
    var root = document.documentElement;
    var s = (typeof sat === 'number' && sat > 0 && sat <= 100) ? sat : 86;
    root.style.setProperty('--a1', hsl(hue, s, lum));
    // 暗色提亮 12 个百分点封顶 82：再亮就发白，按钮上的白字会看不清
    root.style.setProperty('--a2', hsl(hue, Math.max(0, s - 2), Math.min(82, lum + 12)));
    root.style.setProperty('--as1', hsl(hue, Math.max(0, s - 8), 96));
    root.style.setProperty('--as2', hsl(hue, Math.min(40, Math.round(s * 0.35)), 18));

    // 色相环上的白点：0° 在正上方，conic-gradient 的 from 90deg 也以正上方为起点
    var dot = document.getElementById('hue-dot');
    if (dot) {
      var rad = (hue - 90) * Math.PI / 180;
      var r = 48;
      dot.style.transform = 'translate(' + (Math.cos(rad) * r).toFixed(1) + 'px,'
        + (Math.sin(rad) * r).toFixed(1) + 'px)';
    }
    var core = document.getElementById('hue-core');
    if (core) { core.style.background = hsl(hue, s, lum); }

    var lumInput = document.getElementById('accent-lum');
    if (lumInput && document.activeElement !== lumInput) { lumInput.value = String(lum); }
    setText('accent-lum-text', lum + '%');

    // 六个预设里哪个跟当前值对得上就点亮哪个
    var sws = document.querySelectorAll('#accent-swatches .sw');
    for (var i = 0; i < sws.length; i++) {
      var sh = Number(sws[i].getAttribute('data-accent-h'));
      var sl = Number(sws[i].getAttribute('data-accent-l'));
      sws[i].classList.toggle('on', sh === hue && Math.abs(sl - lum) <= 2);
    }

    APPEARANCE.hue = hue;
    APPEARANCE.lum = lum;
    APPEARANCE.sat = s;
  }

  /// 背景遮罩。亮色往上提、暗色往下压，同一个百分比在两种主题下方向相反。
  function applyShade(pct) {
    var dark = document.body.getAttribute('data-theme') === 'dark';
    var alpha = Math.max(0, Math.min(100, pct)) / 100;
    var rgb = dark ? '8, 10, 16' : '246, 248, 252';
    document.documentElement.style.setProperty('--bg-shade', 'rgba(' + rgb + ', ' + alpha.toFixed(2) + ')');

    var range = document.getElementById('bg-shade-range');
    if (range && document.activeElement !== range) { range.value = String(Math.round(pct)); }
    setText('bg-shade-text', Math.round(pct) + '%');
    APPEARANCE.shade = pct;
  }

  function applyBackground(dataUrl) {
    var root = document.documentElement;
    if (dataUrl) {
      root.style.setProperty('--bg-image', 'url("' + dataUrl + '")');
    } else {
      root.style.removeProperty('--bg-image');
    }
  }

  // ---------------- 背景图库 ----------------
  //
  // 背景图存在外观库里（和皮肤、披风同一套「导入 → 库存 → 切换」），
  // 导入的图会被复制到 <数据目录>/appearance/backgrounds/，原文件之后随便删。

  /// 库里有哪些图：`[{ id, name, thumb }]`，`thumb` 是后端缩好的 320×180。
  var bgItems = [];
  /// 当前选中的那张；空串 = 默认背景。
  var bgCurrentId = '';

  /// 外观偏好这类「要返回值」的调用。
  ///
  /// 壳模式下 nativeBridge 是个 fire-and-forget 的代理（发出去就不管，返回 undefined），
  /// 拿不到结果，所以走本地 HTTP；JavaFX 模式没有 HTTP 端点，退回同步桥。
  function prefCall(method, args) {
    var list = args || [];
    if (apiBase()) { return apiCall(method, list); }
    return Promise.resolve(call.apply(null, [method].concat(list)));
  }

  /// 当前背景那一行：有图显示缩略图 + 名字，没图显示「默认背景」。
  function renderBgCurrent() {
    var img = document.getElementById('bg-current-thumb');
    var name = document.getElementById('bg-current-name');
    var item = null;
    for (var i = 0; i < bgItems.length; i++) {
      if (bgItems[i].id === bgCurrentId) { item = bgItems[i]; break; }
    }
    if (img) {
      if (item && item.thumb) { img.src = item.thumb; img.hidden = false; }
      else { img.removeAttribute('src'); img.hidden = true; }
    }
    if (name) { name.textContent = item ? item.name : tr('默认背景'); }
  }

  /// 一页最多几张：3 列 × 2 行，和实例截图页的密度对齐。
  var BG_PAGE_SIZE = 6;
  var bgPage = 0;

  function bgPageCount() {
    return Math.max(1, Math.ceil(bgItems.length / BG_PAGE_SIZE));
  }

  /// 图库网格：一页 6 张，超出翻页。选中态跟着 bgCurrentId 走。
  function renderBgGrid() {
    var grid = document.getElementById('bg-grid');
    var empty = document.getElementById('bg-empty');
    if (!grid) { return; }
    grid.innerHTML = '';

    // 删到当前页空了要夹回最后一页，否则会停在一片空白上
    var pages = bgPageCount();
    if (bgPage >= pages) { bgPage = pages - 1; }
    if (bgPage < 0) { bgPage = 0; }

    if (empty) { empty.hidden = bgItems.length > 0; }

    var from = bgPage * BG_PAGE_SIZE;
    bgItems.slice(from, from + BG_PAGE_SIZE).forEach(function (item) {
      var card = el('button', 'bg-item' + (item.id === bgCurrentId ? ' on' : ''));
      card.type = 'button';
      card.title = item.name;

      var img = document.createElement('img');
      img.src = item.thumb || '';
      img.alt = item.name;
      card.appendChild(img);

      var bar = el('div', 'bg-bar');
      bar.appendChild(el('span', 'bg-name', item.name));
      card.appendChild(bar);

      // 重命名 / 删除都走右键菜单：卡片上不挂叉，六张图就是六个叉
      card.addEventListener('contextmenu', function (e) { showBgCtx(e, item); });

      card.addEventListener('click', function () {
        if (item.id === bgCurrentId) { closeBgMenu(); return; }
        prefCall('setBackground', [item.id]).then(function (raw) {
          // setBackground 只回「当前背景的 dataUrl」，列表不变，本地改选中态即可
          var url = typeof raw === 'string' ? raw : '';
          if (!url) { return; }
          bgCurrentId = item.id;
          applyBackground(url);
          renderBgCurrent();
          renderBgGrid();
          closeBgMenu();
        });
      });
      grid.appendChild(card);
    });

    var pager = document.getElementById('bg-pager');
    if (pager) {
      pager.hidden = pages <= 1;
      var label = document.getElementById('bg-page-label');
      if (label) { label.textContent = (bgPage + 1) + ' / ' + pages; }
      var prev = document.getElementById('bg-prev');
      var next = document.getElementById('bg-next');
      if (prev) { prev.disabled = bgPage <= 0; }
      if (next) { next.disabled = bgPage + 1 >= pages; }
    }
  }

  function setBgPage(page) {
    var target = Math.max(0, Math.min(bgPageCount() - 1, page));
    if (target === bgPage) { return; }
    bgPage = target;
    renderBgGrid();
  }

  /// 把后端整份偏好落到界面上。导入 / 删除后都走这里，状态只在一处更新。
  function applyAppearancePrefs(d) {
    bgItems = (d && d.backgrounds) ? d.backgrounds : [];
    bgCurrentId = (d && d.backgroundId) ? String(d.backgroundId) : '';
    applyBackground(d && d.background ? String(d.background) : '');
    renderBgCurrent();
    renderBgGrid();
  }

  function openBgMenu() {
    var modal = document.getElementById('bg-modal');
    if (!modal) { return; }
    // 当前背景在第几页就翻到哪页——打开却看不到自己正在用的那张，等于要人猜
    for (var i = 0; i < bgItems.length; i++) {
      if (bgItems[i].id === bgCurrentId) {
        bgPage = Math.floor(i / BG_PAGE_SIZE);
        break;
      }
    }
    renderBgGrid();
    modal.classList.remove('hidden');
  }

  function closeBgMenu() {
    var modal = document.getElementById('bg-modal');
    if (modal) { modal.classList.add('hidden'); }
    closeBgCtx();
  }

  // ---- 卡片右键菜单 ----

  /// 右键菜单当前指向哪张图。
  var bgCtxItem = null;

  function showBgCtx(e, item) {
    var menu = document.getElementById('bg-ctx');
    if (!menu) { return; }
    e.preventDefault();
    e.stopPropagation();
    bgCtxItem = item;
    resetBgCtx();
    menu.hidden = false;
    // 先量再摆：菜单高度随项数变，按坐标硬算会跑出窗口
    var w = menu.offsetWidth;
    var h = menu.offsetHeight;
    var x = Math.min(e.clientX, window.innerWidth - w - 8);
    var y = Math.min(e.clientY, window.innerHeight - h - 8);
    menu.style.left = Math.max(4, x) + 'px';
    menu.style.top = Math.max(4, y) + 'px';
  }

  /// 把「确认删除」复位成「删除」。菜单每次重新打开都要清，
  /// 否则上一次的确认状态会留到下一张图上。
  function resetBgCtx() {
    var menu = document.getElementById('bg-ctx');
    if (!menu) { return; }
    var del = menu.querySelector('[data-ctx="delete"]');
    if (del) {
      del.dataset.armed = '';
      del.textContent = tr('删除');
    }
  }

  function closeBgCtx() {
    var menu = document.getElementById('bg-ctx');
    if (menu) { menu.hidden = true; }
    resetBgCtx();
    bgCtxItem = null;
  }

  /// 菜单项点击。删除要连点两次：第一下把文字变成「确认删除」，第二下才真删——
  /// 背景图删掉得重新导入，不值得一个手滑就没了。
  function handleBgCtx(action) {
    var item = bgCtxItem;
    var menu = document.getElementById('bg-ctx');
    if (!item) { return; }

    if (action === 'rename') {
      closeBgCtx();
      askName(tr('重命名背景图'), item.name).then(function (name) {
        if (!name) { return; }
        prefCall('renameBackground', [item.id, name]).then(function (raw) {
          var d = asJson(raw);
          if (d) { applyAppearancePrefs(d); }
        });
      });
      return;
    }

    if (action === 'delete') {
      var btn = menu ? menu.querySelector('[data-ctx="delete"]') : null;
      if (btn && btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = tr('确认删除');
        return;
      }
      closeBgCtx();
      prefCall('removeBackground', [item.id]).then(function (raw) {
        var d = asJson(raw);
        if (d) { applyAppearancePrefs(d); }
      });
    }
  }

  // ---------------- 动画速度 ----------------
  //
  // 两套倍率，别合成一套：
  //
  //   --anim-scale  控件级。hover / 按压 / 底色渐变，跟着档位线性放大。
  //   --anim-scene  场景级。整页进场、弹窗、菜单、胶囊滑块，放大压过一轮。
  //
  // 为什么必须分开：以前只有一套，优雅档（3.33×）把弹窗拉到 800ms、
  // 把按钮回弹拉到 530ms。点一下要等将近一秒才站稳，那不是「优雅」，
  // 是让人怀疑没点上。大块转场一旦超过 400ms，手感就从从容变成迟钝；
  // 而控件那点微动效慢一点反而显细腻。两个诉求方向相反，只能分两套。
  //
  // 现在的分布（基准 240ms 页面进场 / 300ms 弹窗）：
  //   极速  204ms / 255ms / 控件 160ms
  //   均衡  240ms / 300ms / 控件 208ms
  //   优雅  312ms / 390ms / 控件 256ms
  // 三档拉得开，但没有一档会让人觉得「卡」。

  var ANIM_SPEEDS = { fast: 1, balanced: 1.3, elegant: 1.6 };
  var ANIM_SCENES = { fast: .85, balanced: 1, elegant: 1.3 };
  var animSpeedName = 'fast';

  function applyAnimSpeed(name) {
    var key = ANIM_SPEEDS.hasOwnProperty(name) ? name : 'fast';
    animSpeedName = key;
    var root = document.documentElement.style;
    root.setProperty('--anim-scale', String(ANIM_SPEEDS[key]));
    root.setProperty('--anim-scene', String(ANIM_SCENES[key]));

    var seg = document.getElementById('set-anim-speed');
    if (seg) {
      var buttons = seg.querySelectorAll('button[data-speed]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('active',
          buttons[i].getAttribute('data-speed') === key);
      }
    }
  }

  /// 关掉界面动画时档位没有意义：整行压暗并挡住点击。
  function syncAnimSpeedState(disabled) {
    var row = document.getElementById('set-anim-speed-row');
    if (row) { row.classList.toggle('off', !!disabled); }
  }

  function saveAppearance(key, value) {
    call('setAppearancePref', key, String(value));
  }

  function initAppearancePrefs() {
    // ---- 六个预设 ----
    var wrap = document.getElementById('accent-swatches');
    if (wrap) {
      wrap.addEventListener('click', function (e) {
        var btn = e.target.closest('.sw');
        if (!btn) { return; }
        var hue = Number(btn.getAttribute('data-accent-h'));
        var lum = Number(btn.getAttribute('data-accent-l'));
        var sat = Number(btn.getAttribute('data-accent-s'));
        applyAccent(hue, lum, Number.isFinite(sat) && sat > 0 ? sat : 86);
        saveAppearance('accentSat', APPEARANCE.sat);
        saveAppearance('accentHue', hue);
        saveAppearance('accentLum', lum);
      });
    }

    // ---- 色相环：按下即取色，拖动持续跟随 ----
    var wheel = document.getElementById('hue-wheel');
    if (wheel) {
      var pick = function (e) {
        var r = wheel.getBoundingClientRect();
        var dx = e.clientX - (r.left + r.width / 2);
        var dy = e.clientY - (r.top + r.height / 2);
        // atan2 之后 +90 是因为 0° 要落在正上方，和 conic-gradient 的起点一致
        var deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        if (deg < 0) { deg += 360; }
        applyAccent(Math.round(deg) % 360, APPEARANCE.lum, APPEARANCE.sat);
      };
      wheel.addEventListener('mousedown', function (e) {
        e.preventDefault();
        pick(e);
        var move = function (ev) { pick(ev); };
        var up = function () {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          saveAppearance('accentHue', APPEARANCE.hue);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    }

    // ---- 明度 ----
    var lum = document.getElementById('accent-lum');
    if (lum) {
      lum.addEventListener('input', function () {
        applyAccent(APPEARANCE.hue, Number(this.value), APPEARANCE.sat);
      });
      lum.addEventListener('change', function (e) {
        if (!e.isTrusted) { return; }
        saveAppearance('accentLum', APPEARANCE.lum);
      });
    }

    // ---- 背景图 ----
    var pick2 = document.getElementById('bg-pick');
    if (pick2) {
      pick2.addEventListener('click', function () {
        // 返回的是整份偏好（新图已经设为当前），一次把列表和背景都刷新
        prefCall('importBackground', []).then(function (raw) {
          var d = asJson(raw);
          if (!d) { return; }
          applyAppearancePrefs(d);
          openBgMenu();
        });
      });
    }
    // 点「当前背景」那一行打开图库
    var current = document.getElementById('bg-current');
    if (current) { current.addEventListener('click', openBgMenu); }

    var bgModal = document.getElementById('bg-modal');
    if (bgModal) {
      var bgClose = document.getElementById('bg-modal-close');
      if (bgClose) { bgClose.addEventListener('click', closeBgMenu); }
      // 点遮罩关闭（点内容不关）
      bgModal.addEventListener('click', function (e) {
        if (e.target === bgModal) { closeBgMenu(); }
      });
    }

    var bgCtx = document.getElementById('bg-ctx');
    if (bgCtx) {
      bgCtx.addEventListener('click', function (e) {
        e.stopPropagation();
        var b = e.target.closest('[data-ctx]');
        if (b) { handleBgCtx(b.getAttribute('data-ctx')); }
      });
    }
    // 点菜单外面收起。捕获阶段判一次就够，菜单内部的点击自己 stopPropagation
    document.addEventListener('mousedown', function (e) {
      var menu = document.getElementById('bg-ctx');
      if (!menu || menu.hidden) { return; }
      if (!menu.contains(e.target)) { closeBgCtx(); }
    }, true);
    var bgPrev = document.getElementById('bg-prev');
    if (bgPrev) {
      bgPrev.addEventListener('click', function (e) { e.stopPropagation(); setBgPage(bgPage - 1); });
    }
    var bgNext = document.getElementById('bg-next');
    if (bgNext) {
      bgNext.addEventListener('click', function (e) { e.stopPropagation(); setBgPage(bgPage + 1); });
    }
    var clear = document.getElementById('bg-clear');
    if (clear) {
      clear.addEventListener('click', function () {
        prefCall('clearBackground', []).then(function () {
          bgCurrentId = '';
          applyBackground('');
          renderBgCurrent();
          renderBgGrid();
        });
      });
    }

    var shade = document.getElementById('bg-shade-range');
    if (shade) {
      shade.addEventListener('input', function () { applyShade(Number(this.value)); });
      shade.addEventListener('change', function (e) {
        if (!e.isTrusted) { return; }
        saveAppearance('bgShade', APPEARANCE.shade);
      });
    }

    // ---- 拉一次保存过的偏好 ----
    apiCall('getAppearancePrefs', []).then(function (raw) {
      var d = asJson(raw) || {};
      var hue = Number(d.accentHue);
      var lumv = Number(d.accentLum);
      var satv = Number(d.accentSat);
      var shadev = Number(d.bgShade);

      var hasPrefs = Number.isFinite(hue) && hue > 0 && Number.isFinite(lumv) && lumv > 0;
      // 老版本的默认色是靛蓝（228/62）。存着这一组说明用户从没主动挑过，
      // 跟着新默认走 —— 否则改了默认值，老用户那边纹丝不动。
      if (!hasPrefs || (hue === 228 && lumv === 62)) {
        hue = 150;
        lumv = 42;
        satv = 56;
      }
      applyAccent(
        hue,
        lumv,
        Number.isFinite(satv) && satv > 0 ? satv : 86
      );
      applyShade(Number.isFinite(shadev) && shadev > 0 ? shadev : 68);
      applyAppearancePrefs(d);
    });
  }

  function savedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
  }

  function initTheme() {
    // 没有用户选择时跟系统；有选择就不要再被 Java 推来的 state.theme 覆盖
    var theme = savedTheme();
    if (!theme) {
      theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    applyTheme(theme, false);

    var seg = document.getElementById('theme-seg');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-theme-set]');
        if (b) { applyTheme(b.getAttribute('data-theme-set'), true); }
      });
    }
    syncSeg('rail-seg', 'data-rail-set', railOpen() ? 'open' : 'closed');
    initUiSkin();
  }

  function initUi() {
    // 禁掉 WebView 自带的右键菜单（重新加载 / 另存为 / 检查元素那一套）。
    // 输入框里放行，否则做不了系统的复制粘贴。
    // 皮肤卡片自己的右键菜单不受影响——它在卡片上 stopPropagation 了。
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest('input, textarea')) { return; }
      e.preventDefault();
    });

    initInstanceHealth();

    initRail();
    initTheme();
    initDragDrop();
    initLaunchCheck();
    initLan();
    setPageHead('home');

    // 全站下拉统一成自绘控件。原生 <select> 的弹层是系统画的（灰底方角），
    // 之前只有下载页排序、实例筛选那几个走了 enhanceSelect，实例设置里的
    // 「游戏窗口 / 启动后启动器 / Java 环境」还是原生样式，弹层和页面完全不搭。
    enhanceAllSelects(document);
    observeNewSelects();

    var navs = document.querySelectorAll('.rail-nav .rail-item');
    for (var i = 0; i < navs.length; i++) {
      navs[i].addEventListener('click', function () { go(this.getAttribute('data-page')); });
    }

    // 「查看全部」这类页面内跳转
    var links = document.querySelectorAll('[data-page]:not(.rail-item)');
    for (var n = 0; n < links.length; n++) {
      links[n].addEventListener('click', function () { go(this.getAttribute('data-page')); });
    }

    document.getElementById('account-chip').addEventListener('click', function () { go('accounts'); });
    document.getElementById('btn-launch').addEventListener('click', function () {
      var inst = selectedInstance();
      if (!inst) { openNoInstance(); return; }
      call('launch', inst.id);
    });
    document.getElementById('btn-folder').addEventListener('click', function () {
      var inst = selectedInstance();
      if (!inst) { openNoInstance(); return; }
      call('openFolder', inst.id);
    });
    initNoInstanceModal();
    var importDir = document.getElementById('btn-import-dir');
    if (importDir) { importDir.addEventListener('click', function () { call('chooseGameDirectory'); }); }
    initImportDialog();
    document.getElementById('btn-refresh').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleDownloadPopover();
    });

    // 点空白处收起小窗
    document.addEventListener('click', function (e) {
      if (e.target.closest('#dl-popover') || e.target.closest('#btn-refresh')) { return; }
      toggleDownloadPopover(false);
    });
    document.getElementById('win-min').addEventListener('click', function () { call('minimize'); });
    document.getElementById('win-max').addEventListener('click', function () { call('toggleMaximize'); });
    document.getElementById('win-close').addEventListener('click', function () { call('close'); });
    document.querySelector('.titlebar').addEventListener('dblclick', function (e) {
      if (e.target.closest('.tb-actions') || e.target.closest('.tb-brand')) { return; }
      call('toggleMaximize');
    });
    initWindowDrag();

    document.getElementById('btn-theme').addEventListener('click', function () {
      applyTheme(document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
    });
    document.getElementById('btn-account-remove').addEventListener('click', function () {
      if (state.account) { call('removeAccount', state.account.uuid); }
    });

    initLoginModals();
    initUpdateUi();
    bindInstancePage();
    bindContextMenuDismiss();
    // 内存数据每 30 秒刷一次：开着设置页盯着内存条看，
    // 数字一直不动会让人以为自己机器卡死了
    setInterval(refreshMemorySnapshot, 30000);
    initAppearancePrefs();
    initToolbox();
    // 页面重载后丢掉上一次会话留下的外观草稿，回到「已保存」的状态
    try { call('discardAppearanceDraft'); } catch (e) { /* 后端还没起来就下次再说 */ }

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
    initAppearance();
    initSettings();
    initDownload();
    initNavPills();
    initAddonsModal();
    preloadAppearanceData();
    initLoaderModal();

    document.getElementById('btn-account-appearance').addEventListener('click', function () {
      go('appearance');
    });
  }

  function initWindowDrag() {
    var dragging = false;
    var resizeEdge = null;

    document.querySelector('.titlebar').addEventListener('mousedown', function (e) {
      // 只有拖拽区能拖窗；品牌区和按钮区都不算（否则点 logo 会把窗口拽歪）
      if (e.button !== 0 || !e.target.closest('.tb-drag')) { return; }
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


  // ---------------- 下载页 ----------------

  var dlVersions = null;      // { versions: [...] }
  var dlLoadError = '';       // 非空 = 上次拉清单明确失败，列表区显示重试
  var dlFilter = 'release';   // release | all | snapshot | old
  var dlQuery = '';
  var dlInstalling = null;
  // 正在跑的任务：id -> {percent, stage}。percent 为 -1 表示这一步没有量化进度
  var dlTasks = {};

  // 清单有 1100+ 条：全渲染会明显拖慢滚动（节点翻倍，布局与绘制都翻倍），
  // 所以分页。一页多少条由工具栏的下拉决定（默认 100，范围 20~200），
  // 存 localStorage —— 和主题一样属于「这台机器上的界面偏好」，不值得进配置文件。
  var DL_PAGE_KEY = 'hmcl.dlPageSize';
  var DL_PAGE_DEFAULT = 100;
  var DL_PAGE_MIN = 20;
  var DL_PAGE_MAX = 200;

  /// 读回上次选的条数。localStorage 是用户可改的，越界/乱填一律退回默认。
  function loadDlPageSize() {
    try {
      var v = parseInt(localStorage.getItem(DL_PAGE_KEY), 10);
      if (!isNaN(v) && v >= DL_PAGE_MIN && v <= DL_PAGE_MAX) { return v; }
    } catch (e) { /* 无痕模式 */ }
    return DL_PAGE_DEFAULT;
  }

  var dlPageSize = loadDlPageSize();
  var dlPage = 0;

  /// 改每页条数。夹进 20~200，回到第一页重画；persist 时才写 localStorage。
  function setDlPageSize(v, persist) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) { n = DL_PAGE_DEFAULT; }
    if (n < DL_PAGE_MIN) { n = DL_PAGE_MIN; }
    if (n > DL_PAGE_MAX) { n = DL_PAGE_MAX; }
    if (n === dlPageSize) { return; }
    dlPageSize = n;
    dlPage = 0;
    if (persist) {
      try { localStorage.setItem(DL_PAGE_KEY, String(n)); } catch (e) { /* 忽略 */ }
    }
    renderDownloadList();
  }

  function dlPageCount(total) {
    return Math.max(1, Math.ceil(total / dlPageSize));
  }

  function typeLabel(type) {
    if (type === 'release') { return '正式版'; }
    if (type === 'snapshot') { return '快照'; }
    if (type === 'old-alpha' || type === 'old-beta') { return '远古'; }
    return '其它';
  }

  function typeClass(type) {
    if (type === 'release') { return 'release'; }
    if (type === 'snapshot') { return 'snapshot'; }
    return 'old';
  }

  function matchFilter(type) {
    if (dlFilter === 'all') { return true; }
    if (dlFilter === 'release') { return type === 'release'; }
    if (dlFilter === 'snapshot') { return type === 'snapshot'; }
    return type === 'old-alpha' || type === 'old-beta';
  }

  function fmtDate(ms) {
    if (!ms) { return '—'; }
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /// 版本列表里的发布时间：`2026-10-15 10:18`。
  /// 不带秒——加载器版本之间差几秒没有意义，多两位反而挤。
  function fmtDateTime(ms) {
    if (!ms) { return ''; }
    var d = new Date(ms);
    if (isNaN(d.getTime())) { return ''; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /// 版本清单统一成 `[{ v, date }]`。
  ///
  /// <p>后端推的是对象数组（带发布时间）；也认纯字符串数组 —— 别的推送路径
  /// （CleanroomCompat 那两个补丁）还是老格式，混用时不至于整列空白。
  function normalizeVersionRows(list) {
    if (!list || !list.length) { return []; }
    return list.map(function (item) {
      if (typeof item === 'string') { return { v: item, date: 0 }; }
      var v = item && (item.v || item.version);
      return { v: v == null ? '' : String(v), date: (item && item.date) || 0 };
    }).filter(function (row) { return row.v; });
  }

  /// 把后端的异常串压成一句人话。
  ///
  /// <p>原文是 `org.jackhuang.hmcl.task.DownloadException: Unable to download
  /// https://maven.neoforged.net/... Connection reset`，整段贴进弹窗等于把堆栈甩给用户。
  /// 但要保留「哪个站」和「为什么」——用户排障（挂代理 / 换源 / 稍后再试）靠的就是这两项。
  function fetchErrorMessage(raw) {
    var text = String(raw || '');
    if (!text) { return tr('拉取失败，稍后再试'); }

    var host = '';
    var m = text.match(/https?:\/\/([^\/\s]+)/);
    if (m) { host = m[1]; }

    var reason = '';
    if (/Connection reset|reset by peer|Broken pipe/i.test(text)) { reason = '连接被重置'; }
    else if (/timed? ?out|TimeoutException/i.test(text)) { reason = '请求超时'; }
    else if (/UnknownHost|Name or service not known|NXDOMAIN/i.test(text)) { reason = '域名解析失败'; }
    else if (/SSL|PKIX|certificate/i.test(text)) { reason = '证书校验失败'; }
    else if (/\b40[34]\b/.test(text)) { reason = '资源不存在或拒绝访问'; }
    else if (/\b50[0234]\b/.test(text)) { reason = '对方服务器异常'; }

    if (host && reason) { return tf('连不上 {0}（{1}）', host, reason); }
    if (host) { return tf('连不上 {0}', host); }
    if (reason) { return reason + '，稍后再试'; }
    return text.length > 160 ? text.slice(0, 160) + '…' : text;
  }

  function renderDownloadList() {
    var box = document.getElementById('dl-list');
    if (!box) { return; }
    box.innerHTML = '';

    // 明确失败：只有这里才给「重新拉取」。协议正常但结果为空不是失败，
    // 那种情况在下面按「没有版本」显示，给个刷新按钮反而误导。
    if (dlLoadError) {
      var fail = el('div', 'empty dl-fail');
      fail.appendChild(el('p', 'dl-fail-text', fetchErrorMessage(dlLoadError)));
      var retry = el('button', 'btn ghost small', '重新拉取');
      retry.addEventListener('click', function () {
        dlLoadError = '';
        dlVersions = null;
        renderDownloadList();
        call('requestVersions', true);
      });
      fail.appendChild(retry);
      box.appendChild(fail);
      renderDlPager(0, 0);
      return;
    }

    if (!dlVersions) {
      var verLoad = el('div', 'empty');
      verLoad.appendChild(loadingRow('正在从 Mojang 拉取版本清单…'));
      box.appendChild(verLoad);
      renderDlPager(0, 0);
      return;
    }

    var q = dlQuery.trim().toLowerCase();
    var rows = (dlVersions.versions || []).filter(function (v) {
      if (!matchFilter(v.type)) { return false; }
      return !q || String(v.id).toLowerCase().indexOf(q) >= 0;
    });

    // 过滤条件变了（切筛选 / 改搜索词）时页数会缩水，旧页码可能越界：
    // 夹回最后一页，别让用户停在一片空白上
    var pages = dlPageCount(rows.length);
    if (dlPage > pages - 1) { dlPage = pages - 1; }
    if (dlPage < 0) { dlPage = 0; }

    var count = document.getElementById('dl-count');
    if (count) {
      count.textContent = rows.length + ' ' + tr('个版本')
        + (pages > 1 ? tr('（第 ') + (dlPage + 1) + '/' + pages + tr(' 页）') : '');
    }

    if (!rows.length) {
      box.appendChild(el('div', 'empty', q ? tf('没有匹配「{0}」的版本。', dlQuery) : '这个分类下没有版本。'));
      renderDlPager(0, 0);
      return;
    }

    var head = el('div', 'dl-row head');
    ['版本', '类型', '发布日期', ''].forEach(function (t) { head.appendChild(el('span', null, t)); });
    box.appendChild(head);

    var from = dlPage * dlPageSize;
    rows.slice(from, from + dlPageSize).forEach(function (v) {
      var row = el('div', 'dl-row' + (dlInstalling === v.id ? ' installing' : ''));
      row.appendChild(el('span', 'dl-id', v.id));

      var badge = el('span', 'dl-badge ' + typeClass(v.type), typeLabel(v.type));
      row.appendChild(badge);
      row.appendChild(el('span', 'dl-date', fmtDate(v.date)));

      var btn;
      if (v.installed) {
        btn = el('button', 'btn ghost small', '已安装');
        btn.disabled = true;
      } else {
        btn = el('button', 'btn ghost small', dlInstalling === v.id ? '安装中…' : '安装');
        btn.disabled = !!dlInstalling;
        btn.addEventListener('click', function () {
          // 同时只跑一个安装任务，避免两个任务抢同一个仓库草稿
          if (dlInstalling) { return; }
          openLoaderModal(v.id);
        });
      }
      row.appendChild(btn);

      box.appendChild(row);
    });

    renderDlPager(dlPage, pages);
  }

  /// 翻页条。只有一页时整条藏起来——一页能装下的时候它只是噪音。
  function renderDlPager(page, pages) {
    var pager = document.getElementById('dl-pager');
    if (!pager) { return; }
    // 先写标签再判断隐藏：搜索结果只有 3 条时分页条藏起来，标签停在上一页
    // 虽然看不见，但下次出现时会闪一帧旧页码
    document.getElementById('dl-page-label').textContent = pages > 0 ? (page + 1) + ' / ' + pages : '';
    document.getElementById('dl-prev').disabled = page <= 0;
    document.getElementById('dl-next').disabled = page + 1 >= pages;
    pager.hidden = pages <= 1;
  }

  /// 切到第 p 页（0 基）。页码由调用方保证合法（renderDlPager 的按钮 disabled 兜着）。
  function setDlPage(p) {
    if (p === dlPage) { return; }
    dlPage = p;
    renderDownloadList();
    // 翻页后必须回到列表顶部：停在第 100 行的高度上，用户以为「这页只有半屏」
    var body = document.querySelector('.page-body');
    if (body) { body.scrollTop = 0; }
  }

  // ---------------- 安装选项弹窗（原版 / 加载器） ----------------

  var lmGame = null;      // 要装的游戏版本
  var lmType = '';        // '' = 原版，其余是 patchId
  var lmVersion = null;   // 选中的加载器版本
  var lmVersions = null;  // 当前类型的版本号数组，null = 还没拉
  var lmVersionRows = []; // 同上但带发布时间：[{ v: '65.1.5', date: 1697... }]
  var verQuery = '';      // 版本弹窗里的搜索词
  var verLoadError = '';  // 非空 = 上次拉取明确失败，底部才给刷新按钮

  var LM_MAX = 200;

  // ---------------- 安装新游戏（大弹窗） ----------------
  //
  // 结构照 HMCL 的 InstallersPage：Minecraft 卡片固定显示当前版本，
  // 其余是可选加载器。互斥关系取自 InstallerItemGroup 的 mutualIncompatible：
  // Forge / NeoForge / Fabric / Quilt 两两冲突，OptiFine 不参与互斥。

  var INSTALLER_ITEMS = [
    { id: '',          name: 'Minecraft',  icon: 'img/grass.png',    fixed: true },
    { id: 'forge',     name: 'Forge',      icon: 'img/forge.png' },
    // Cleanroom 是 1.12.2 上 Forge 的延续分支（同一个加载器生态），
    // 上游 CleanroomRemoteVersion 只在 1.12.2 返回版本，别的版本整张卡都不该出现
    { id: 'cleanroom', name: 'Cleanroom',  icon: 'img/cleanroom.png', onlyGame: '1.12.2' },
    // Cleanroom 装完必须往 mods 里放这两个补丁（官方安装说明要求），
    // 单独给两张卡让用户自己挑版本；不选就装最新
    { id: 'fugue',     name: 'Fugue',      icon: 'img/cleanroom.png', addon: true, onlyGame: '1.12.2' },
    { id: 'scalar',    name: 'Scalar Legacy', icon: 'img/cleanroom.png', addon: true, onlyGame: '1.12.2' },
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
    forge:     ['fabric', 'quilt', 'neoforge', 'cleanroom', 'fabricapi', 'quiltapi'],
    // Cleanroom 就是 1.12.2 的 Forge 分支，和任何其它加载器都装不到一起去
    cleanroom: ['forge', 'fabric', 'quilt', 'neoforge', 'optifine', 'fabricapi', 'quiltapi'],
    fabric:    ['forge', 'quilt', 'neoforge', 'cleanroom', 'optifine'],
    quilt:     ['forge', 'fabric', 'neoforge', 'cleanroom', 'optifine'],
    neoforge:  ['forge', 'fabric', 'quilt', 'cleanroom', 'optifine'],
    // OptiFine 和 Forge 能共存，和别的都不行
    optifine:  ['fabric', 'quilt', 'neoforge', 'cleanroom', 'fabricapi', 'quiltapi'],
    fabricapi: ['forge', 'neoforge', 'optifine', 'quiltapi', 'cleanroom'],
    quiltapi:  ['forge', 'neoforge', 'optifine', 'fabricapi', 'cleanroom']
  };

  /// 附属组件跟在谁后面装（`isModLoader()` 为 false，不能单独装）
  var ADDON_NEEDS = {
    fabricapi: 'fabric',
    quiltapi: 'quilt',
    fugue: 'cleanroom',
    scalar: 'cleanroom'
  };

  // 每个加载器在当前游戏版本下到底能不能装。后端查 HMCL 自己的版本清单得出：
  // Fabric / Quilt 的 meta 里没有 1.12.2，NeoForge 从 1.20.1 才有，
  // 都不需要前端手写「支持到哪一版」的表——写死那种表一定会过期。
  //   ok         有可安装版本
  //   unsupported 这个加载器没有这个游戏版本
  //   unavailable 清单根本拉不到（比如这套 provider 没实现 OptiFine）
  var imSupport = {};
  var imSupportLeft = 0;
  var imSupportTimer = 0;

  // 和后端 DownloadService.INSTALLER_TYPES 一一对应
  var INSTALLER_CHECK = ['forge', 'cleanroom', 'neoforge', 'optifine', 'fabric', 'quilt'];

  function resetInstallerSupport() {
    imSupport = {};
    imSupportLeft = INSTALLER_CHECK.length;
    if (imSupportTimer) { clearTimeout(imSupportTimer); }
    // 后端没回话也不能把用户锁死：5 秒后按「能装」处理，退回老行为
    imSupportTimer = setTimeout(function () {
      imSupportTimer = 0;
      INSTALLER_CHECK.forEach(function (t) {
        if (!imSupport[t]) { imSupport[t] = 'ok'; }
      });
      imSupportLeft = 0;
      renderInstallerCards();
      updateInstallButton();
    }, 5000);
  }

  function onInstallerSupport(type, state) {
    // 同一条回两遍（缓存命中 + 查询完成）时不要重复扣计数
    if (!imSupport[type] && imSupportLeft > 0) { imSupportLeft--; }
    imSupport[type] = state;
    if (imSupportLeft <= 0 && imSupportTimer) {
      clearTimeout(imSupportTimer);
      imSupportTimer = 0;
    }
    renderInstallerCards();
    updateInstallButton();
  }

  /// 这张卡对应的加载器当前是什么状态。附属组件（Fabric API / QSL）跟着主加载器走。
  function supportOf(item) {
    if (item.fixed) { return 'ok'; }
    var type = item.addon ? ADDON_NEEDS[item.id] : item.id;
    var state = imSupport[type];
    // unknown = 清单没拉下来（网络问题），既不能当成「不支持」也不能当成「支持」，
    // 按老行为放行：真点进去，让版本弹窗自己去报错
    if (state === 'unknown') { return 'ok'; }
    if (state) { return state; }
    return imSupportLeft > 0 ? 'pending' : 'ok';
  }

  // 上一次自动填进输入框的实例名，用来判断用户有没有手动改过
  var imAutoName = '';

  // 附属组件（fabric-api / quilt-api）：勾选状态，随主加载器一起装
  // 附属组件：id -> 选定版本（'' = 装最新）。Cleanroom 的两个补丁可以同时选，
  // 所以用对象而不是单个字符串。
  var lmAddons = {};
  // 版本弹窗这次是在给附属选版本（true）还是给加载器选（false）
  var verTargetIsAddon = false;

  // 版本小窗当前针对的类型。**不改 lmType**——点了取消就该保持原样，
  // 否则「选 Forge → 点重选 → 取消」之后别的卡已经变灰了，退不回去。
  var verTargetType = '';

  // 非空 = 弹窗开在「已有实例」模式：卡片显示已装版本，右上角给 ↻ 重装
  var imInstanceId = '';
  var imInstalled = {};   // componentId -> version

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

  function openLoaderModal(gameVersion, instanceId) {
    lmGame = gameVersion;
    lmType = '';
    lmVersion = null;
    lmVersions = null;
    lmAddons = {};
    verTargetType = '';
    imAutoName = '';
    imInstanceId = instanceId || '';
    imInstalled = {};

    document.getElementById('im-version').textContent = gameVersion;
    document.getElementById('im-name').value = '';
    syncDefaultName();
    // 先把「这个版本能装哪些加载器」问清楚：卡片在结论回来之前是灰的，
    // 免得用户点开 Fabric（1.12.2 上根本没有）再等一次空清单
    resetInstallerSupport();
    renderInstallerCards();
    updateInstallButton();
    document.getElementById('loader-modal').classList.remove('hidden');
    call('requestInstallerSupport', gameVersion);

    // 已有实例模式：拉一遍它已经装了些什么
    if (imInstanceId) {
      call('instanceInstallers', imInstanceId);
    }
  }

  function closeLoaderModal() {
    document.getElementById('loader-modal').classList.add('hidden');
  }

  function renderInstallerCards() {
    var grid = document.getElementById('im-grid');
    if (!grid) { return; }
    grid.innerHTML = '';

    var activeIds = [];
    if (lmType) { activeIds.push(lmType); }
    Object.keys(lmAddons).forEach(function (id) { activeIds.push(id); });

    INSTALLER_ITEMS.forEach(function (item) {
      // 只在特定游戏版本下才有意义的加载器（目前只有 Cleanroom / 1.12.2）
      if (item.onlyGame && lmGame !== item.onlyGame) { return; }

      var installedVer = imInstalled[item.id] || '';
      var support = (item.fixed || installedVer) ? 'ok' : supportOf(item);

      // 清单根本列不出来的（这套 DownloadProvider 没实现 OptiFine）就别画了，
      // 画出来只会变成一张永远点不动的灰卡
      if (support === 'unavailable' && !installedVer) { return; }

      var card = el('div', 'im-card');
      if (item.fixed) { card.classList.add('fixed'); }

      var picked = item.id !== '' && (lmType === item.id || lmAddons[item.id] !== undefined);
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
      } else if (installedVer) {
        // 已经装在这个实例上了：显示版本，右上角给 ↻ 重装
        sub = installedVer;
        card.classList.add('on');
        var redo = el('button', 'im-again im-reinstall', '↻');
        redo.title = tr('重新安装');
        redo.addEventListener('click', function (e) {
          e.stopPropagation();
          openVersionPicker(item.id);
        });
        card.appendChild(redo);
      } else if (picked) {
        if (item.addon) {
          var av = lmAddons[item.id];
          sub = av ? av : '最新版';
        } else {
          sub = lmVersion || '选择版本';
        }
      } else if (support !== 'ok') {
        // 这个加载器没有当前游戏版本：直接说明白，别让用户点进去再等空清单。
        // 附属组件（Fabric API / QSL）跟着主加载器一起置灰，免得出现
        // 「Fabric 写不支持、Fabric API 还写着需要 Fabric」的分裂文案
        sub = support === 'unsupported' ? (tr('不支持 ') + lmGame) : '检查可用版本…';
        // 只有「确定不支持」才拦点击。pending 是「清单还没回来」——fabric meta
        // 有时要好几秒，这期间把卡片锁死，用户点了没反应，会以为加载器没了。
        // 放行：真点进去，版本弹窗自己会拉清单，拉到就列、拉不到就报错。
        blocked = support === 'unsupported';
      } else if (item.addon) {
        var need = ADDON_NEEDS[item.id];
        if (lmType !== need) {
          // 主加载器没选对：已经选了别的就报不兼容，什么都没选就说缺什么
          sub = lmType ? (tr('与 ') + installerLabel(lmType) + tr(' 不兼容')) : (tr('需要 ') + installerLabel(need));
          blocked = true;
        } else {
          var addonClash = clashWith(item.id, activeIds);
          if (addonClash) { sub = tr('与 ') + installerLabel(addonClash) + tr(' 不兼容'); blocked = true; }
          // 附属组件也走「用户自己决定」：不写「默认最新」——那句话的意思是
          // "不勾也会装"，实际并不会（addonSpec 只从 lmAddons 生成）。
          // 文案和真实行为对不上，用户装完才发现少个东西，比不装更难受。
          else { sub = '未选择'; }
        }
      } else {
        var clash = clashWith(item.id, activeIds);
        if (clash) { sub = tr('与 ') + installerLabel(clash) + tr(' 不兼容'); blocked = true; }
        else { sub = '未选择'; }
      }

      if (blocked) { card.classList.add('disabled'); }
      if (support === 'pending' && !blocked) { card.classList.add('waiting'); }
      card.appendChild(el('div', 'im-sub', sub));

      if (picked) {
        // 已选中的卡片：右上角给「✕ 取消选择」和「重选」。
        // 版本小窗的「取消」只关窗不改状态，想退回未选状态得点这里的 ✕
        // （HMCL 也是这个逻辑：取消选版本 = 放弃本次更换，不等于卸载）。
        var clear = el('button', 'im-again im-clear', '✕');
        clear.title = tr('取消选择');
        clear.addEventListener('click', function (e) {
          e.stopPropagation();
          if (item.addon) { delete lmAddons[item.id]; }
          else { lmType = ''; lmVersion = null; lmAddons = {}; }
          syncDefaultName();
          renderInstallerCards();
          updateInstallButton();
        });
        card.appendChild(clear);

        if (item.addon || lmVersion) {
          var again = el('button', 'im-again im-reselect', '重选');
          again.addEventListener('click', function (e) {
            e.stopPropagation();
            openVersionPicker(item.id);
          });
          card.appendChild(again);
        }
      }

      if (item.id !== '' && !blocked && !installedVer) {
        card.addEventListener('click', function () {
          // 附属卡片也走版本弹窗：以前点一下就直接装最新，用户没法选
          openVersionPicker(item.id);
        });
      }
      grid.appendChild(card);
    });

    // Cleanroom 的附属模组已经是独立卡片（Fugue / Scalar Legacy），
    // 那段「会自动塞进 mods」的说明没必要了
  }

  /// item 与当前已选的组件是否冲突，返回冲突的那个 id
  function clashWith(itemId, activeIds) {
    for (var i = 0; i < activeIds.length; i++) {
      var list = INCOMPATIBLE[activeIds[i]] || [];
      if (list.indexOf(itemId) >= 0) { return activeIds[i]; }
    }
    return null;
  }

  function updateInstallButton() {
    var btn = document.getElementById('im-confirm');
    if (!btn) { return; }
    // 选原版随时可装；选了加载器就必须先把版本定下来
    btn.disabled = lmType !== '' && !lmVersion;
  }

  /// 版本选择窗里的「待定选择」。
  ///
  /// 点列表只改这个变量，点「确定」才写回 lmType / lmVersion。
  /// 以前是点一行立即生效并关窗——手滑点到隔壁版本，只能退出去重开安装弹窗
  /// 才能改回来，是这一块最典型的误操作。
  var verPick = null;
  /// 当前列表里真实渲染出来的版本号，键盘上下切换只在这几个里走
  var verShown = [];

  function openVersionPicker(type) {
    // 卡片的显隐只是界面层，这里再挡一道：万一以后有人用其它方式触发
    var def = null;
    for (var di = 0; di < INSTALLER_ITEMS.length; di++) {
      if (INSTALLER_ITEMS[di].id === type) { def = INSTALLER_ITEMS[di]; break; }
    }
    if (def && def.onlyGame && lmGame !== def.onlyGame) {
      toast(tr('Cleanroom 只支持 ') + def.onlyGame, 'error');
      return;
    }
    // 卡片置灰只是界面层，这里再挡一道：不支持的游戏版本不进版本弹窗
    // 附属组件（Fabric API / Fugue / Scalar）不走加载器支持清单，它们自己查
    var support = (def && def.addon) ? 'ok' : imSupport[type];
    if (support === 'unsupported') {
      toast(installerLabel(type) + tr(' 没有 ') + lmGame + tr(' 的版本'), 'error');
      return;
    }
    if (support === 'unavailable') {
      toast(installerLabel(type) + tr(' 的版本清单不可用'), 'error');
      return;
    }

    // 只记「这次在给谁选」，不动 lmType——用户点取消时其他卡片应该还是原样
    verTargetType = type;
    verTargetIsAddon = !!(def && def.addon);
    verQuery = '';
    var searchBox = document.getElementById('ver-query');
    if (searchBox) { searchBox.value = ''; }
    verPick = null;
    verShown = [];

    document.getElementById('ver-title').textContent = tr('选择 ') + installerLabel(type) + tr(' 版本');
    // 标题只说「选什么」，这里补一句「给哪个游戏版本选、选完怎么生效」
    document.getElementById('ver-sub').textContent =
      'Minecraft ' + lmGame + tr(' · 选中后点「确定」生效');

    document.getElementById('ver-modal').classList.remove('hidden');
    // 每次打开都重新拉：上次失败（网络断了）之后用户关窗再开，应该自动重试一次，
    // 而不是永远停在上次的错误上，还要手动点刷新
    requestVersionList();
  }

  var verWaitTimer = 0;
  var verWaitStart = 0;

  /// 拉取中显示已等待秒数。
  ///
  /// <p>NeoForge 的 maven 单次超时 10s，加上内部重试，一轮就能拖到半分钟。
  /// 只写「正在拉取版本列表…」的话用户分不清是卡死了还是在等，只能干瞪眼。
  function startVerWait() {
    stopVerWait();
    verWaitStart = Date.now();
    verWaitTimer = setInterval(function () {
      var node = document.getElementById('ver-wait');
      if (!node) { return; }
      var sec = Math.round((Date.now() - verWaitStart) / 1000);
      if (sec >= 20) {
        // 20 秒还没结果：NeoForge 的 maven 单次超时 10s、内部还会自己重试一轮，
        // 真卡住时能拖到一分钟。这时候按钮得给出来——用户要么等，要么重开一次，
        // 但干等着看不到任何出口是最糟的。
        node.textContent = tf('网络较慢，已等待 {0} 秒…仍在拉取', sec);
        var refresh = document.getElementById('ver-refresh');
        if (refresh) { refresh.hidden = false; }
      } else {
        node.textContent = sec >= 8
          ? tf('网络较慢，已等待 {0} 秒…', sec)
          : tr('正在拉取版本列表…');
      }
    }, 400);
  }

  function stopVerWait() {
    if (verWaitTimer) { clearInterval(verWaitTimer); verWaitTimer = 0; }
  }

  /// 拉一次版本清单。打开弹窗、点刷新都走这里，状态重置只写一处。
  function requestVersionList() {
    verLoadError = '';
    lmVersions = null;
    lmVersionRows = [];
    startVerWait();
    renderVersionPicker();
    if (verTargetIsAddon) {
      call('requestAddonVersions', verTargetType, lmGame);
    } else {
      call('requestLoaderVersions', lmGame, verTargetType);
    }
  }

  function closeVersionPicker() {
    stopVerWait();
    document.getElementById('ver-modal').classList.add('hidden');
    // 关窗即作废这次待定选择：下次打开重新按「已装 / 最新」预选，
    // 免得上次点了一半的选择在下次莫名生效
    verPick = null;
    verShown = [];
  }

  /// 更新底部「已选 xxx」和「确定」按钮的可用状态。
  /// 这一行是防呆的核心：按钮永远是灰的，直到列表里真的有一个被选中的版本。
  function setVerPick(version) {
    verPick = version || null;

    var tag = document.getElementById('ver-pick');
    if (tag) {
      tag.innerHTML = '';
      if (verPick) {
        tag.appendChild(document.createTextNode('已选 '));
        tag.appendChild(el('b', null, verPick));
      } else {
        tag.textContent = tr('还没选版本');
      }
      tag.title = verPick ? verPick : '';
    }

    var btn = document.getElementById('ver-confirm');
    if (btn) { btn.disabled = !verPick; }
  }

  /// 高亮某一版：只切 class，不重建列表（重建会把滚动位置也一起清掉）
  function highlightVerPick() {
    var list = document.getElementById('ver-list');
    if (!list) { return; }
    var rows = list.querySelectorAll('.lm-item');
    for (var i = 0; i < rows.length; i++) {
      var on = rows[i].getAttribute('data-ver') === verPick;
      rows[i].classList.toggle('on', on);
      if (on) {
        // 键盘上下切换时把选中项滚进视野；鼠标点的本来就在视野里，nearest 不会跳
        try { rows[i].scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老内核不支持参数 */ }
      }
    }
  }

  /// 版本弹窗的列表渲染。
  ///
  /// <p>三种状态分开处理，别混在一起：
  /// <ul>
  ///   <li>还没拉回来 —— 只放一行「正在拉取」</li>
  ///   <li>明确失败 —— 错误文案 + 底部刷新按钮（成功的空列表不给刷新，刷了也一样）</li>
  ///   <li>拿到清单 —— 按搜索词过滤后渲染，每行带发布时间</li>
  /// </ul>
  function renderVersionPicker() {
    var list = document.getElementById('ver-list');
    if (!list) { return; }
    list.innerHTML = '';
    verShown = [];

    var refresh = document.getElementById('ver-refresh');
    var count = document.getElementById('ver-count');
    var clear = document.getElementById('ver-clear');
    if (clear) { clear.hidden = !verQuery; }

    if (verLoadError) {
      stopVerWait();
      var box = el('div', 'lm-empty ver-error');
      box.appendChild(el('div', null, verLoadError));
      list.appendChild(box);
      if (refresh) { refresh.hidden = false; }
      if (count) { count.textContent = ''; }
      setVerPick(null);
      return;
    }
    if (refresh) { refresh.hidden = true; }

    if (!lmVersions) {
      var wait = el('div', 'lm-empty', tr('正在拉取版本列表…'));
      wait.id = 'ver-wait';
      list.appendChild(wait);
      if (count) { count.textContent = ''; }
      setVerPick(null);
      return;
    }

    stopVerWait();
    var rows = filterVersionRows();
    if (count) {
      count.textContent = verQuery
        ? tf('{0} / {1}', rows.length, lmVersionRows.length)
        : tf('共 {0} 个版本', lmVersionRows.length);
    }

    if (!rows.length) {
      list.appendChild(el('div', 'lm-empty', lmVersionRows.length
        ? tf('没有匹配「{0}」的版本。', verQuery)
        : tr('这个游戏版本没有可用的 ') + installerLabel(verTargetType) + tr(' 版本。')));
      setVerPick(null);
      return;
    }

    var shown = rows.slice(0, LM_MAX);
    verShown = shown.map(function (row) { return row.v; });

    shown.forEach(function (item) {
      var v = item.v;
      var row = el('div', 'lm-item');
      row.setAttribute('data-ver', v);

      var main = el('div', 'lm-main');
      main.appendChild(el('span', 'lm-ver', v));
      // 日期只有 Forge / NeoForge(BMCL) / OptiFine 有，别的加载器 meta 里就没有，
      // 拿不到就干脆不占位——一排「未知」比不显示更难看
      if (item.date) { main.appendChild(el('span', 'lm-date', fmtDateTime(item.date))); }
      row.appendChild(main);

      // 装过的版本打个标：避免「以为在升级、其实装的是同一个版本」
      if (imInstalled[verTargetType] === v) {
        row.appendChild(el('span', 'lm-tag', '已安装'));
      }
      row.appendChild(el('span', 'lm-radio'));
      // 单击只选中，不落盘
      row.addEventListener('click', function () {
        setVerPick(v);
        highlightVerPick();
      });
      // 双击 = 选中 + 立即确定，熟练用户少点一次
      row.addEventListener('dblclick', function () {
        setVerPick(v);
        commitVersionPick();
      });
      list.appendChild(row);
    });

    if (rows.length > shown.length) {
      list.appendChild(el('div', 'lm-empty',
        tr('还有 ') + (rows.length - shown.length) + tr(' 个更早的版本未显示，用上面的搜索框缩小范围。')));
    }

    // 预选只在「还没选过」时做一次：搜索时重渲染不能把用户已选的版本跳回第一个
    if (!verPick) {
      // 正在装的这个类型已经有版本就用它（进来改版本时不会丢上下文），
      // 否则选最新一个——但「预选」只是高亮，仍然要用户亲自点确定
      var preset = (lmType === verTargetType && lmVersion && lmVersions.indexOf(lmVersion) >= 0)
        ? lmVersion
        : lmVersions[0];
      setVerPick(preset);
    }
    highlightVerPick();
  }

  /// 按搜索词过滤。版本号是纯字母数字串，直接子串匹配就够——
  /// 用户输「65.1」想找的就是 65.1.x，输「0.16」也是同一个意思。
  function filterVersionRows() {
    var q = verQuery.trim().toLowerCase();
    if (!q) { return lmVersionRows; }
    return lmVersionRows.filter(function (row) {
      return String(row.v).toLowerCase().indexOf(q) >= 0;
    });
  }

  /// 把待定选择写回安装弹窗。唯一会真正改变 lmType / lmVersion 的入口。
  function commitVersionPick() {
    if (!verPick) { return; }
    if (verTargetIsAddon) {
      // 附属：只记版本，不动主加载器
      lmAddons[verTargetType] = verPick;
      closeVersionPicker();
      renderInstallerCards();
      updateInstallButton();
      return;
    }
    lmType = verTargetType;
    lmVersion = verPick;
    // 换了主加载器，附属组件要重新判断（Fabric API 不能跟 Quilt 一起装，
    // Fugue/Scalar 又只跟 Cleanroom 走），一律清掉让用户重选
    lmAddons = {};
    closeVersionPicker();
    syncDefaultName();
    renderInstallerCards();
    updateInstallButton();
  }

  /// 键盘上下切换待定选择
  function moveVerPick(step) {
    if (!verShown.length) { return; }
    var at = verShown.indexOf(verPick);
    var next = at < 0 ? 0 : at + step;
    if (next < 0) { next = 0; }
    if (next > verShown.length - 1) { next = verShown.length - 1; }
    setVerPick(verShown[next]);
    highlightVerPick();
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
    var addonSpec = Object.keys(lmAddons).map(function (id) {
      var v = lmAddons[id];
      return v ? (id + '@' + v) : id;
    }).join(',');
    if (addonSpec) {
      call('installLoaderWithAddon', game, type, version, name, addonSpec);
    } else {
      call('installLoaderNamed', game, type, version, name);
    }
  }

  function initLoaderModal() {
    var modal = document.getElementById('loader-modal');
    if (!modal) { return; }

    document.getElementById('im-close').addEventListener('click', closeLoaderModal);
    document.getElementById('im-cancel').addEventListener('click', closeLoaderModal);
    document.getElementById('im-confirm').addEventListener('click', confirmInstall);

    document.getElementById('im-name-clear').addEventListener('click', function () {
      document.getElementById('im-name').value = '';
    });
    document.getElementById('im-name-reset').addEventListener('click', function () {
      imAutoName = '';
      syncDefaultName();
    });

    document.getElementById('ver-close').addEventListener('click', closeVersionPicker);
    document.getElementById('ver-cancel').addEventListener('click', closeVersionPicker);
    document.getElementById('ver-confirm').addEventListener('click', commitVersionPick);

    // 版本搜索：输入即过滤。加防抖没有意义（数据在内存里，几百条 filter 一遍
    // 比一次键盘事件的处理还便宜），加了反而显得迟钝。
    var verSearch = document.getElementById('ver-query');
    if (verSearch) {
      verSearch.addEventListener('input', function () {
        verQuery = this.value || '';
        renderVersionPicker();
      });
    }
    var verClear = document.getElementById('ver-clear');
    if (verClear) {
      verClear.addEventListener('click', function () {
        verQuery = '';
        if (verSearch) { verSearch.value = ''; verSearch.focus(); }
        renderVersionPicker();
      });
    }
    // 刷新只在拉取失败时出现，点了就是重新拉一次；状态回到「正在拉取」
    var verRefresh = document.getElementById('ver-refresh');
    if (verRefresh) {
      verRefresh.addEventListener('click', function () { requestVersionList(); });
    }

    // 键盘：Enter 确定、Esc 取消、上下切版本。
    // 挂 document 上是因为弹窗本身不接收焦点；先判可见，别的页面敲回车不受影响。
    document.addEventListener('keydown', function (e) {
      var vm = document.getElementById('ver-modal');
      if (!vm || vm.classList.contains('hidden')) { return; }

      // 焦点在搜索框里：方向键归光标，回车 = 取第一个匹配项并确定。
      // 不拦方向键的话，用户想挪光标会把列表的选中项换掉。
      if (document.activeElement === verSearch) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!verPick) {
            var first = filterVersionRows()[0];
            if (first) { setVerPick(first.v); highlightVerPick(); }
          }
          if (verPick) { commitVersionPick(); }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeVersionPicker();
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        closeVersionPicker();
      } else if (e.key === 'Enter') {
        // 没有待定选择时 Enter 不做任何事，避免"以为生效了其实没选"
        if (!verPick) { e.preventDefault(); return; }
        e.preventDefault();
        commitVersionPick();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveVerPick(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveVerPick(-1);
      }
    });

    // 点遮罩关闭（点内容不关）
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeLoaderModal(); }
    });
    var ver = document.getElementById('ver-modal');
    if (ver) {
      ver.addEventListener('click', function (e) {
        if (e.target === ver) { closeVersionPicker(); }
      });
    }
  }

  function showDownload() {
    renderDownloadList();
    // 已经拉过就不再打网络；刷新按钮传 true
    if (!dlVersions) { call('requestVersions', false); }
  }

  /// 下载页顶部那条进度条已经撤掉了，进度统一进右上角的下载任务列表。
  /// 函数留成空实现：还有几处调用点（拉清单、安装收尾）在用它收尾，
  /// 一次性全删容易漏，留个空壳更安全。
  function setDownloadProgress(text, visible) {
  }

  /// 把顶栏那个「刷新」按钮画成当前下载状态。
  /// 多任务时取进度最高的那个——按用户的要求，最高的结束后自动换成下一个。
  // ---------------- 液滴加载动画（LiquidLoader · 直线版） ----------------
  //
  // 移植自 https://github.com/yoavlt/LiquidLoader（MIT，本地也有一份：
  // E:\项目（乐色）\UI Coding\LiquidLoader）。
  // 原库有两套：环形（LiquidCircleEffect）和直线（LiquidLineEffect）。
  // 这里用**直线版**——按钮是 96×32 的胶囊，横排几个点比塞个圆环更像它；
  // 而且直线版里游走圆贴着每个点擦过去，液桥的融合过程看得更清楚。
  //
  // 原库的几何全在 LiquidLineEffect 里：
  //   circleRadius = width * 0.05
  //   circleInter  = (width - 2*r*N) / (N+1)
  //   第 i 个点圆心 x = circleInter + r + i*(circleInter + 2r)
  //   游走圆 x = 最后一个点的右边缘 + inter，再乘 sin(key*π)*0.5+0.5（两端缓一下）
  //   resize(): normalized = 1 - 距离/(r + inter)，就近放大到 1.1 倍
  //   液桥路径见 SimpleCircleLiquidEngine.normalPath / splitPath
  // 另外它那个「发光」才是视觉重点：游走圆用更亮的颜色 + 光晕，
  // 所以这里加了 shadowBlur 和一层径向渐变。

  var LIQ_DOTS = 3;
  var LIQ_DURATION = 1.5;       // key 走完 0→2 的秒数（一次来回）
  var LIQ_RADIUS_RATIO = 0.05;  // 同 LiquidLineEffect
  var LIQ_MOVE_SCALE = 0.8;     // 游走圆半径倍数
  var LIQ_THRESH = 1.0;         // radiusThresh = 圆半径 × 1.0
  var LIQ_ANGLE_THRESH = 0.2;   // 同 LiquidLineEffect
  var LIQ_CONNECT_THRESH = 0.3;
  var LIQ_SCALE_MAX = 1.1;

  function liqPoint(c, rad, dist) {
    return { x: c.x + Math.cos(rad) * dist, y: c.y + Math.sin(rad) * dist };
  }
  function liqDist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function liqMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function liqSplit(from, to, t) {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  /// 两条直线求交（对应 CGPoint.intersection(p1, to: p3, from2: p2, to2: p4)）
  function liqIntersect(a1, a2, b1, b2) {
    var d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
    if (Math.abs(d) < 1e-9) { return null; }
    var t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
    return { x: a1.x + (a2.x - a1.x) * t, y: a1.y + (a2.y - a1.y) * t };
  }
  function liqRatio(a, ra, b, rb, thresh) {
    var ratio = 1 - (liqDist(a, b) - thresh) / (ra + rb + thresh);
    return Math.min(1, Math.max(0, ratio));
  }
  function liqConnectedPoints(c, rc, o, angle) {
    var rad = Math.atan2(o.y - c.y, o.x - c.x);
    return [liqPoint(c, rad + angle, rc), liqPoint(c, rad - angle, rc)];
  }

  /// 画两个圆之间的液桥。返回 false 表示还没近到要连。
  function liqBridge(ctx, c, rc, o, ro, thresh) {
    if (liqDist(c, o) - rc - ro >= thresh) { return false; }
    var ratio = liqRatio(c, rc, o, ro, thresh);

    if (ratio >= LIQ_ANGLE_THRESH) {
      var angle = Math.PI / 2 * ((ratio + LIQ_CONNECT_THRESH) / (1 + LIQ_CONNECT_THRESH));
      var ab = liqConnectedPoints(c, rc, o, angle);
      var cd = liqConnectedPoints(o, ro, c, angle);
      var cross = liqIntersect(ab[0], cd[0], ab[1], cd[1]);
      if (!cross) { return false; }
      var k = ratio * 1.25 - 0.25;
      var m1 = liqSplit(liqMid(ab[0], cd[1]), cross, k);
      var m2 = liqSplit(liqMid(ab[1], cd[0]), cross, k);
      ctx.beginPath();
      ctx.moveTo(ab[0].x, ab[0].y);
      ctx.quadraticCurveTo(m1.x, m1.y, cd[1].x, cd[1].y);
      ctx.lineTo(cd[0].x, cd[0].y);
      ctx.quadraticCurveTo(m2.x, m2.y, ab[1].x, ab[1].y);
      ctx.closePath();
      ctx.fill();
      return true;
    }

    // ratio 很小时两圆几乎分离，原库只留两条细弧（splitPath）
    var e = Math.PI * 40 / 180;
    var p12 = liqConnectedPoints(c, rc, o, e);
    var p34 = liqConnectedPoints(o, ro, c, e);
    var cross2 = liqIntersect(p12[0], p34[0], p12[1], p34[1]);
    if (!cross2) { return false; }
    var d1 = liqConnectedPoints(c, rc, o, 0)[0];
    var d2 = liqConnectedPoints(o, ro, c, 0)[0];
    var t = (ratio - LIQ_CONNECT_THRESH) / (LIQ_ANGLE_THRESH - LIQ_CONNECT_THRESH);
    var a1 = liqSplit(d1, liqMid(cross2, d2), 1 - t);
    var a2 = liqSplit(d2, liqMid(cross2, d1), 1 - t);
    ctx.beginPath();
    ctx.moveTo(p12[0].x, p12[0].y);
    ctx.quadraticCurveTo(a1.x, a1.y, p12[1].x, p12[1].y);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p34[0].x, p34[0].y);
    ctx.quadraticCurveTo(a2.x, a2.y, p34[1].x, p34[1].y);
    ctx.fill();
    return true;
  }

  function LiquidLine(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.key = 0;
    this.raf = 0;
    this.last = 0;
    this.size = 0;
    this.dpr = 0;
    this.dots = [];
    this.measure();
  }

  LiquidLine.prototype.measure = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(24, Math.round(rect.width || 36));
    var h = Math.max(12, Math.round(rect.height || 22));
    var dpr = window.devicePixelRatio || 1;
    if (this.size === w + 'x' + h && this.dpr === dpr) { return; }
    this.size = w + 'x' + h;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var r = w * LIQ_RADIUS_RATIO;
    var n = LIQ_DOTS;
    var inter = (w - 2 * r * n) / (n + 1);
    this.r = r;
    this.inter = inter;
    // 游走圆在最后一个点右边 inter 处折返
    this.travelMax = (inter + r + (n - 1) * (inter + 2 * r)) + r + inter;
    this.midY = h / 2;
    this.dots = [];
    for (var i = 0; i < n; i++) {
      this.dots.push({ x: inter + r + i * (inter + 2 * r), y: this.midY });
    }
  };

  /// sin(key·π)·0.5+0.5：往返时两端会慢下来，不是匀速直冲
  function liqSine(key) {
    return Math.sin(key * Math.PI) * 0.5 + 0.5;
  }

  LiquidLine.prototype.draw = function () {
    var ctx = this.ctx;
    var w = this.w;
    var h = this.h;
    var r = this.r;
    var thresh = r * LIQ_THRESH;
    var moveR = r * LIQ_MOVE_SCALE;

    ctx.clearRect(0, 0, w, h);

    var move = { x: this.travelMax * liqSine(this.key), y: this.midY };

    // resize()：离游走圆越近放大越多
    var radii = [];
    var i, d, norm, rr;
    for (i = 0; i < this.dots.length; i++) {
      d = liqDist(this.dots[i], move);
      norm = 1 - d / (r + this.inter);
      rr = r;
      if (norm > 0) { rr = r + (r * LIQ_SCALE_MAX - r) * norm; }
      radii.push(rr);
    }

    // 普通点：白色但压一点透明度，衬得游走圆更亮
    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    // 先画桥（和点同色），再画点，边缘才干净
    for (i = 0; i < this.dots.length; i++) {
      liqBridge(ctx, move, moveR, this.dots[i], radii[i], thresh);
    }
    for (i = 0; i < this.dots.length; i++) {
      ctx.beginPath();
      ctx.arc(this.dots[i].x, this.dots[i].y, radii[i], 0, Math.PI * 2);
      ctx.fill();
    }

    // 游走圆：高亮 + 光晕。原库用一个更亮的 growColor 加阴影，这里等价
    ctx.save();
    var glow = ctx.createRadialGradient(move.x, move.y, moveR * 0.5, move.x, move.y, moveR * 2.5);
    glow.addColorStop(0, 'rgba(255,255,255,0.5)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(move.x, move.y, moveR * 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(move.x, move.y, moveR, 0, Math.PI * 2);
    ctx.fill();

    // 游走圆和相邻点之间的那截桥要重新按高亮色画一遍，
    // 否则它留在上面那层的半透明配色里，看起来是断的
    ctx.fillStyle = '#fff';
    for (i = 0; i < this.dots.length; i++) {
      if (liqDist(move, this.dots[i]) - moveR - radii[i] < thresh * 0.9) {
        liqBridge(ctx, move, moveR, this.dots[i], radii[i], thresh);
      }
    }
  };

  LiquidLine.prototype.start = function () {
    if (this.raf) { return; }
    this.measure();
    this.last = 0;
    var self = this;
    var step = function (ts) {
      if (!self.last) { self.last = ts; }
      var dt = Math.min(0.1, (ts - self.last) / 1000);
      self.last = ts;
      self.key += dt * 2 / LIQ_DURATION;
      if (self.key > 2) { self.key -= 2; }
      self.draw();
      self.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  LiquidLine.prototype.stop = function () {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.key = 0;
    if (this.ctx && this.w) {
      this.ctx.clearRect(0, 0, this.w, this.h);
    }
  };

  var liquidLine = null;

  function startLiquidLine() {
    // 进度每秒推好几次，这里必须早退，否则每帧都去量尺寸
    if (liquidLine && liquidLine.raf) { return; }
    var canvas = document.getElementById('tb-ring');
    if (!canvas) { return; }
    if (!liquidLine) { liquidLine = new LiquidLine(canvas); }
    liquidLine.start();
  }

  function stopLiquidLine() {
    if (liquidLine) { liquidLine.stop(); }
  }

  function updateDownloadButton() {
    var btn = document.getElementById('btn-refresh');
    var fill = document.getElementById('tb-progress-fill');
    var text = document.getElementById('tb-progress-text');
    if (!btn || !fill || !text) { return; }

    // 失败的任务会留在列表里让用户看原因，但它不算「在下载」——
    // 否则按钮会一直转圈，看着像还在跑
    var ids = Object.keys(dlTasks).filter(function (id) {
      return !dlTasks[id].error;
    });
    if (!ids.length) {
      btn.classList.remove('busy', 'indeterminate');
      fill.style.width = '0%';
      text.textContent = tr('下载');
      btn.title = tr('下载任务');
      stopLiquidLine();
      return;
    }

    // 挑进度最高的；都没量化进度就随便挑一个，走不确定动画
    var best = null;
    for (var i = 0; i < ids.length; i++) {
      var t = dlTasks[ids[i]];
      if (t.percent < 0) { continue; }
      if (!best || t.percent > best.percent) { best = t; }
    }

    btn.classList.add('busy');
    startLiquidLine();
    if (!best) {
      btn.classList.add('indeterminate');
      fill.style.width = '40%';
      text.textContent = tr('下载中');
      btn.title = (dlTasks[ids[0]].stage || '正在下载');
      return;
    }

    btn.classList.remove('indeterminate');
    var pct = Math.max(0, Math.min(100, Math.round(best.percent * 100)));
    fill.style.width = pct + '%';
    text.textContent = pct + '%';
    btn.title = best.stage || '正在下载';
  }

  /// 一行「三点 + 文字」的加载提示，给各处 empty 占位用。
  /// 纯文字太干，加个液滴在动的感觉就不像卡住了。
  /// 加载占位：一块在容器里**正中**的 gooey 动画 + 文案。
  ///
  /// 以前是 .loading-inline（inline-flex），塞进 grid / list 里就贴在左上角，
  /// 看着像角落里一个残留的提示。现在统一成一个块级居中块：
  /// grid 里跨所有列，普通容器里撑到 42vh 再居中，视觉上落在内容区中央。
  function loadingRow(text) {
    var box = el('div', 'loading-block');
    var dots = el('div', 'gooey');
    dots.appendChild(document.createElement('i'));
    dots.appendChild(document.createElement('i'));
    dots.appendChild(document.createElement('i'));
    box.appendChild(dots);
    box.appendChild(el('span', 'loading-text', text));
    return box;
  }

  /// 下载任务小窗。顶栏那个按钮点开就是它。
  ///
  /// 之前有两个毛病，一起改了：
  /// 1. 有任务时点不开列表——每来一次进度就整块 innerHTML 重建，
  ///    用户的点击刚好落在被替换掉的节点上就白点了。现在改成按 id 增量更新，
  ///    DOM 节点常驻，进度只改宽度和文字。
  /// 2. 打开时没有任何过渡，硬切出来。现在带一段弹出动画。
  var dlPopoverOpen = false;
  var dlPopoverRows = {};   // taskId -> {row, title, pct, fill, foot, bar}

  /// 一行下载任务。
  ///
  /// 版式是「标题 + 百分比」一行、进度条一行、状态文案一行：
  /// 百分比必须在**进度条右上角**（用户明确要求），所以它和标题同一行，
  /// 靠右对齐；进度条通栏，看上去百分比就压在条的右上角。
  function buildDownloadRow(id) {
    var node = el('div', 'dl-task');
    var head = el('div', 'dlt-head');
    var title = el('span', 'dlt-title', id);
    var pct = el('span', 'dlt-pct', '');
    head.appendChild(title);
    head.appendChild(pct);
    node.appendChild(head);

    var bar = el('div', 'dlt-bar');
    var fill = el('i', 'dlt-fill');
    bar.appendChild(fill);
    node.appendChild(bar);

    var foot = el('div', 'dlt-foot', '');
    node.appendChild(foot);

    return { row: node, title: title, pct: pct, fill: fill, foot: foot, bar: bar };
  }

  function renderDownloadPopover() {
    var list = document.getElementById('dl-popover-list');
    if (!list) { return; }

    var ids = Object.keys(dlTasks);

    if (!ids.length) {
      list.innerHTML = '';
      dlPopoverRows = {};
      list.appendChild(el('div', 'empty', '没有正在进行的下载任务'));
      return;
    }

    var placeholder = list.querySelector('.empty');
    if (placeholder) { placeholder.remove(); }

    ids.forEach(function (id) {
      var t = dlTasks[id];
      var row = dlPopoverRows[id];
      if (!row) {
        row = buildDownloadRow(id);
        list.appendChild(row.row);
        dlPopoverRows[id] = row;
      }

      // 标题优先用后端给的文件名（pushTitle），没有才退回任务 id
      row.title.textContent = t.title || id;
      row.title.title = t.title || id;

      if (t.error) {
        // 已经结束了，暂停/取消都没意义，只留「移除这条」。
        // 光设 hidden 不够：这些按钮是 flex 项，display 会被布局重新算出来
        if (row.cancel) { row.cancel.hidden = true; row.cancel.style.display = 'none'; }
        if (row.pause) { row.pause.hidden = true; row.pause.style.display = 'none'; }
        row.row.classList.add('failed');
        row.pct.textContent = '';
        row.pct.hidden = true;
        row.bar.hidden = true;
        row.foot.textContent = t.error;
        row.foot.classList.add('dlt-err');
        // 失败的任务不自动消失：用户得能看到到底为什么失败
        if (!row.close) {
          var close = el('button', 'dlt-close', '✕');
          close.title = tr('移除这条任务');
          close.addEventListener('click', function (e) {
            e.stopPropagation();
            delete dlTasks[id];
            renderDownloadPopover();
            updateDownloadButton();
          });
          row.row.querySelector('.dlt-head').appendChild(close);
          row.close = close;
        }
        return;
      }

      // Java 下载可以暂停：后端是自己写的断点下载，已下好的部分留在 .part 里，
      // 继续时带 Range 从断点接上。其它任务（版本 / 整合包）走 FileDownloadTask，
      // 写临时文件、取消即删，没有续传可言，所以不给暂停按钮。
      // 解压阶段没法暂停（已经下完了，剩下是本地解压），按钮收掉
      var canPause = t.kind === 'java' && (t.stage || '').indexOf('解压') !== 0;
      if (canPause && !row.pause) {
        var pauseBtn = el('button', 'dlt-close dlt-pause', '⏸');
        pauseBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var paused = dlTasks[id] && dlTasks[id].paused;
          if (paused) {
            call('resumeJavaDownload', id);
          } else {
            call('pauseJavaDownload', id);
          }
        });
        var head = row.row.querySelector('.dlt-head');
        head.insertBefore(pauseBtn, row.cancel || null);
        row.pause = pauseBtn;
      }
      if (row.pause) {
        row.pause.hidden = !canPause;
        row.pause.style.display = canPause ? '' : 'none';
        if (canPause) {
          row.pause.textContent = t.paused ? '▶' : '⏸';
          row.pause.title = t.paused ? '继续下载' : '暂停下载';
        }
      }

      // 运行中给一个 ✕：下载/安装中途不想要了可以直接停掉。
      // 后端 executor.cancel() 会把任务停掉并推一条 done=cancelled。
      if (!row.cancel) {
        var cancelBtn = el('button', 'dlt-close dlt-cancel', '✕');
        cancelBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          cancelBtn.disabled = true;
          cancelBtn.title = tr('正在取消…');
          call('cancelDownload', id);
        });
        row.row.querySelector('.dlt-head').appendChild(cancelBtn);
        row.cancel = cancelBtn;
      }
      row.cancel.hidden = false;
      row.cancel.style.display = '';
      if (!row.cancel.disabled) { row.cancel.title = tr('取消这个任务'); }

      var hasPct = t.percent >= 0;
      row.pct.hidden = false;
      row.bar.hidden = false;
      row.pct.textContent = hasPct ? Math.round(t.percent * 100) + '%' : '';
      row.bar.classList.toggle('indeterminate', !hasPct);
      row.fill.style.width = (hasPct ? Math.max(3, Math.round(t.percent * 100)) : 100) + '%';
      row.foot.textContent = t.stage || '';
      row.foot.classList.toggle('dlt-paused', !!t.paused);
    });

    // 已经结束的任务把行删掉
    Object.keys(dlPopoverRows).forEach(function (id) {
      if (dlTasks[id]) { return; }
      var row = dlPopoverRows[id];
      if (row && row.row.parentNode) { row.row.parentNode.removeChild(row.row); }
      delete dlPopoverRows[id];
    });
  }

  /// 开/关小窗。状态自己记，不靠读 class——读 class 在连点时会和 CSS 打架。
  function setDownloadPopover(open) {
    var pop = document.getElementById('dl-popover');
    if (!pop) { return; }
    dlPopoverOpen = !!open;
    if (dlPopoverOpen) {
      renderDownloadPopover();
      pop.classList.remove('hidden');
      // 重启动画：先摘 class、强制回流、再挂上
      pop.classList.remove('pop-in');
      void pop.offsetWidth;
      pop.classList.add('pop-in');
    } else {
      pop.classList.add('hidden');
    }
  }

  function toggleDownloadPopover(force) {
    setDownloadPopover(force === undefined ? !dlPopoverOpen : !!force);
  }

  /// 后台把外观页的数据先拉一遍。
  ///
  /// 外观页是整个启动器里最重的一页：要拉皮肤库、每张皮肤的原图（base64），
  /// 还要初始化 WebGL。用户点进去再开始拉，会先看到一段空白。
  /// 首页画完之后就偷偷发一次请求，数据先到 onAppearance 里躺着。
  function preloadAppearanceData() {
    setTimeout(function () {
      try { call('requestAppearance'); } catch (e) { /* 预取失败无所谓，进页面会再拉 */ }
    }, 1200);
  }

  // ---------------- 实例管理页 ----------------
  //
  // 对照 HMCL 的 `ui/instances/GameInstancePage.java`：顶部一条实例信息带
  // （图标 / 名字 / 版本 / 启动 / 打开目录），下面按标签分「设置 / 加载器 / 内容」。
  // 设置项全部走实例级 GameSettings，第一次改动就脱离全局继承——和 HMCL
  // 的「独立设置」语义一致，所以这里既显示继承提示，也提供写入口。

  var instId = '';
  var instData = null;
  var instTab = 'settings';
  var instContentKind = 'mod';

  /// 内容列表的搜索 / 排序 / 批量状态。
  /// 只对模组、资源包、光影生效 —— 世界和截图走另外两条渲染路径。
  var instQuery = '';
  var instSort = 'name';
  var instBatch = false;
  var instSelected = {};
  /// 最近一次的原始列表。搜索和排序都在这份数据上重算，
  /// 不必为了敲一个字母再请求一次后端。
  var instItemsCache = [];

  /// patch id → 显示名。GameComponentType 里的 patch id 是 `fabric-api` 这种，
  /// 直接摆给用户看不合适。
  var INST_LOADER_NAMES = {
    forge: 'Forge',
    neoforge: 'NeoForge',
    fabric: 'Fabric',
    quilt: 'Quilt',
    liteloader: 'LiteLoader',
    optifine: 'OptiFine',
    cleanroom: 'Cleanroom',
    legacyfabric: 'Legacy Fabric',
    'fabric-api': 'Fabric API',
    'quilt-api': 'QSL / QFAPI',
    'legacyfabric-api': 'Legacy Fabric API'
  };

  var INST_KIND_NAMES = {
    mod: '模组',
    resourcepack: '资源包',
    shader: '光影',
    world: '世界',
    // 截图（screenshots/）是只看不改的目录，不参与加载
    screenshot: '截图'
  };

  var INST_EMPTY = {
    mod: '这个实例还没有装模组。去「下载 → 模组」挑几个，下载时会自动放进这里。',
    resourcepack: '还没有资源包。去「下载 → 资源包」看看。',
    shader: '还没有光影。去「下载 → 光影」看看。',
    world: '还没有存档。去「下载 → 世界」下载，或者把已有的存档目录拷进 saves。',
    screenshot: '还没有截图。游戏里按 F2 截的图会放进 screenshots。'
  };

  /// 内容分类对应的子目录名（打开文件夹用）
  var INST_SUB_DIR = {
    mod: 'mods',
    resourcepack: 'resourcepacks',
    shader: 'shaderpacks',
    world: 'saves',
    screenshot: 'screenshots'
  };

  /// 实例详情和每个内容标签的数据都缓存一份。
  ///
  /// 以前每次点进实例：详情拉一次、每个内容标签再拉一次，全程对着「正在读取…」。
  /// 这些数据在两次打开之间几乎不变，缓存下来先铺上、后台再静默刷一遍，
  /// 切实例才是秒开，而不是「打开一次刷新一次」。
  var instDetailCache = {};
  var instContentCache = {};

  function showInstancePage(id) {
    if (!id) { return; }
    instId = id;
    instContentKind = 'mod';

    // 头部先用列表里已有的数据填一遍，别等接口回来才显示（会闪一下空白）
    var cached = ((state && state.instances) || []).filter(function (x) { return x.id === id; })[0];
    renderInstanceHero(cached);

    // 详情有缓存就立刻铺上去：不清空、不闪白，接口回来再覆盖
    var memo = instDetailCache[id];
    if (memo) {
      instData = memo;
      renderInstanceDetail(memo);
    } else {
      instData = null;
      clearInstanceDetail();
    }

    setInstTab('settings');
    go('instance');
    loadInstanceDetail();
    // 主题：先把上一个实例的强调色/背景清掉，再异步拉这个实例的
    resetInstanceTheme();
    loadInstanceTheme(false);
    // 崩溃报告和详情并行查：这条只影响顶部提示条，不挡内容渲染
    checkInstanceCrash();
  }

  function loadInstanceDetail() {
    if (!instId) { return; }
    renderInstUpdateBar();
    apiCall('instanceDetail', [instId]).then(function (raw) {
      var data = asJson(raw);
      if (!data || !instId) { return; }
      // 迟到的响应（用户已经切到别的实例）直接丢掉
      if (data.id && data.id !== instId) { return; }
      if (data.error) {
        toast(data.error, 'error');
        return;
      }
      instData = data;
      instDetailCache[data.id] = data;
      renderInstanceDetail(data);
    });
  }

  function renderInstanceHero(inst) {
    var box = document.getElementById('inst-hero');
    var icon = document.getElementById('inst-icon');
    var title = document.getElementById('inst-title');
    var sub = document.getElementById('inst-sub');
    if (!icon || !title) { return; }

    var name = (inst && inst.name) || '实例';
    title.textContent = name;
    title.title = name;

    var line = [];
    if (inst && inst.gameVersion) { line.push(inst.gameVersion); }
    if (inst && inst.loader) {
      line.push(inst.loader + (inst.loaderVersion ? ' ' + inst.loaderVersion : ''));
    }
    if (sub) { sub.textContent = line.join(' · '); }

    // 图标复用列表那套（没有图标时首字母 + 渐变兜底），直接换掉节点
    if (inst) {
      var fresh = iconNode(inst, 'inst-icon-lg');
      fresh.id = 'inst-icon';
      icon.parentNode.replaceChild(fresh, icon);
    }
  }

  function renderInstanceDetail(d) {
    var inst = ((state && state.instances) || []).filter(function (x) { return x.id === d.id; })[0] || d;
    renderInstanceHero(inst);

    setText('inst-version', d.gameVersion || '-');
    setText('inst-loader', (d.loader || '原版') + (d.loaderVersion ? ' ' + d.loaderVersion : ''));
    setText('inst-dir', d.directory || '-');
    var dirEl = document.getElementById('inst-dir');
    if (dirEl) { dirEl.title = d.directory || ''; }

    // 继承提示：这个实例还没写过自己的设置
    var hint = document.getElementById('inst-inherit-hint');
    if (hint) { hint.hidden = !!d.customSettings; }

    var g = d.game || {};
    setCheck('inst-auto-memory', g.autoMemory);
    renderMemoryMeter('inst-', g.maxMemory || 0, g.minMemory || 0, {
      total: g.totalMemory,
      used: g.usedMemory,
      available: g.availableMemory
    }, !!g.autoMemory);

    setValue('inst-jvm', g.jvmOptions || '');
    setValue('inst-game-args', g.gameArguments || '');

    var wt = document.getElementById('inst-window-type');
    if (wt) { wt.value = g.windowType || 'windowed'; }
    setValue('inst-width', g.width || '');
    setValue('inst-height', g.height || '');
    var sizeRow = document.getElementById('inst-row-size');
    if (sizeRow) { sizeRow.hidden = (g.windowType || 'windowed') !== 'windowed'; }

    // ---- Java / 启动 / 检查（对照 GameSettingsPage 的 game + launcher 分组） ----
    var jt = document.getElementById('inst-java-type');
    if (jt) { jt.value = g.javaType || 'auto'; }
    setValue('inst-java-path', g.customJavaPath || '');
    var jpRow = document.getElementById('inst-row-java-path');
    if (jpRow) { jpRow.hidden = (g.javaType || 'auto') !== 'custom'; }

    setValue('inst-running-dir', g.runningDirectory || '');
    var prio = document.getElementById('inst-priority');
    if (prio) { prio.value = g.processPriority || 'normal'; }
    var vis = document.getElementById('inst-launcher-visibility');
    if (vis) { vis.value = g.launcherVisibility || 'hide'; }

    var qp = document.getElementById('inst-quick-play');
    if (qp) { qp.value = g.quickPlay || 'none'; }
    // 存档名是下拉：选项来自这个实例的 saves/ 目录（目录名才是 --quickPlaySingleplayer 要的值）
    loadQuickPlaySaves(g.quickPlaySingleplayer || '');
    setValue('inst-quick-mp', g.quickPlayMultiplayer || '');
    var spRow = document.getElementById('inst-row-quick-sp');
    var mpRow = document.getElementById('inst-row-quick-mp');
    if (spRow) { spRow.hidden = (g.quickPlay || 'none') !== 'singleplayer'; }
    if (mpRow) { mpRow.hidden = (g.quickPlay || 'none') !== 'multiplayer'; }

    setCheck('inst-not-check-jvm', g.notCheckJVM);
    setCheck('inst-not-check-game', g.notCheckGame);
    setCheck('inst-not-use-javaw', g.notUseJavaw);
    setCheck('inst-no-jvm-options', g.noJVMOptions);
    setCheck('inst-no-opt-jvm-options', g.noOptimizingJVMOptions);
    setCheck('inst-allow-auto-agent', g.allowAutoAgent);
    setCheck('inst-disable-auto-game-options', g.disableAutoGameOptions);

    renderInstTabCounts(d.counts || {});

    // 当前停在内容标签页时，数据变了要重载那一页（比如删完文件）
    if (instTab === 'installers') { loadInstInstallers(); }
  }

  function renderInstTabCounts(counts) {
    var nav = document.getElementById('inst-nav');
    if (!nav) { return; }
    var buttons = nav.querySelectorAll('button[data-itab]');
    for (var i = 0; i < buttons.length; i++) {
      var tab = buttons[i].getAttribute('data-itab');
      var label = buttons[i].getAttribute('data-label');
      if (!label) {
        label = buttons[i].textContent.replace(/\s*\(\d+\)$/, '');
        buttons[i].setAttribute('data-label', label);
      }
      var n = counts[tab];
      buttons[i].textContent = (typeof n === 'number' && n > 0) ? (label + ' (' + n + ')') : label;
    }
  }

  function clearInstanceDetail() {
    setText('inst-version', '');
    setText('inst-loader', '');
    setText('inst-dir', '');
    var lists = ['inst-installer-list', 'inst-content-list'];
    lists.forEach(function (id) {
      var box = document.getElementById(id);
      if (box) { box.innerHTML = ''; }
    });
  }

  /// 切实例标签页。
  ///
  /// 顺序很重要：**先把内容准备好，再切面板**。
  /// 反过来（先亮面板、再塞内容）面板会先显示上一个标签留下的列表或空块，
  /// 下一帧才被替换 —— 那一下就是用户看到的闪白。
  function setInstTab(tab) {
    instTab = tab;
    var nav = document.getElementById('inst-nav');
    if (nav) {
      var buttons = nav.querySelectorAll('button[data-itab]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('on', buttons[i].getAttribute('data-itab') === tab);
      }
    }

    var isContent = INST_KIND_NAMES[tab] != null;
    var settings = document.getElementById('itab-settings');
    var themePanel = document.getElementById('itab-theme');
    var installers = document.getElementById('itab-installers');
    var content = document.getElementById('itab-content');

    // 内容先就位。内容列表走缓存优先：切回来是同步铺好的，
    // 不会出现「正在读取…」再被替换的情况。
    if (isContent) {
      instContentKind = tab;
      var title = document.getElementById('inst-content-title');
      if (title) { title.textContent = INST_KIND_NAMES[tab]; }
      if (tab === 'world') {
        loadInstWorlds();
      } else if (tab === 'screenshot') {
        loadInstScreenshots();
      } else {
        loadInstContent(tab);
      }
    } else if (tab === 'installers') {
      loadInstInstallers();
    } else if (tab === 'theme') {
      loadInstanceTheme(true);
      // 主题面板的说明条也要立刻对齐，别等接口回来才出现
      if (typeof syncThemeOwnerHint === 'function') { syncThemeOwnerHint(); }
    }

    // 内容已经在了，这时候才让面板可见，中间不会露出空白
    if (settings) { settings.hidden = tab !== 'settings'; }
    if (themePanel) { themePanel.hidden = tab !== 'theme'; }
    if (installers) { installers.hidden = tab !== 'installers'; }
    if (content) { content.hidden = !isContent; }

    // 附加动作放在最后：它们只更新标题栏上的按钮和依赖检查，不碰列表
    if (tab === 'mod') {
      scanInstanceMods();
    } else {
      // 依赖横幅说的是模组的事，切到资源包 / 光影还挂着就是张冠李戴。
      // 它也占着内容面板顶部，不收掉的话每次切标签都要先看一遍别人的警告。
      var scanBar = document.getElementById('inst-scan-bar');
      if (scanBar) { scanBar.hidden = true; }
    }
    if (tab === 'world' || tab === 'screenshot') {
      syncInstTools(0);
    } else if (isContent) {
      syncInstTools(instItemsCache.length);
    }
  }

  function loadInstInstallers() {
    var box = document.getElementById('inst-installer-list');
    if (!box || !instId) { return; }
    // 清空但不放「正在读取…」：切标签时那一大块提示会连闪两下，
    // 而本地接口本来就快，留空白更安静
    box.innerHTML = '';

    apiCall('instanceInstallers', [instId]).then(function (raw) {
      var data = asJson(raw);
      if (instTab !== 'installers') { return; }
      box.innerHTML = '';
      if (!data || data.error) {
        box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
        return;
      }
      var items = data.installed || [];
      if (!items.length) {
        box.appendChild(el('div', 'inst-empty', '这是原版实例，没有装任何加载器。'));
        return;
      }
      items.forEach(function (it) {
        var row = el('div', 'inst-item');
        var main = el('div', 'inst-item-main');
        var line = el('div', 'inst-item-title');
        line.appendChild(el('span', null, INST_LOADER_NAMES[it.id] || it.id));
        if (it.version) { line.appendChild(el('span', 'inst-tag', it.version)); }
        main.appendChild(line);
        main.appendChild(el('div', 'inst-item-sub', it.id));
        row.appendChild(main);

        var acts = el('div', 'inst-item-acts');
        var rebuild = el('button', 'btn ghost small', '更换');
        rebuild.addEventListener('click', function () {
          openLoaderModal((instData && instData.gameVersion) || '', instId);
        });
        acts.appendChild(rebuild);
        row.appendChild(acts);
        box.appendChild(row);
      });
    });
  }

  // ---------------- 世界（存档） ----------------

  /// 快速游玩的存档下拉：值必须是 saves 下的**目录名**（传给游戏的是这个），
  /// 显示名用存档里的 LevelName，两者不一样时两个都写出来。
  ///
  /// 这个下拉每次实例设置重渲染都会被刷一遍（改设置 → 后端保存 → 回推状态 → 再渲染）。
  /// 原来是先 `innerHTML = ''` 再等接口填：中间有一帧是空的，看起来就是一直闪；
  /// 末尾还无条件 dispatch 一个 change，又触发一次写设置，自己喂自己。
  /// 现在先在内存里把选项算好，跟当前内容一致就一个节点都不碰；只有「选中的存档
  /// 已经不在了」才写回设置（否则日常渲染不产生任何写入）。
  var quickSavesCache = { inst: null, sig: '' };

  function loadQuickPlaySaves(current) {
    var sel = document.getElementById('inst-quick-sp');
    if (!sel || !instId) { return; }
    var want = instId;
    if (quickSavesCache.inst !== want) {
      // 换实例：先清掉上一个实例的存档，别张冠李戴
      sel.innerHTML = '';
      quickSavesCache.inst = want;
      quickSavesCache.sig = '';
    }

    apiCall('instanceWorlds', [want]).then(function (raw) {
      var s = document.getElementById('inst-quick-sp');
      if (!s || !instId || instId !== want) { return; }
      var data = asJson(raw);
      var worlds = (data && data.worlds) || [];
      var items = [];
      var missing = false;
      if (!worlds.length) {
        items.push({ v: '', t: (data && data.error) ? '读取失败' : '还没有存档', disabled: true, selected: true });
      } else {
        worlds.forEach(function (w) {
          items.push({
            v: w.file,
            t: (w.name && w.name !== w.file) ? (w.name + '  (' + w.file + ')') : w.file,
            selected: w.file === current
          });
        });
        // 存着的存档可能已经被删了：补一项，否则下拉会默默变成第一项
        if (current && !worlds.some(function (w) { return w.file === current; })) {
          items.push({ v: current, t: current + tr('  (已不存在)'), selected: true });
          missing = true;
        }
      }

      var sig = want + '|' + current + '|' + JSON.stringify(items);
      if (sig === quickSavesCache.sig) { return; }  // 内容没变：不重画，也就不会闪
      quickSavesCache.sig = sig;

      var frag = document.createDocumentFragment();
      items.forEach(function (it) {
        var opt = el('option', null, it.t);
        opt.value = it.v;
        if (it.disabled) { opt.disabled = true; }
        if (it.selected) { opt.selected = true; }
        frag.appendChild(opt);
      });
      s.innerHTML = '';
      s.appendChild(frag);

      // 只有回退到「已不存在」这一项时才需要写回：其余情况一次都不写
      if (missing) { s.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }

  function loadInstWorlds() {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    var key = instId + '|world';
    var memo = instContentCache[key];
    if (memo) {
      renderInstWorlds(memo);
    } else {
      // 清空但不插「正在读取存档…」：本地目录列举很快，
      // 那块提示只会让人看到「加载中 → 列表」两次重排
      box.innerHTML = '';
    }
    apiCall('instanceWorlds', [instId]).then(function (raw) {
      if (instTab !== 'world') { return; }
      var data = asJson(raw);
      if (data && !data.error) {
        instContentCache[key] = data;
        // 存档没变就别重排：重排会把滚动位置和存档图标全掀掉
        if (memo && JSON.stringify(memo) === JSON.stringify(data)) { return; }
      }
      renderInstWorlds(data);
    });
  }

  function renderInstWorlds(data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';
    if (!data || data.error) {
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    var worlds = data.worlds || [];
    if (!worlds.length) {
      box.appendChild(el('div', 'inst-empty',
        '还没有存档。去「下载 → 世界」下载，或者把已有的存档目录拷进 saves。'));
      return;
    }

    worlds.forEach(function (w) {
      var row = el('div', 'world-item');

      var icon = document.createElement('img');
      icon.className = 'world-icon';
      if (w.icon) { icon.src = w.icon; } else { icon.classList.add('none'); }
      row.appendChild(icon);

      var main = el('div', 'world-main');
      main.appendChild(el('div', 'world-title', w.name || w.file));
      var sub = [];
      if (w.version) { sub.push(w.version); }
      sub.push(w.lastPlayed ? (tr('最后游玩 ') + fmtTime(w.lastPlayed)) : '还没进过');
      if (w.backups) { sub.push(w.backups + tr(' 个备份')); }
      if (w.locked) { sub.push('运行中'); }
      main.appendChild(el('div', 'world-sub', sub.join(' · ')));
      row.appendChild(main);

      var acts = el('div', 'world-acts');
      function act(label, title, handler) {
        var button = el('button', 'btn ghost small', label);
        if (title) { button.title = title; }
        button.addEventListener('click', function (e) {
          e.stopPropagation();
          handler(button);
        });
        acts.appendChild(button);
      }

      act('打开目录', '在资源管理器里打开这个存档', function () {
        apiCall('worldAction', [instId, 'open', w.file, '']).then(function (raw) {
          var r = asJson(raw);
          if (r && r.error) { toast(r.error, 'error'); }
        });
      });
      act('备份', tr('打包到 backups/') + w.file + '/', function (button) {
        button.disabled = true;
        apiCall('worldAction', [instId, 'backup', w.file, '']).then(function (raw) {
          var r = asJson(raw);
          button.disabled = false;
          if (r && r.error) { toast(r.error, 'error'); }
          else { toast(tr('已备份：') + ((r && r.file) || ''), 'ok'); }
          loadInstWorlds();
        });
      });
      act('导出…', '打包成 zip 存到你自己选的位置，可以发给别人', function () {
        exportWorldZip(w);
      });
      act('重命名', '同时改目录名和存档内显示名', function () {
        askName('新的存档名', w.name || w.file).then(function (name) {
          if (!name) { return; }
          apiCall('worldAction', [instId, 'rename', w.file, name]).then(function (raw) {
            var r = asJson(raw);
            if (r && r.error) { toast(r.error, 'error'); } else { toast('已重命名', 'ok'); }
            loadInstWorlds();
          });
        });
      });
      act('删除', '移到系统回收站', function () {
        askConfirm(tf('把存档「{0}」移到回收站？', w.name || w.file)).then(function (yes) {
          if (!yes) { return; }
          apiCall('worldAction', [instId, 'delete', w.file, '']).then(function (raw) {
            var r = asJson(raw);
            if (r && r.error) { toast(r.error, 'error'); } else { toast('已移到回收站', 'ok'); }
            loadInstWorlds();
          });
        });
      });

      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  // ---------------- 截图 ----------------

  function loadInstScreenshots() {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    var key = instId + '|screenshot';
    var memo = instContentCache[key];
    if (memo) {
      renderInstScreenshots(memo);
    } else {
      // 同上：截图是本地目录列举，不值得为它先画一遍加载块
      box.innerHTML = '';
    }
    apiCall('instanceScreenshots', [instId]).then(function (raw) {
      if (instTab !== 'screenshot') { return; }
      var data = asJson(raw);
      if (data && !data.error) {
        instContentCache[key] = data;
        // 截图没增没删就不重排，重排会让每张图重新解码一次
        if (memo && JSON.stringify(memo) === JSON.stringify(data)) { return; }
      }
      renderInstScreenshots(data);
    });
  }

  function screenshotAction(action, file, arg, done) {
    apiCall('screenshotAction', [instId, action, file, arg || '']).then(function (raw) {
      var r = asJson(raw);
      if (r && r.error) { toast(r.error, 'error'); }
      else if (done) { done(r); }
    });
  }

  function renderInstScreenshots(data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';
    if (!data || data.error) {
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    var items = data.items || [];
    if (!items.length) {
      box.appendChild(el('div', 'inst-empty', '还没有截图。游戏里按 F2 就会存到这里。'));
      return;
    }

    var grid = el('div', 'shot-grid');
    items.forEach(function (shot) {
      var card = el('div', 'shot-card');
      card.title = shot.file + tr('\n双击用系统默认程序打开，右键更多操作');

      var img = document.createElement('img');
      img.className = 'shot-thumb';
      img.loading = 'lazy';
      if (shot.thumb) { img.src = shot.thumb; } else { img.classList.add('none'); }
      card.appendChild(img);

      var bar = el('div', 'shot-bar');
      bar.appendChild(el('div', 'shot-name', shot.file));
      bar.appendChild(el('div', 'shot-meta', fmtSize(shot.size || 0) + ' · ' + fmtTime(shot.time)));
      card.appendChild(bar);

      card.addEventListener('dblclick', function () {
        screenshotAction('open', shot.file);
      });
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: '复制图片',
            action: function () {
              screenshotAction('copy', shot.file, '', function () { toast('已复制到剪贴板', 'ok'); });
            }
          },
          {
            label: '重命名',
            action: function () {
              askName('新的文件名', shot.file).then(function (name) {
                if (!name) { return; }
                screenshotAction('rename', shot.file, name, function () {
                  toast('已重命名', 'ok');
                  loadInstScreenshots();
                });
              });
            }
          },
          {
            label: '删除',
            danger: true,
            action: function () {
              askConfirm(tf('删除截图「{0}」？（移到回收站）', shot.file)).then(function (yes) {
                if (!yes) { return; }
                screenshotAction('delete', shot.file, '', function () {
                  toast('已移到回收站', 'ok');
                  loadInstScreenshots();
                });
              });
            }
          }
        ]);
      });

      grid.appendChild(card);
    });
    box.appendChild(grid);
  }

  // ---------------- 已装资源更新 ----------------
  //
  // 本地文件没有「我是哪个项目的哪一版」的元数据，后端按文件指纹去
  // Modrinth / CurseForge 反查。查完弹窗列出来，可以勾选更新。

  var updData = null;       // 最近一次检查结果
  var updPicked = {};       // fileName -> true
  var updLoading = false;
  var updTimeout = null;

  function checkAddonUpdates(btn) {
    if (!instId || updLoading) { return; }
    updLoading = true;
    if (btn) { btn.disabled = true; }
    toast(tr('正在核对文件指纹，模组多的话要十几秒'));
    call('addonUpdateCheck', instId, '');
    // 正常情况后端一定会推结果；万一核心卡住，60 秒后把按钮放回来
    clearTimeout(updTimeout);
    updTimeout = setTimeout(function () {
      if (!updLoading) { return; }
      finishUpdateCheck();
      toast(tr('检查超时了，稍后再试'), 'error');
    }, 60000);
  }

  function finishUpdateCheck() {
    updLoading = false;
    clearTimeout(updTimeout);
    var btn = document.getElementById('inst-check-upd');
    if (btn) { btn.disabled = false; }
  }

  /// 检查结果弹窗：按类型分组，一行一个可更新项。
  function showUpdateModal(d) {
    updData = d;
    updPicked = {};
    var box = document.getElementById('upd-list');
    if (!box) { return; }
    box.innerHTML = '';
    var bar = document.getElementById('upd-bar');
    var items = d.items || [];
    var title = document.getElementById('upd-title');
    if (title) { title.textContent = tr('资源更新'); }

    if (!items.length) {
      bar.hidden = true;
      var empty = el('div', 'upd-empty');
      empty.appendChild(el('h4', null, '没有可更新的资源'));
      empty.appendChild(el('p', null,
        tf('检查了 {0} 个文件，其中 {1} 个能在 Modrinth / CurseForge 上认出来，都已经是最新版本。',
          d.checked || 0, d.matched || 0)));
      empty.appendChild(el('p', 'muted',
        '自己改过、从别处拷来、或者平台没收录的文件没法比对，属于正常情况。'));
      box.appendChild(empty);
      openModal('upd-modal');
      return;
    }

    bar.hidden = false;
    [
      { kind: 'mod', label: '模组' },
      { kind: 'resourcepack', label: '资源包' },
      { kind: 'shader', label: '光影' }
    ].forEach(function (g) {
      var list = items.filter(function (x) { return x.kind === g.kind; });
      if (!list.length) { return; }
      box.appendChild(el('div', 'upd-group', tf('{0}（{1}）', tr(g.label), list.length)));
      list.forEach(function (it) { box.appendChild(updateRow(it)); });
    });

    updateUpdBar();
    openModal('upd-modal');
  }

  function updateRow(it) {
    var row = el('div', 'upd-item');
    row.setAttribute('data-file', it.file);
    row.appendChild(el('span', 'upd-dot'));

    var icon = instItemIcon({ fileName: it.file, name: it.name }, it.kind);
    icon.classList.add('upd-icon');
    row.appendChild(icon);

    var main = el('div', 'upd-main');
    var name = el('div', 'upd-name');
    name.appendChild(document.createTextNode(it.name || it.file));
    name.appendChild(el('span', 'upd-tag src', it.source === 'curseforge' ? 'CurseForge' : 'Modrinth'));
    if (it.type && it.type !== 'release') { name.appendChild(el('span', 'upd-tag', it.type)); }
    main.appendChild(name);

    var ver = el('div', 'upd-ver');
    ver.appendChild(el('span', 'upd-old', it.currentVersion || '?'));
    ver.appendChild(el('span', 'upd-arrow', '→'));
    ver.appendChild(el('span', 'upd-new', it.latestVersion || '?'));
    main.appendChild(ver);
    row.appendChild(main);

    var btn = el('button', 'btn ghost small', '更新');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      doApplyUpdates([it], btn);
    });
    row.appendChild(btn);

    row.addEventListener('click', function () {
      if (updPicked[it.file]) {
        delete updPicked[it.file];
      } else {
        updPicked[it.file] = true;
      }
      row.classList.toggle('on', !!updPicked[it.file]);
      updateUpdBar();
    });
    return row;
  }

  function updateUpdBar() {
    var items = (updData && updData.items) || [];
    var picked = items.filter(function (x) { return updPicked[x.file]; });
    var sum = document.getElementById('upd-sum');
    if (sum) {
      sum.textContent = picked.length
        ? tf('已选 {0} / {1}', picked.length, items.length)
        : tf('共 {0} 项可更新', items.length);
    }
    var sel = document.getElementById('upd-btn-selected');
    if (sel) {
      sel.disabled = !picked.length;
      sel.textContent = picked.length ? tf('更新选中（{0}）', picked.length) : tr('更新选中');
    }
    var all = document.getElementById('upd-btn-all');
    if (all) { all.textContent = tf('全部更新（{0}）', items.length); }
    var toggle = document.getElementById('upd-check-all');
    if (toggle) {
      var allOn = items.length > 0 && picked.length === items.length;
      toggle.textContent = allOn ? tr('取消全选') : tr('全选');
    }
  }

  function togglePickAll() {
    var items = (updData && updData.items) || [];
    var allOn = items.length > 0 && items.every(function (x) { return updPicked[x.file]; });
    updPicked = {};
    if (!allOn) {
      items.forEach(function (x) { updPicked[x.file] = true; });
    }
    var rows = document.querySelectorAll('#upd-list .upd-item');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('on', !!updPicked[rows[i].getAttribute('data-file')]);
    }
    updateUpdBar();
  }

  function doApplyUpdates(items, btn) {
    if (!items || !items.length || !instId) { return; }
    var payload = items.map(function (x) {
      return {
        kind: x.kind,
        file: x.file,
        fileName: x.fileName,
        downloadUrl: x.downloadUrl,
        source: x.source,
        name: x.name
      };
    });
    if (btn) { btn.disabled = true; btn.textContent = tr('更新中…'); }
    call('addonUpdateApply', instId, JSON.stringify(payload));
    toast(tf('开始更新 {0} 个资源，进度看右上角', payload.length));
    closeModal('upd-modal');
  }

  // ---------------- 游戏文件完整性 ----------------
  //
  // 只查客户端 jar、libraries、assets 三类。缺什么补什么，存档/模组/配置不动。

  var integData = null;

  function checkGameIntegrity() {
    if (!instId) { return; }
    openModal('integ-modal');
    var box = document.getElementById('integ-content');
    if (!box) { return; }
    box.innerHTML = '';
    box.appendChild(loadingRow('正在检查游戏文件…'));
    var wanted = instId;
    apiCall('gameIntegrityScan', [wanted]).then(function (raw) {
      if (wanted !== instId) { return; }
      var d = asJson(raw);
      integData = d;
      renderIntegrity(d);
    });
  }

  function renderIntegrity(d) {
    var box = document.getElementById('integ-content');
    if (!box) { return; }
    box.innerHTML = '';

    if (!d || !d.ok) {
      box.appendChild(el('div', 'integ-error', (d && d.error) || '检查失败'));
      return;
    }

    var missing = d.missing || 0;
    var sum = el('div', 'integ-sum ' + (missing ? 'bad' : 'ok'));
    sum.appendChild(el('h4', null, missing ? tf('缺 {0} 个文件', missing) : '全部文件完整'));
    var sub = [];
    if (d.libraries) { sub.push(tf('库文件 {0} 个', d.libraries.total || 0)); }
    if (d.assets) { sub.push(tf('资源文件 {0} 个', d.assets.total || 0)); }
    sum.appendChild(el('p', null, missing
      ? tf('预计需要下载 {0}', fmtSize(d.downloadSize || 0)) + (sub.length ? '  ·  ' + sub.join(' · ') : '')
      : sub.join(' · ')));
    box.appendChild(sum);

    box.appendChild(integrityRow('客户端文件',
      !!(d.jar && d.jar.ok),
      d.jar && d.jar.ok
        ? (d.jar.file + (d.jar.size ? '  ·  ' + fmtSize(d.jar.size) : ''))
        : '缺失：' + ((d.jar && d.jar.file) || '客户端 jar')));
    box.appendChild(integrityRow('库文件',
      !d.libraries || !d.libraries.missing,
      tf('{0} 个，缺 {1} 个', (d.libraries && d.libraries.total) || 0, (d.libraries && d.libraries.missing) || 0),
      d.libraries && d.libraries.items));
    box.appendChild(integrityRow('资源文件',
      !d.assets || !d.assets.missing,
      d.assets && !d.assets.indexOk
        ? '资源索引缺失，需要重新下载'
        : tf('{0} 个，缺 {1} 个', (d.assets && d.assets.total) || 0, (d.assets && d.assets.missing) || 0),
      d.assets && d.assets.items));

    if (missing) {
      var acts = el('div', 'integ-acts');
      var btn = el('button', 'btn primary small', '修复缺失文件');
      btn.addEventListener('click', function () { fixGameIntegrity(btn); });
      acts.appendChild(btn);
      acts.appendChild(el('span', 'integ-hint', '只补缺失和损坏的文件，存档、模组、配置不动。逐个校验大实例可能要一两分钟。'));
      box.appendChild(acts);
    }
  }

  function integrityRow(title, ok, detail, items) {
    var row = el('div', 'integ-row ' + (ok ? 'ok' : 'bad'));
    row.appendChild(el('span', 'integ-dot'));
    var main = el('div', 'integ-main');

    var head = el('div', 'integ-name');
    head.appendChild(document.createTextNode(title));
    head.appendChild(el('span', 'integ-state', ok ? '正常' : '缺失'));
    main.appendChild(head);
    if (detail) { main.appendChild(el('div', 'integ-detail', detail)); }

    if (items && items.length && !ok) {
      var list = el('div', 'integ-list');
      items.slice(0, 5).forEach(function (x) {
        list.appendChild(el('div', 'integ-item',
          (x.name || '') + (x.size ? '  ·  ' + fmtSize(x.size) : '')));
      });
      if (items.length > 5) {
        list.appendChild(el('div', 'integ-item muted', tf('还有 {0} 个…', items.length - 5)));
      }
      main.appendChild(list);
    }
    row.appendChild(main);
    return row;
  }

  function fixGameIntegrity(btn) {
    if (!instId) { return; }
    if (btn) { btn.disabled = true; btn.textContent = tr('正在修复…'); }
    call('gameIntegrityFix', instId);
    toast(tr('开始补全游戏文件，进度看右上角'));
    closeModal('integ-modal');
  }

  // ---------------- 导出 ----------------
  //
  // 三种：整个实例打包、单个存档打包、整合包（mrpack / 启动器 zip / 服务端包）。
  // 目标路径都由 JavaFX 的保存对话框选，压缩在后台跑、进度走任务列表。

  /// 弹保存对话框，返回绝对路径；用户取消时给 null。
  function pickSavePath(defaultName, extension) {
    return apiCall('chooseSavePath', [defaultName, extension]).then(function (raw) {
      var path = typeof raw === 'string' ? raw.trim() : '';
      return path || null;
    });
  }

  function dateStamp() {
    var d = new Date();
    return String(d.getFullYear())
      + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0');
  }

  function exportInstanceZip() {
    if (!instId) { return; }
    var name = (instData && instData.name) || instId;
    pickSavePath(name + '-' + dateStamp() + '.zip', 'zip').then(function (path) {
      if (!path) { return; }
      call('exportInstanceZip', instId, path);
      toast(tr('开始打包实例，进度看右上角'));
    });
  }

  function exportWorldZip(w) {
    if (!instId || !w) { return; }
    pickSavePath((w.name || w.file) + '-' + dateStamp() + '.zip', 'zip').then(function (path) {
      if (!path) { return; }
      call('exportWorldZip', instId, w.file, path);
      toast(tr('开始打包存档，进度看右上角'));
    });
  }

  var mpFormat = 'mrpack';
  var MP_HINTS = {
    mrpack: '跨启动器通用，能直接上传到 Modrinth；模组会被替换成下载链接。',
    mcbbs: '国内启动器通用的 zip：manifest.json + overrides，适合发给朋友直接导入。',
    server: '只含服务端要用的文件（模组、配置、库），不含客户端资源。'
  };

  function openModpackExport() {
    if (!instId) { return; }
    var name = (instData && instData.name) || instId;
    document.getElementById('mp-export-name').value = name;
    document.getElementById('mp-export-version').value = '1.0';
    document.getElementById('mp-export-author').value = '';
    document.getElementById('mp-export-desc').value = '';
    mpFormat = 'mrpack';
    syncMpFormat();
    openModal('mp-export-modal');
  }

  function syncMpFormat() {
    var seg = document.getElementById('mp-export-format');
    if (seg) {
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-fmt') === mpFormat);
      });
    }
    var hint = document.getElementById('mp-export-hint');
    if (hint) { hint.textContent = tr(MP_HINTS[mpFormat] || ''); }
  }

  function doExportModpack() {
    if (!instId) { return; }
    var name = document.getElementById('mp-export-name').value.trim();
    var version = document.getElementById('mp-export-version').value.trim() || '1.0';
    var author = document.getElementById('mp-export-author').value.trim();
    var desc = document.getElementById('mp-export-desc').value.trim();
    var ext = mpFormat === 'mrpack' ? 'mrpack' : 'zip';
    var file = (name || instId) + '-' + version + '.' + ext;
    pickSavePath(file, ext).then(function (path) {
      if (!path) { return; }
      closeModal('mp-export-modal');
      call('exportModpack', instId, mpFormat, path, name, version, author, desc);
      toast(tr('开始导出整合包，进度看右上角'));
    });
  }

  // ---------------- 实例主题 ----------------
  //
  // 三块：图标、游戏窗口标题、启动器外观（强调色 + 顶部卡片背景图）。
  // 数据在 `<实例>/.hmcl/theme.json`，图标走 HMCL 自己的 icon.* 约定。

  var instTheme = null;
  var themeBgUrl = '';
  var themeLauncherIconUrl = '';
  /// 主题数据当前属于哪个实例。异步回来时对不上就丢掉，避免张冠李戴。
  var themeAppliedTo = '';

  // 启动器级：只认「首页选中的实例」。跟正在看哪个页面无关 ——
  // 进别人的管理页不该换启动器配色，这是这条链路的全部意义。
  var selTheme = null;
  var selThemeBg = '';
  var selThemeIcon = '';
  /// 已经拉过（或正在拉）哪个实例的主题，防止 onState 每次推送都重发三个请求
  var selThemeId = '';
  var THEME_SWATCHES = ['#5b7cfa', '#2fa96b', '#e5484d', '#d88a00', '#8f6bff', '#0aa3b5'];

  /// 页面级主题的目标：停在实例页看谁就是谁，其它页面用当前选中的。
  ///
  /// 注意它**只决定实例页的头部背景**。启动器配色走 [loadSelectedTheme]，
  /// 那条线完全不理当前在哪一页。
  function themeTargetInstance() {
    if (currentPage() === 'instance' && instId) { return instId; }
    return (state && state.selected) || '';
  }

  /// @param forPanel true = 同时填充主题面板（切到这个标签时）；
  ///                 false = 只把外观应用上去（进实例页时）。
  function loadInstanceTheme(forPanel) {
    var wanted = themeTargetInstance();
    if (!wanted) { return; }
    themeAppliedTo = wanted;
    apiCall('instanceTheme', [wanted]).then(function (raw) {
      if (wanted !== themeAppliedTo) { return; }
      var d = asJson(raw);
      instTheme = d && d.ok ? d : null;
      if (forPanel) { renderInstanceTheme(d); }
      applyInstanceTheme();
    });
    apiCall('instanceThemeBackgroundUrl', [wanted]).then(function (raw) {
      if (wanted !== themeAppliedTo) { return; }
      themeBgUrl = typeof raw === 'string' ? raw : '';
      if (forPanel) { renderThemeBgPreview(); }
      applyInstanceTheme();
    });
    apiCall('instanceThemeLauncherIcon', [wanted]).then(function (raw) {
      if (wanted !== themeAppliedTo) { return; }
      themeLauncherIconUrl = typeof raw === 'string' ? raw : '';
      if (forPanel) { renderLauncherIconPreview(); }
      applyInstanceTheme();
    });
  }

  /// 正在看的实例不是「选中的实例」时，在主题面板顶上挂一句说明。
  ///
  /// 主题色只会铺到选中的实例上，没有这句提示，用户在别的实例里改完颜色
  /// 看不到任何变化，第一反应是功能坏了。
  function syncThemeOwnerHint() {
    var hint = document.getElementById('theme-owner-hint');
    if (!hint) { return; }
    var selected = (state && state.selected) || '';
    hint.hidden = !selected || !instId || instId === selected;
  }

  function renderInstanceTheme(d) {
    var title = document.getElementById('theme-title');
    var accent = document.getElementById('theme-accent');
    var status = document.getElementById('theme-status');
    syncThemeOwnerHint();
    if (status) { status.textContent = ''; }
    if (!d || !d.ok) {
      if (status) { status.textContent = (d && d.error) || '读取失败'; }
      return;
    }
    if (title) {
      title.value = d.windowTitle || '';
      title.placeholder = d.defaultTitle ? (tr('留空用游戏默认：') + d.defaultTitle) : '留空用游戏默认标题';
    }
    if (accent) { accent.value = d.accent || ''; }

    var launcherOn = document.getElementById('theme-launcher-on');
    if (launcherOn) { launcherOn.checked = !!d.launcher; }
    var launcherTitle = document.getElementById('theme-launcher-title');
    if (launcherTitle) { launcherTitle.value = d.launcherTitle || ''; }

    syncLauncherFields();
    syncThemeSwatches();
    updateAccentPreview();
    drawThemeWheel();
    renderThemeIcon(d.hasIcon);
    renderLauncherIconPreview();
    renderThemeBgPreview();
    applyInstanceTheme();
  }

  /// 开关关掉时把图标/标题那几行收起来，避免「填了却不生效」的困惑。
  function syncLauncherFields() {
    var on = document.getElementById('theme-launcher-on');
    var fields = document.getElementById('theme-launcher-fields');
    if (fields) { fields.hidden = !(on && on.checked); }
  }

  function renderLauncherIconPreview() {
    var img = document.getElementById('theme-launcher-icon-preview');
    if (!img) { return; }
    var mark = document.querySelector('.tb-brand .brand-mark');
    var fallback = mark
      ? (mark.getAttribute('data-default-src') || mark.getAttribute('src') || '')
      : 'img/logo.gif';
    img.src = themeLauncherIconUrl || fallback;
  }

  function syncThemeSwatches() {
    var box = document.getElementById('theme-swatches');
    var accentInput = document.getElementById('theme-accent');
    if (!box) { return; }
    box.innerHTML = '';
    var current = ((accentInput && accentInput.value) || '').toLowerCase();
    THEME_SWATCHES.forEach(function (color) {
      var b = el('button', 'theme-swatch' + (current === color ? ' on' : ''));
      b.style.background = color;
      b.title = color;
      b.addEventListener('click', function () { setThemeAccent(color); });
      box.appendChild(b);
    });
  }

  function renderThemeIcon(custom) {
    var img = document.getElementById('theme-icon-preview');
    if (!img) { return; }
    var inst = currentInstance();
    img.src = (inst && inst.icon) || '';
    img.alt = (inst && inst.name) || '';
    img.classList.toggle('custom', !!custom);
  }

  function renderThemeBgPreview() {
    var box = document.getElementById('theme-bg-preview');
    if (!box) { return; }
    box.style.backgroundImage = themeBgUrl ? 'url(' + themeBgUrl + ')' : '';
    box.classList.toggle('has', !!themeBgUrl);
  }

  // ---------- 色环 ----------

  /// 画色环：360 个 1° 扇形（比逐像素快一个数量级），中心叠一层白表示低饱和。
  function drawThemeWheel() {
    var canvas = document.getElementById('theme-wheel');
    if (!canvas) { return; }
    var ctx = canvas.getContext('2d');
    var size = canvas.width;
    var r = size / 2;
    ctx.clearRect(0, 0, size, size);

    for (var i = 0; i < 360; i++) {
      var a0 = (i - 0.5) * Math.PI / 180;
      var a1 = (i + 0.5) * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(r, r);
      ctx.arc(r, r, r - 1, a0, a1);
      ctx.closePath();
      ctx.fillStyle = 'hsl(' + i + ', 100%, 50%)';
      ctx.fill();
    }

    var g = ctx.createRadialGradient(r, r, 0, r, r, r - 1);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.fill();

    // 当前颜色的位置标记
    var input = document.getElementById('theme-accent');
    var hsl = hexToHsl(input ? input.value : '');
    if (hsl) {
      var rad = hsl.h * Math.PI / 180;
      var dist = hsl.s * (r - 8);
      var x = r + Math.cos(rad) * dist;
      var y = r + Math.sin(rad) * dist;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) { return null; }
    var n = parseInt(m[1], 16);
    var r = ((n >> 16) & 255) / 255;
    var g = ((n >> 8) & 255) / 255;
    var b = (n & 255) / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0;
    var sat = 0;
    if (max !== min) {
      var d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) { h = (g - b) / d + (g < b ? 6 : 0); }
      else if (max === g) { h = (b - r) / d + 2; }
      else { h = (r - g) / d + 4; }
      h *= 60;
    }
    return { h: h, s: sat, l: l };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    function part(v) {
      var n = Math.round((v + m) * 255);
      return ('0' + Math.max(0, Math.min(255, n)).toString(16)).slice(-2);
    }
    return '#' + part(r) + part(g) + part(b);
  }

  /// 色环取色：角度 = 色相，离圆心的距离 = 饱和度。
  /// 亮度固定 55% —— 再亮颜色发白，再暗在深色主题下看不清。
  function wheelPick(e) {
    var canvas = document.getElementById('theme-wheel');
    if (!canvas) { return; }
    var rect = canvas.getBoundingClientRect();
    var dx = e.clientX - (rect.left + rect.width / 2);
    var dy = e.clientY - (rect.top + rect.height / 2);
    var radius = rect.width / 2 - 2;
    var dist = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
    var hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    setThemeAccent(hslToHex(hue, dist, 0.55));
  }

  function setThemeAccent(hex) {
    var input = document.getElementById('theme-accent');
    if (input) { input.value = hex; }
    syncThemeSwatches();
    updateAccentPreview();
    drawThemeWheel();
  }

  function updateAccentPreview() {
    var box = document.getElementById('theme-color-preview');
    var input = document.getElementById('theme-accent');
    if (!box) { return; }
    var v = ((input && input.value) || '').trim();
    box.style.background = /^#[0-9a-fA-F]{6}$/.test(v) ? v : 'transparent';
  }

  // ---------- 保存 / 上传 ----------

  function saveInstanceTheme(btn) {
    var target = instId || themeTargetInstance();
    if (!target) { return; }
    var title = document.getElementById('theme-title');
    var accent = document.getElementById('theme-accent');
    var launcherOn = document.getElementById('theme-launcher-on');
    var launcherTitle = document.getElementById('theme-launcher-title');
    if (btn) { btn.disabled = true; }
    apiCall('instanceThemeSave', [
      target,
      title ? title.value : '',
      accent ? accent.value : '',
      launcherTitle ? launcherTitle.value : '',
      !!(launcherOn && launcherOn.checked)
    ]).then(function (raw) {
      if (btn) { btn.disabled = false; }
      var d = asJson(raw);
      if (!d || !d.ok) {
        toast((d && d.error) || tr('保存失败'));
        return;
      }
      var status = document.getElementById('theme-status');
      if (status) {
        status.textContent = '已保存';
        setTimeout(function () {
          if (status.textContent === '已保存') { status.textContent = ''; }
        }, 2000);
      }
      // 本地先应用一次，不用等下一次 load
      if (instTheme) {
        instTheme.windowTitle = title ? title.value.trim() : '';
        instTheme.accent = accent ? accent.value.trim().toLowerCase() : '';
        instTheme.launcherTitle = launcherTitle ? launcherTitle.value.trim() : '';
        instTheme.launcher = !!(launcherOn && launcherOn.checked);
      }
      applyInstanceTheme();
      // 改的是当前选中的实例，启动器外观要跟着变；
      // 改的是别的实例就只更新面板，别去动启动器
      if (target === ((state && state.selected) || '')) {
        loadSelectedTheme(true);
      }
    });
  }

  function resetLauncherIcon(btn) {
    var target = instId || themeTargetInstance();
    if (!target) { return; }
    if (btn) { btn.disabled = true; }
    apiCall('instanceThemeClearLauncherIcon', [target]).then(function (raw) {
      if (btn) { btn.disabled = false; }
      var d = asJson(raw);
      if (!d || !d.ok) { toast((d && d.error) || tr('恢复失败')); return; }
      themeLauncherIconUrl = '';
      renderLauncherIconPreview();
      if (target === ((state && state.selected) || '')) {
        loadSelectedTheme(true);
      }
      toast(tr('已恢复默认图标'));
    });
  }

  /// 选本地图片。用临时 input，和「本地导入」那边同一套做法。
  function pickThemeImage(kind) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/bmp,image/gif';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (file) { uploadThemeImage(kind, file); }
    });
    input.click();
  }

  function uploadThemeImage(kind, file) {
    if (!apiBase()) { toast(tr('本地图片只在壳模式可用')); return; }
    var target = instId || themeTargetInstance();
    var url = apiEndpoint('/api/upload/' + kind, { name: file.name, instanceId: target });
    toast(tr('正在上传 ') + file.name + '…');
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { toast((j && j.error) || '上传失败'); return; }
        // 后端复制完才真正生效；图标还要等 state 推过来（列表和 hero 共用那份数据）
        setTimeout(function () {
          loadInstanceDetail();
          loadInstanceTheme(true);
        }, 800);
      })
      .catch(function (e) { toast(tr('上传失败：') + e); });
  }

  // ---------- 应用 ----------

  /// 页面级：实例页头部背景，跟着「正在看的实例」走。
  ///
  /// 启动器的强调色和外壳不在这里 —— 那些只认选中实例，见 [applySelectedTheme]。
  function applyInstanceTheme() {
    var hero = document.querySelector('.inst-hero');
    if (hero) {
      if (themeBgUrl) {
        hero.style.setProperty('--inst-bg', 'url(' + themeBgUrl + ')');
        hero.classList.add('themed');
      } else {
        hero.classList.remove('themed');
        hero.style.removeProperty('--inst-bg');
      }
    }
  }

  /// 把「选中实例」的主题铺到启动器上：强调色、整窗背景、标题栏图标与名字。
  ///
  /// 三条规则：
  /// - 强调色和背景图属于「这个实例长什么样」，有就铺，不看「启动器外观」开关；
  /// - 标题栏图标和名字属于「换掉启动器身份」，要那个开关点了才动；
  /// - 什么都没有就全部回落到默认——用户自定义背景挂在 html 上，这里只动 .app-bg，
  ///   撤掉 inline 变量就自然继承回去。
  function applySelectedTheme() {
    // 必须写在 body 上：`body[data-theme="dark"]` 里重新定义了 --accent，
    // 挂在 html 上的 inline 变量会被它盖掉（同一个变量，更近的祖先赢），
    // 表现就是深色模式下主题色不生效。
    var root = document.body || document.documentElement;
    var accent = selTheme && selTheme.accent ? selTheme.accent : '';
    if (accent) {
      root.style.setProperty('--accent', accent);
      // 强调底色跟着走，否则标签/徽章还是原来的蓝
      root.style.setProperty('--accent-soft',
        'color-mix(in srgb, ' + accent + ' 18%, transparent)');
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
    }

    var on = !!(selTheme && selTheme.launcher);
    var mark = document.querySelector('.tb-brand .brand-mark');
    var name = document.querySelector('.tb-brand strong');
    var bg = document.querySelector('.app-bg');

    if (mark) {
      if (!mark.getAttribute('data-default-src')) {
        mark.setAttribute('data-default-src', mark.getAttribute('src') || 'img/logo.gif');
      }
      mark.src = (on && selThemeIcon) ? selThemeIcon : mark.getAttribute('data-default-src');
    }
    if (name) {
      if (!name.getAttribute('data-default-name')) {
        name.setAttribute('data-default-name', name.textContent.trim());
      }
      name.textContent = (on && selTheme.launcherTitle)
        ? selTheme.launcherTitle
        : name.getAttribute('data-default-name');
    }
    if (bg) {
      // 背景图不归「启动器外观」开关管：实例有背景就铺上去，没有就撤掉回落到
      // 用户自己的背景（挂在 html 上）或默认底图。
      // 那个开关管的是标题栏图标和名字 —— 把背景也塞进同一个开关里，
      // 用户会遇到「有背景图却要额外打一次勾」这种说不通的操作。
      if (selThemeBg) {
        bg.style.setProperty('--bg-image', 'url("' + selThemeBg + '")');
      } else {
        bg.style.removeProperty('--bg-image');
      }
    }
  }

  /// 面板里的即时改动先套到启动器上（用于「启动器外观」开关的当场预览）。
  ///
  /// 只对**选中的实例**生效：在别人的主题页里勾一下，不该让整个启动器跟着变。
  /// 保存后会 `loadSelectedTheme(true)` 以磁盘数据为准重拉一遍。
  function syncSelectedThemeFromPanel() {
    if (!instTheme) { return; }
    if (instId !== ((state && state.selected) || '')) { return; }
    selTheme = instTheme;
    selThemeBg = themeBgUrl;
    selThemeIcon = themeLauncherIconUrl;
    applySelectedTheme();
  }

  /// 拉「选中实例」的主题并铺上去。
  ///
  /// 只在选中的实例变了（或显式 force）时打接口 —— onState 每次推送都会调它，
  /// 不加这道闸，聊天窗一刷新就是三个请求。
  function loadSelectedTheme(force) {
    var id = (state && state.selected) || '';
    if (!id) {
      selTheme = null; selThemeBg = ''; selThemeIcon = ''; selThemeId = '';
      applySelectedTheme();
      return;
    }
    if (!force && id === selThemeId) { return; }

    selThemeId = id;
    selTheme = null; selThemeBg = ''; selThemeIcon = '';
    // 先撤掉上一套：新实例没有主题时，这里要立刻回到默认（含用户背景图），
    // 等接口回来再撤的话，中间会留着上一个实例的配色
    applySelectedTheme();

    apiCall('instanceTheme', [id]).then(function (raw) {
      if (id !== selThemeId) { return; }
      var d = asJson(raw);
      selTheme = d && d.ok ? d : null;
      applySelectedTheme();
    });
    apiCall('instanceThemeBackgroundUrl', [id]).then(function (raw) {
      if (id !== selThemeId) { return; }
      selThemeBg = typeof raw === 'string' ? raw : '';
      applySelectedTheme();
    });
    apiCall('instanceThemeLauncherIcon', [id]).then(function (raw) {
      if (id !== selThemeId) { return; }
      selThemeIcon = typeof raw === 'string' ? raw : '';
      applySelectedTheme();
    });
  }

  /// 离开实例页 / 换实例时清掉，别把上一套皮肤带过去。
  function resetInstanceTheme() {
    instTheme = null;
    themeBgUrl = '';
    themeLauncherIconUrl = '';
    themeAppliedTo = '';
    // 只清页面级的东西。强调色和外壳属于「选中的实例」，
    // 在这里一并抹掉的话，切实例那一瞬间会闪一下默认配色再换回来。
    var hero = document.querySelector('.inst-hero');
    if (hero) {
      hero.classList.remove('themed');
      hero.style.removeProperty('--inst-bg');
    }
  }

  /// 两条线各走各的：
  /// - 启动器级：只看 `state.selected`，选中的实例换了就换主题；
  /// - 页面级：实例页头部背景跟着正在看的实例，离开实例页就清掉。
  function refreshInstanceThemeIfNeeded() {
    loadSelectedTheme(false);

    if (currentPage() !== 'instance') {
      // 不在实例页，头部背景没有宿主，清掉即可，不用再拉一份
      if (themeAppliedTo || instTheme) { resetInstanceTheme(); }
      return;
    }

    var target = themeTargetInstance();
    if (target && target === themeAppliedTo) { return; }
    resetInstanceTheme();
    if (target) { loadInstanceTheme(false); }
  }

  // ---------------- 导入压缩包 ----------------
  //
  // 流程：选文件 → 后端预检（类型 / 目标 / 风险）→ 用户确认 → 后台导入 → 结果。
  // 预检的意义是「别让人点进一个必然失败的流程」：包里没有版本 json、
  // 是加密 zip、是改扩展名的 exe，都在这一步拦下并说清楚。

  var importPath = '';
  var importProbe = null;
  var importBusy = false;

  var IMPORT_KIND_NAMES = {
    instance: '实例', modpack: '整合包', world: '存档',
    resourcepack: '资源包', shader: '光影', datapack: '数据包', mod_bundle: '模组'
  };

  /// 这些类型必须有目标实例，否则不知道往哪儿放。
  function importNeedsInstance(kind) {
    return kind === 'resourcepack' || kind === 'shader'
      || kind === 'datapack' || kind === 'mod_bundle';
  }

  /// 一条带图标的提示块。kind: warn / error / ok。
  function importNote(kind, text) {
    var node = el('div', 'import-note ' + kind);
    var icons = {
      warn: '<path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
      error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3h.01"/>',
      ok: '<path d="m5 13 4 4L19 7"/>'
    };
    var ico = el('span');
    ico.innerHTML = '<svg viewBox="0 0 24 24">' + (icons[kind] || '') + '</svg>';
    node.appendChild(ico);
    node.appendChild(el('span', null, text));
    return node;
  }

  /// 多行文本节点，避免 innerHTML 拼用户数据（实例名里可能有尖括号）。
  function importLines(lines) {
    var node = el('div', 'import-target');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) { node.appendChild(document.createElement('br')); }
      node.appendChild(document.createTextNode(lines[i]));
    }
    return node;
  }

  function importSizeText(probe) {
    var parts = [];
    if (probe.bytes) { parts.push(fmtSize(probe.bytes)); }
    if (probe.entries) { parts.push(tf('{0} 个文件', probe.entries)); }
    if (probe.uncompressedBytes) { parts.push(tf('解压后约 {0}', fmtSize(probe.uncompressedBytes))); }
    return parts.join(' · ');
  }

  /// 目标文案：说清楚「装到哪」，而不是让用户猜。
  function importTargetLines(probe) {
    var kind = probe.kind || '';
    var inst = selectedInstance();
    var instName = inst ? (inst.name || inst.id) : '';
    if (kind === 'instance') {
      return [tf('将新建一个实例，名字是「{0}」', probe.name || '')];
    }
    if (kind === 'modpack') {
      return [tr('会按整合包安装，自动新建实例并下载所需内容')];
    }
    if (kind === 'world') {
      if (instName) {
        return [tf('将导入到「{0}」的存档列表', instName)];
      }
      return [tr('将导入到当前游戏目录的 saves')];
    }
    var sub = {
      resourcepack: 'resourcepacks', shader: 'shaderpacks',
      datapack: 'datapacks', mod_bundle: 'mods'
    }[kind];
    if (!sub) { return []; }
    if (!instName) {
      return [tf('需要先选一个实例，才能放进它的 {0}', sub)];
    }
    return [tf('将放入「{0}」的 {1}', instName, sub)];
  }

  function openImportDialog() {
    if (importBusy) { return; }
    apiCall('chooseImportArchive', []).then(function (path) {
      if (!path) { return; }
      importPath = String(path);
      importProbe = null;

      var box = document.getElementById('import-content');
      if (box) { box.innerHTML = ''; }
      var go = document.getElementById('import-go');
      if (go) {
        go.disabled = true;
        go.textContent = tr('导入');
        go.removeAttribute('data-done');
      }
      var hint = document.getElementById('import-hint');
      if (hint) { hint.textContent = tr('正在检查压缩包…'); }
      var cancel = document.getElementById('import-cancel');
      if (cancel) { cancel.style.display = ''; }
      openModal('import-modal');

      apiCall('inspectArchive', [importPath]).then(function (raw) {
        renderImportPreview(asJson(raw));
      });
    });
  }

  function renderImportPreview(probe) {
    importProbe = probe || null;
    var box = document.getElementById('import-content');
    var go = document.getElementById('import-go');
    var hint = document.getElementById('import-hint');
    if (!box) { return; }
    box.innerHTML = '';

    if (!probe) {
      box.appendChild(importNote('error', tr('识别失败：没有拿到结果，换个文件再试')));
      if (go) { go.disabled = true; }
      if (hint) { hint.textContent = ''; }
      return;
    }

    // 文件本身
    var fileRow = el('div', 'import-file');
    var ico = el('span', 'import-file-ico');
    ico.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
    fileRow.appendChild(ico);
    var main = el('div', 'import-file-main');
    main.appendChild(el('div', 'import-file-name', probe.file || importPath));
    main.appendChild(el('div', 'import-file-meta', importSizeText(probe)));
    fileRow.appendChild(main);
    box.appendChild(fileRow);

    // 类型
    var kind = probe.kind || 'unknown';
    var typeRow = el('div', 'import-type');
    typeRow.appendChild(el('span', 'import-badge', tr(IMPORT_KIND_NAMES[kind] || '未知')));
    if (probe.detail) { typeRow.appendChild(el('span', 'import-type-text', probe.detail)); }
    box.appendChild(typeRow);

    var lines = importTargetLines(probe);
    if (lines.length) { box.appendChild(importLines(lines)); }

    var errors = probe.errors || [];
    var warnings = probe.warnings || [];
    warnings.forEach(function (w) { box.appendChild(importNote('warn', w)); });
    errors.forEach(function (e) { box.appendChild(importNote('error', e)); });

    var missingInstance = importNeedsInstance(kind) && !selectedInstance();
    if (missingInstance) {
      box.appendChild(importNote('error', tr('先选一个实例，再导入这个文件')));
    }

    var blocked = errors.length > 0 || missingInstance || kind === 'unknown';
    if (go) {
      go.disabled = blocked;
      go.textContent = tr('导入');
      go.removeAttribute('data-done');
    }
    if (hint) {
      hint.textContent = blocked ? tr('这个文件现在导不进去') : tr('确认后开始解压，大包可能要一两分钟');
    }
  }

  function applyArchiveImport() {
    if (!importPath || importBusy) { return; }
    if (importProbe && (importProbe.errors || []).length) { return; }
    var inst = selectedInstance();
    importBusy = true;

    var go = document.getElementById('import-go');
    var hint = document.getElementById('import-hint');
    if (go) { go.disabled = true; go.textContent = tr('导入中…'); }
    if (hint) { hint.textContent = tr('正在解压，大包可能要一两分钟'); }

    apiCall('importArchive', [importPath, inst ? inst.id : '']).then(function (started) {
      // 后端返回 "started" 就等 onArchiveImported 回调；返回 null 说明请求没发出去
      if (!started) {
        importBusy = false;
        if (go) { go.disabled = false; go.textContent = tr('导入'); }
        if (hint) { hint.textContent = ''; }
        toast(tr('导入请求没有发出去，检查一下后端是否还在运行'));
      }
    });
  }

  function summarizeImport(d) {
    if (d.kind === 'instance') { return tf('实例「{0}」', d.name || ''); }
    if (d.kind === 'world') { return tf('{0} 个存档', (d.worlds || []).length); }
    if (d.kind === 'mod_bundle') { return tf('{0} 个模组', d.imported || 0); }
    return tf('{0} 个文件', d.imported || 0);
  }

  function renderImportResult(d) {
    var box = document.getElementById('import-content');
    var go = document.getElementById('import-go');
    var hint = document.getElementById('import-hint');
    if (!box) { return; }
    box.innerHTML = '';

    // 结果页也留一行文件名，回头截图反馈问题时能对上号
    if (d.file) {
      var head = el('div', 'import-file-meta', d.file);
      box.appendChild(head);
    }

    var errors = d.errors || [];
    var warnings = d.warnings || [];
    var items = d.items || [];

    if (d.ok) {
      box.appendChild(importNote('ok', tf('导入完成：{0}', summarizeImport(d))));
    } else {
      box.appendChild(importNote('error', errors[0] || tr('导入失败')));
      errors.slice(1).forEach(function (e) { box.appendChild(importNote('error', e)); });
    }
    warnings.forEach(function (w) { box.appendChild(importNote('warn', w)); });

    if (d.target) {
      box.appendChild(importLines([tf('位置：{0}', d.target)]));
    }

    if (items.length) {
      var list = el('div', 'import-list');
      items.slice(0, 40).forEach(function (it) {
        var row = el('div', 'import-list-item' + (it.ok ? '' : ' bad'));
        row.appendChild(el('span', 'nm', it.file || ''));
        row.appendChild(el('span', 'rs', it.reason || (it.ok ? tr('已导入') : tr('跳过'))));
        list.appendChild(row);
      });
      if (items.length > 40) {
        list.appendChild(el('div', 'muted small', tf('还有 {0} 条没列出来', items.length - 40)));
      }
      box.appendChild(list);
    }

    importBusy = false;
    importProbe = null;
    if (go) {
      go.disabled = false;
      go.textContent = tr('关闭');
      go.setAttribute('data-done', '1');
    }
    // 结果已经出来了，「取消」没有意义，留着反而让人以为还能撤销
    var cancel = document.getElementById('import-cancel');
    if (cancel) { cancel.style.display = 'none'; }
    if (hint) { hint.textContent = ''; }
  }

  function initImportDialog() {
    var btn = document.getElementById('btn-import-zip');
    if (btn) { btn.addEventListener('click', openImportDialog); }

    var close = document.getElementById('import-close');
    if (close) { close.addEventListener('click', function () { closeModal('import-modal'); }); }

    var cancel = document.getElementById('import-cancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        // 导入进行中不允许取消：解压到一半停掉会留下半成品
        if (importBusy) { return; }
        closeModal('import-modal');
      });
    }

    var go = document.getElementById('import-go');
    if (go) {
      go.addEventListener('click', function () {
        if (go.getAttribute('data-done') === '1') {
          go.removeAttribute('data-done');
          closeModal('import-modal');
          return;
        }
        applyArchiveImport();
      });
    }

    var modal = document.getElementById('import-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal && !importBusy) { closeModal('import-modal'); }
      });
    }
  }

  // ---------------- 拖拽导入 ----------------
  //
  // 路径来自壳侧的原生拖放事件（WebView2 拿不到 File 的绝对路径）。
  // 分类和分发都在后端做，这里只管遮罩和结果提示。

  /// 拖到窗口上时显示遮罩：写清楚「把什么装到哪」。
  ///
  /// @param paths 壳侧给的文件绝对路径；只取文件名，路径太长会把框撑开
  function showDropOverlay(paths) {
    var node = document.getElementById('drop-overlay');
    if (!node) { return; }
    var inst = selectedInstance();
    var title = document.getElementById('drop-overlay-title');
    var tip = document.getElementById('drop-overlay-tip');

    if (!inst) {
      if (title) { title.textContent = '还没有实例'; }
      if (tip) { tip.textContent = '先去「实例」里创建一个，再拖进来'; }
      node.classList.add('blocked');
      node.classList.add('on');
      return;
    }

    var names = (paths || []).map(function (p) {
      var s = String(p);
      var cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      return cut >= 0 ? s.slice(cut + 1) : s;
    }).filter(function (x) { return !!x; });

    var what;
    if (names.length === 1) {
      what = names[0];
    } else if (names.length > 1) {
      what = tf('{0} 个文件', names.length);
    } else {
      what = tr('这些文件');
    }

    if (title) { title.textContent = tf('将 {0} 安装至 {1}', what, inst.name || inst.id); }
    if (tip) {
      // 标题里已经有实例名了，这行不再重复；多文件时列出前几个
      tip.textContent = names.length <= 1
        ? tr('松开鼠标开始安装')
        : names.slice(0, 3).join('、') + (names.length > 3 ? '…' : '');
    }
    node.classList.remove('blocked');
    node.classList.add('on');
  }

  function hideDropOverlay() {
    var node = document.getElementById('drop-overlay');
    if (node) { node.classList.remove('on'); }
  }

  function handleDropPaths(paths) {
    hideDropOverlay();
    if (!paths || !paths.length) { return; }
    var inst = selectedInstance();
    if (!inst) {
      toast(tr('还没有实例，先在「实例」里创建一个'));
      return;
    }
    // 分类在后端做（要读 zip 元数据），先给一句反馈别让人干等
    toast(tf('正在识别 {0} 个文件…', paths.length));
    call('dropImport', JSON.stringify(paths), inst.id);
  }

  var DROP_KIND_NAMES = {
    mod: '模组', resourcepack: '资源包', shader: '光影',
    world: '存档', modpack: '整合包', instance: '实例',
    datapack: '数据包', mod_bundle: '模组'
  };

  function handleDropResult(json) {
    var d = null;
    try { d = JSON.parse(json); } catch (e) { return; }
    if (!d) { return; }
    if (!d.ok) {
      toast(d.error || tr('导入失败'));
      return;
    }
    var parts = [];
    var imported = d.imported || {};
    Object.keys(imported).forEach(function (k) {
      parts.push((tr(DROP_KIND_NAMES[k] || k)) + ' ' + imported[k]);
    });
    if (parts.length) {
      toast(tf('已加入：{0}', parts.join('、')), 'ok');
    }
    var skipped = d.skipped || [];
    if (skipped.length) {
      var first = skipped[0];
      var more = skipped.length > 1 ? tf(' 等 {0} 个', skipped.length) : '';
      toast(tf('{0} 没认出来（{1}）{2}', first.file || '', first.reason || '', more));
    }
    if (!parts.length && !skipped.length) {
      toast(tr('没有可导入的文件'));
    }
    // 后端发现「原版实例 + 模组」组合时会给一句
    if (d.warning) { toast(tr(d.warning)); }
    // 内容列表可能变了，停在模组/资源包/光影页时刷一下（force：刚导入了东西，缓存必过期）
    if (INST_KIND_NAMES[instTab]) { loadInstContent(instTab, true); }
  }

  // ---------------- 实例体检：崩溃分析 / 依赖检查 ----------------

  var instCrashInfo = null;
  var instScanInfo = null;

  /// 实例 id → 整合包更新信息（后端算好的，十分钟缓存）。
  /// 卡片上的「可更新」角标和实例页顶部的更新条都读它。
  var modpackUpdates = {};
  /// 用户点了「这次先不看」的实例，本次运行不再提示。
  var modpackUpdateIgnored = {};

  /// 拉一遍所有实例的整合包更新状态。
  /// 后端按实例缓存十分钟，所以翻页、切标签重复调也不会一直打网络。
  function refreshModpackUpdates(force) {
    // 后端要打平台接口，只能是异步的：发出去就不管了，
    // 结果从 onModpackUpdates 回来（不然会把界面卡住几秒）
    call('modpackUpdateList', force ? 'true' : 'false');
  }

  /// 实例页顶部的更新条。只在这个实例确实有新版、且用户没点过「先不看」时出现。
  function renderInstUpdateBar() {
    var bar = document.getElementById('inst-update-bar');
    if (!bar) { return; }
    var u = instId ? modpackUpdates[instId] : null;
    if (!u || !u.ok || !u.hasUpdate || modpackUpdateIgnored[instId]) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var title = document.getElementById('inst-update-title');
    var subEl = document.getElementById('inst-update-sub');
    if (title) {
      title.textContent = tf('整合包有新版本 {0}', u.latestVersion || '');
    }
    if (subEl) {
      var parts = [];
      if (u.currentVersion) { parts.push(tf('当前 {0}', u.currentVersion)); }
      if (u.latestDate) { parts.push(fmtTime(u.latestDate)); }
      if (u.latestSize > 0) { parts.push(fmtSize(u.latestSize)); }
      subEl.textContent = parts.join('   ·   ');
    }
  }

  /// 进实例时查一次最近的崩溃报告。有就顶上挂一条，没有就不占地方。
  function checkInstanceCrash() {
    var bar = document.getElementById('inst-crash-bar');
    if (!bar || !instId) { return; }
    bar.hidden = true;
    instCrashInfo = null;
    var wanted = instId;
    apiCall('crashReportAnalysis', [wanted]).then(function (raw) {
      if (wanted !== instId) { return; }   // 期间切了实例，丢弃
      var d = asJson(raw);
      if (!d || !d.ok || !d.found) { return; }
      instCrashInfo = d;
      var title = document.getElementById('inst-crash-title');
      var sub = document.getElementById('inst-crash-sub');
      if (title) { title.textContent = d.title ? (tr('上次崩溃：') + d.title) : '上次启动崩溃了'; }
      var parts = [];
      if (d.time) { parts.push(fmtTime(d.time)); }
      if (d.description) { parts.push(d.description.replace(/\s+/g, ' ').slice(0, 70)); }
      if (sub) { sub.textContent = parts.join(' · '); }
      bar.classList.add('crash');
      bar.hidden = false;
    });
  }

  /// 扫 mods：缺前置 / 重复安装。只在「模组」标签页用。
  function scanInstanceMods() {
    var bar = document.getElementById('inst-scan-bar');
    if (!bar || !instId) { return; }
    bar.hidden = true;
    instScanInfo = null;
    var wanted = instId;
    apiCall('instanceModScan', [wanted]).then(function (raw) {
      if (wanted !== instId || instTab !== 'mod') { return; }
      var d = asJson(raw);
      if (!d || !d.ok) { return; }
      var missing = d.missing || [];
      var dup = d.duplicates || [];
      instScanInfo = d;
      if (!missing.length && !dup.length) { return; }

      var bits = [];
      if (missing.length) { bits.push(tr('缺 ') + missing.length + tr(' 个前置')); }
      if (dup.length) { bits.push(dup.length + tr(' 个模组重复安装')); }
      document.getElementById('inst-scan-title').textContent = tr('依赖检查：') + bits.join(' · ');

      var names = missing.slice(0, 4).map(function (m) { return m.needs; });
      if (dup.length) { names = names.concat(dup.slice(0, 2).map(function (x) { return x.id + ' ×' + x.files.length; })); }
      document.getElementById('inst-scan-sub').textContent = names.join('、') + (names.length > 6 ? ' …' : '');
      bar.hidden = false;
    });
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.remove('hidden'); }
  }

  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.add('hidden'); }
  }

  /// 崩溃分析弹窗：结论 → 动作 → 建议 → 可疑模组 → 原文摘要。
  ///
  /// 这里的按钮只做三件事：禁用可疑、禁用全部、恢复上次禁用。
  /// 禁用永远是改文件名（`.jar` → `.jar.disabled`），不删任何东西。
  function showCrashModal() {
    var d = instCrashInfo;
    var box = document.getElementById('crash-content');
    if (!box) { return; }
    box.innerHTML = '';
    if (!d) { return; }
    var modalTitle = document.getElementById('crash-modal-title');
    if (modalTitle) { modalTitle.textContent = tr('崩溃分析'); }

    var head = el('div', 'crash-headline');
    head.appendChild(el('h4', null, d.title || '崩溃原因未归类'));
    head.appendChild(el('p', null, d.detail || ''));
    box.appendChild(head);

    var meta = [];
    if (d.source === 'log') { meta.push(tr('来自启动日志')); }
    if (d.file) { meta.push(d.file); }
    if (d.time) { meta.push(fmtTime(d.time)); }
    if (d.size) { meta.push(fmtSize(d.size)); }
    if (meta.length) {
      box.appendChild(el('div', 'ib-sub', meta.join(' · ')));
    }

    box.appendChild(buildCrashActions(d));

    if (d.hints && d.hints.length) {
      var sec = el('div', 'crash-sec');
      sec.appendChild(el('h5', null, '怎么办'));
      var ul = el('ul', 'crash-hints');
      d.hints.forEach(function (h) { ul.appendChild(el('li', null, h)); });
      sec.appendChild(ul);
      box.appendChild(sec);
    }

    var suspects = (d.suspects || []).filter(function (s) { return s && (s.file || s.id); });
    if (suspects.length) {
      box.appendChild(renderCrashSuspects(suspects,
        tf('可疑模组（{0}）', suspects.length), 'susp'));
    } else if ((d.recent || []).length) {
      // 一点线索都没有的时候，最近动过的模组就是最快的二分法起点
      var tip = el('div', 'crash-sec');
      tip.appendChild(el('h5', null, '最近变动过的模组'));
      tip.appendChild(el('div', 'ib-sub',
        '崩溃报告里没有点名任何模组。下面这些是崩溃前 24 小时内装进来或改过的，先从这里试。'));
      box.appendChild(tip);
      box.appendChild(renderCrashSuspects(d.recent, '', 'recent'));
    }

    if (d.excerpt) {
      var sec3 = el('div', 'crash-sec');
      sec3.appendChild(el('h5', null, d.source === 'log' ? '日志末尾' : '报告原文（前 80 行）'));
      var pre = el('pre', 'crash-raw');
      pre.textContent = d.excerpt;
      sec3.appendChild(pre);
      box.appendChild(sec3);
    }

    openModal('crash-modal');
  }

  /// 弹窗顶部那排按钮。全部禁用要连点两次，避免手一抖把几十个模组全关了。
  function buildCrashActions(d) {
    var active = (d.suspects || []).filter(function (s) {
      return s && s.file && !s.disabled;
    });
    var all = d.enabledFiles || [];
    var q = d.quarantine;

    var wrap = el('div', 'crash-actions');

    var one = el('button', 'btn primary small',
      active.length ? tf('一键禁用可疑模组（{0}）', active.length) : '没有可禁用的可疑模组');
    one.disabled = !active.length;
    one.addEventListener('click', function () {
      doCrashDisable(active.map(function (s) { return s.file; }), one);
    });
    wrap.appendChild(one);

    if (all.length) {
      var allBtn = el('button', 'btn ghost small crash-danger', tf('禁用全部模组（{0}）', all.length));
      var armed = false;
      var timer = null;
      allBtn.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          allBtn.classList.add('armed');
          allBtn.textContent = tf('再点一次，禁用全部 {0} 个', all.length);
          timer = setTimeout(function () {
            armed = false;
            allBtn.classList.remove('armed');
            allBtn.textContent = tf('禁用全部模组（{0}）', all.length);
          }, 4000);
          return;
        }
        armed = false;
        if (timer) { clearTimeout(timer); }
        doCrashDisable('*', allBtn);
      });
      wrap.appendChild(allBtn);
    }

    if (q && q.count) {
      var back = el('button', 'btn ghost small', tf('恢复上次禁用（{0}）', q.count));
      back.addEventListener('click', function () {
        back.disabled = true;
        back.textContent = tr('正在恢复…');
        apiCall('crashRestoreMods', [instId]).then(function (raw) {
          var r = asJson(raw);
          if (!r || !r.ok) {
            toast((r && r.error) || tr('恢复失败'), 'err');
            back.disabled = false;
            back.textContent = tf('恢复上次禁用（{0}）', q.count);
            return;
          }
          toast(tf('已恢复 {0} 个模组', r.restored), 'ok');
          refreshAfterCrashAction();
        });
      });
      wrap.appendChild(back);
    }

    wrap.appendChild(el('div', 'crash-tip',
      '禁用只是把 jar 改名成 .disabled，文件不删；随时可以在模组页启用回来，或用「恢复上次禁用」一次性还原。'));

    return wrap;
  }

  /// 一批（或全部）模组改成禁用状态，成功后重新拉一遍分析结果并重绘。
  function doCrashDisable(files, btn) {
    if (!instId || !files || !files.length) { return; }
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = tr('正在禁用…');
    var payload = files === '*' ? '*' : JSON.stringify(files);
    apiCall('crashDisableMods', [instId, payload]).then(function (raw) {
      var r = asJson(raw);
      if (!r || !r.ok) {
        toast((r && r.error) || tr('禁用失败'), 'err');
        btn.disabled = false;
        btn.textContent = old;
        return;
      }
      toast(tf('已禁用 {0} 个模组，重启游戏生效', r.disabled), 'ok');
      refreshAfterCrashAction();
    });
  }

  /// 禁用/恢复之后：模组页要刷新，崩溃分析要重算（可疑列表的 disabled 状态变了）。
  function refreshAfterCrashAction() {
    if (instTab === 'mod' && typeof loadInstContent === 'function') {
      // 刚改了禁用状态，缓存里的 enabled 标记已经不对了
      loadInstContent('mod', true);
    }
    if (typeof scanInstanceMods === 'function') { scanInstanceMods(); }
    if (!instId) { return; }
    var wanted = instId;
    apiCall('crashReportAnalysis', [wanted]).then(function (raw) {
      if (wanted !== instId) { return; }
      var d = asJson(raw);
      if (d && d.ok) { instCrashInfo = d; }
      showCrashModal();
    });
  }

  /// 可疑模组卡片列表。
  function renderCrashSuspects(list, title, kind) {
    var sec = el('div', 'crash-sec');
    if (title) { sec.appendChild(el('h5', null, title)); }
    var wrap = el('div', 'crash-mods');

    list.forEach(function (s) {
      var card = el('div', 'cmc' + (s.disabled ? ' off' : '') + (kind === 'recent' ? ' recent' : ''));

      var top = el('div', 'cmc-top');
      top.appendChild(el('span', 'cmc-name', s.name || s.id || s.file));
      if (s.version) { top.appendChild(el('span', 'cmc-ver', s.version)); }
      if (kind !== 'recent') {
        var conf = s.confidence === 'high' ? '高置信'
          : s.confidence === 'medium' ? '较可能' : '待确认';
        top.appendChild(el('span', 'cmc-badge ' + (s.confidence || 'low'), conf));
      }
      if (s.loaderConflict) { top.appendChild(el('span', 'cmc-badge bad', '加载器不匹配')); }
      if (s.disabled) { top.appendChild(el('span', 'cmc-badge muted', '已禁用')); }
      card.appendChild(top);

      var fileLine = s.file || '';
      if (s.hits > 0) { fileLine += (fileLine ? '   ·   ' : '') + tf('堆栈命中 {0} 次', s.hits); }
      if (fileLine) { card.appendChild(el('div', 'cmc-file', fileLine)); }

      if (s.evidence && s.evidence.length) {
        var ul = el('ul', 'cmc-ev');
        s.evidence.forEach(function (x) { ul.appendChild(el('li', null, x)); });
        card.appendChild(ul);
      }
      if (s.advice) { card.appendChild(el('div', 'cmc-advice', s.advice)); }

      if (!s.disabled && s.file) {
        var acts = el('div', 'cmc-acts');
        var dis = el('button', 'btn ghost small', '禁用');
        dis.addEventListener('click', function () { doCrashDisable([s.file], dis); });
        acts.appendChild(dis);

        var find = el('button', 'btn ghost small', '查找兼容版本');
        find.addEventListener('click', function () { findCompatibleVersion(s); });
        acts.appendChild(find);
        card.appendChild(acts);
      }
      wrap.appendChild(card);
    });

    sec.appendChild(wrap);
    return sec;
  }

  /// 从崩溃弹窗跳到下载页：按模组名搜索，版本与加载器用当前实例筛。
  function findCompatibleVersion(s) {
    var q = (s.name && s.name !== s.file) ? s.name : (s.id || String(s.file || '').replace(/\.jar$/, ''));
    closeModal('crash-modal');
    go('download');
    switchDownloadTab('mod');
    adQuery = q;
    var box = document.getElementById('ad-search');
    if (box) { box.value = q; }
    if (instId) {
      adInstPicked['mod'] = instId;
      adInstanceTouched = true;
      var sel = document.getElementById('ad-instance');
      if (sel) { sel.value = instId; }
    }
    requestAddonSearch();
    toast(tf('按「{0}」搜索，已按当前实例的版本与加载器筛选', q), 'ok');
  }

  /// 依赖检查里点「安装」时的中转站：mod id -> Modrinth 项目 -> 版本弹窗。
  ///
  /// mod id 是 jar 里写的（`fabric.mod.json` 的 id），Modrinth 要的是 slug，
  /// 两者大多数时候一样、但不是同一个东西，所以得先问一次后端。
  var pendingDep = null;

  function currentInstance() {
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === instId) { return list[i]; }
    }
    return null;
  }

  function resolveDependency(modId, btn) {
    var inst = currentInstance();
    pendingDep = { modId: modId, btn: btn };
    if (btn) {
      btn.disabled = true;
      btn.textContent = tr('查找中…');
    }
    call('resolveAddonSlug', modId,
      (inst && inst.gameVersion) || '', (inst && inst.loader) || '');
  }

  /// 依赖检查详情：缺什么、谁需要、重复的是哪几个文件。
  function showScanModal() {
    var d = instScanInfo;
    var box = document.getElementById('crash-content');
    if (!box || !d) { return; }
    box.innerHTML = '';
    var modalTitle = document.getElementById('crash-modal-title');
    if (modalTitle) { modalTitle.textContent = tr('依赖检查'); }

    var head = el('div', 'crash-headline');
    head.appendChild(el('h4', null, '依赖检查'));
    var total = (d.mods || []).length;
    head.appendChild(el('p', null,
      tr('扫了 ') + total + tr(' 个模组：缺 ') + (d.missing || []).length + tr(' 个前置，')
      + (d.duplicates || []).length + tr(' 个模组重复安装。')));

    // 装完依赖回来点一下就能看到还缺什么 —— 依赖套依赖的那层就是这么发现的
    var tools = el('div', 'scan-tools');
    var again = el('button', 'btn ghost small', '重新检查');
    again.addEventListener('click', function () {
      closeModal('crash-modal');
      scanInstanceMods();
    });
    tools.appendChild(again);
    head.appendChild(tools);
    box.appendChild(head);

    if ((d.missing || []).length) {
      var sec = el('div', 'crash-sec');
      sec.appendChild(el('h5', null, '缺少的前置'));
      var list = el('div', 'scan-list');
      d.missing.forEach(function (m) {
        var row = el('div', 'scan-row');
        row.appendChild(el('span', 'need', m.needs));
        row.appendChild(el('span', null, tf('被「{0}」需要', m.mod) + (m.range ? ('（' + m.range + '）') : '')));
        // 缺哪个装哪个：按 mod id 找 Modrinth 项目，找到就开和模组页一样的版本弹窗
        var btn = el('button', 'btn ghost small', '安装');
        btn.addEventListener('click', function () { resolveDependency(m.needs, btn); });
        row.appendChild(btn);
        list.appendChild(row);
      });
      sec.appendChild(list);
      box.appendChild(sec);
    }

    if ((d.duplicates || []).length) {
      var sec2 = el('div', 'crash-sec');
      sec2.appendChild(el('h5', null, '重复安装'));
      var list2 = el('div', 'scan-list');
      d.duplicates.forEach(function (x) {
        var row = el('div', 'scan-row');
        row.appendChild(el('span', 'need', x.id));
        row.appendChild(el('span', null, (x.files || []).join('  /  ')));
        list2.appendChild(row);
      });
      sec2.appendChild(list2);
      box.appendChild(sec2);
    }

    if ((d.unreadable || []).length) {
      var sec3 = el('div', 'crash-sec');
      sec3.appendChild(el('h5', null, '读不出元数据的 jar'));
      sec3.appendChild(el('div', 'ib-sub', d.unreadable.join('、')));
      box.appendChild(sec3);
    }

    openModal('crash-modal');
  }

  /// 内容列表的「变更签名」。只比文件名 + 大小 + 修改时间，
  /// 后台刷回来的数据没变就不重画 —— 重画会把滚动位置和图标都掀掉。
  function instContentSig(data) {
    var items = (data && data.items) || [];
    return items.map(function (it) {
      return (it.fileName || '') + ':' + (it.size || '') + ':' + (it.modified || '');
    }).join('|');
  }

  function loadInstContent(kind, force) {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    // 换了分类，之前勾的那批文件名就没意义了
    instSelected = {};

    var key = instId + '|' + kind;
    var memo = force ? null : instContentCache[key];

    if (memo) {
      // 缓存直接铺，不出现「正在读取…」
      renderInstContent(kind, memo);
    } else {
      // 没有缓存就清空，但不再插「正在读取…」：本地接口几十毫秒就回来，
      // 中间那一大块加载提示会让人看到「加载中 → 列表」两次重排。
      // 留空白比留上一页的列表安全，比加载块安静。
      box.innerHTML = '';
    }

    apiCall('instanceAddons', [instId, kind]).then(function (raw) {
      // 期间用户可能已经切了标签
      if (instTab !== kind) { return; }
      var data = asJson(raw);
      if (!data || data.error) {
        if (!memo) { renderInstContent(kind, data); }
        return;
      }
      var sig = instContentSig(data);
      var old = instContentCache[key];
      instContentCache[key] = data;
      // 数据和缓存一模一样就什么都不做，别白重排一次列表
      if (memo && old && instContentSig(old) === sig) { return; }
      renderInstContent(kind, data);
    });
  }

  /// 实例内容行左边那张图标。
  ///
  /// 图是从本地文件里现挖的（模组 jar 的 `icon.png`、资源包的 `pack.png`、
  /// 存档的 `icon.png`），走的还是下载页那套本地 HTTP 端点，只是换了个取图来源。
  /// 取不到就换首字母色块 —— 硬塞一个通用图标比没有更容易误导。
  function instItemIcon(item, kind) {
    var box = el('div', 'inst-item-icon');
    var url = apiEndpoint('/addonIcon', {
      instance: instId,
      kind: kind,
      file: item.fileName,
      // 版本号用修改时间：换了同名文件，浏览器缓存自然失效
      v: item.modified || ''
    });
    if (!url) {
      box.appendChild(instIconLetter(item.name));
      return box;
    }

    // 和后端图标一样必须走 fetch + blob：WebView2 对指向 127.0.0.1 的
    // <img> 会做 Private Network Access 检查，同一个地址 fetch 能拿到 200，
    // <img src> 会 0ms 直接 error（见 buildAddonIcon 的注释）。
    var key = 'addon:' + kind + ':' + item.fileName + ':' + (item.modified || '');
    var img = document.createElement('img');
    img.className = 'inst-icon-img loading' + (kind === 'screenshot' ? ' cover' : '');
    img.alt = '';

    var cached = iconBlobCache[key];
    if (cached) {
      img.src = cached;
      img.classList.remove('loading');
      box.appendChild(img);
      return box;
    }

    box.appendChild(img);
    fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.blob();
    }).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      rememberIconBlob(key, objectUrl);
      img.src = objectUrl;
      img.classList.remove('loading');
    }).catch(function () {
      // 取不到就换首字母，别留一块空白
      if (img.parentNode) { img.replaceWith(instIconLetter(item.name)); }
    });

    return box;
  }

  /// 没有图标时的首字母色块。色相由名字算，同一个模组每次都是同一个颜色。
  function instIconLetter(name) {
    var text = (name || '?').trim() || '?';
    var hue = 0;
    for (var i = 0; i < text.length; i++) {
      hue = (hue * 31 + text.charCodeAt(i)) % 360;
    }
    var box = el('span', 'inst-icon-letter', text.charAt(0).toUpperCase());
    box.style.background = 'hsl(' + hue + ', 62%, 93%)';
    box.style.color = 'hsl(' + hue + ', 48%, 40%)';
    return box;
  }

  /// 按搜索词过滤。显示名和文件名都参与匹配 ——
  /// 用户经常记得的是 jar 名（sodium-fabric-0.8.13.jar）而不是模组显示名。
  function filterInstItems(items) {
    var q = String(instQuery || '').trim().toLowerCase();
    if (!q) { return items; }
    return items.filter(function (it) {
      var name = String(it.name || '').toLowerCase();
      var file = String(it.fileName || '').toLowerCase();
      return name.indexOf(q) >= 0 || file.indexOf(q) >= 0;
    });
  }

  /// 排序。默认按名称，其余三种按「最可能有用的顺序」排：
  /// 大小和时间都是倒序（先看占地方的、先看新装的），状态是把启用的排前面。
  function sortInstItems(items) {
    var list = items.slice();
    if (instSort === 'size') {
      list.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    } else if (instSort === 'time') {
      list.sort(function (a, b) { return (b.modified || 0) - (a.modified || 0); });
    } else if (instSort === 'state') {
      list.sort(function (a, b) {
        if (!!a.disabled !== !!b.disabled) { return a.disabled ? 1 : -1; }
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans');
      });
    } else {
      list.sort(function (a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans');
      });
    }
    return list;
  }

  /// 工具条的显隐与计数。
  function syncInstTools(total) {
    var contentKind = instTab === 'mod' || instTab === 'resourcepack' || instTab === 'shader';
    var tools = document.getElementById('inst-content-tools');
    if (tools) { tools.hidden = !contentKind || total === 0; }
    var batchBar = document.getElementById('inst-batch-bar');
    if (batchBar) { batchBar.hidden = !contentKind || !instBatch; }
    updateInstCount();
  }

  function updateInstCount() {
    var count = document.getElementById('inst-content-count');
    if (count) {
      var total = instItemsCache.length;
      var shown = filterInstItems(instItemsCache).length;
      count.textContent = shown === total
        ? tf('共 {0} 项', total)
        : tf('筛出 {0} / {1}', shown, total);
    }
    var bcount = document.getElementById('inst-batch-count');
    if (bcount) {
      bcount.textContent = tf('已选 {0}', Object.keys(instSelected).length);
    }
  }

  /// 进出批量模式。勾选状态每次都清空 —— 换了一批操作对象还留着上一批的勾，
  /// 很容易误删。
  function setInstBatch(on) {
    instBatch = !!on;
    instSelected = {};
    var btn = document.getElementById('inst-content-batch');
    if (btn) {
      // 批量条里已经有「退出批量」，顶上这个按钮再挂一份就是两个一样的入口
      btn.hidden = instBatch;
      btn.textContent = tr('批量');
      btn.title = '批量启用 / 禁用 / 删除';
    }
    syncInstTools(instItemsCache.length);
    if (instItemsCache.length) {
      renderInstContent(instContentKind, { items: instItemsCache });
    }
  }

  /// 批量启用 / 禁用按钮。一次请求处理一批 —— 逐个调用会把
  /// HTTP 往返和列表重推放大几十倍。
  function bindBatchAction(id, enabled) {
    var btn = document.getElementById(id);
    if (!btn) { return; }
    btn.addEventListener('click', function () {
      var files = Object.keys(instSelected);
      if (!files.length) {
        toast('先在列表里勾几项', 'error');
        return;
      }
      apiCall('addonBatchEnabled', [instId, instContentKind, JSON.stringify(files), enabled])
        .then(function () {
          instSelected = {};
          refreshInstContent(instContentKind);
        });
    });
  }

  function renderInstContent(kind, data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';

    if (!data || data.error) {
      instItemsCache = [];
      syncInstTools(0);
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    // 目录不存在是常态（新实例没有 shaderpacks），当成空列表
    var items = data.items || [];
    instItemsCache = items;
    syncInstTools(items.length);
    if (!items.length) {
      box.appendChild(el('div', 'inst-empty', INST_EMPTY[kind] || '这里还没有内容'));
      return;
    }

    var shown = sortInstItems(filterInstItems(items));
    if (!shown.length) {
      box.appendChild(el('div', 'inst-empty', tf('没有匹配「{0}」的内容', instQuery)));
      return;
    }

    var isWorld = kind === 'world';
    // 只有「游戏会按扩展名决定加不加载」的三类才值得给开关。
    // 存档是目录，改名成 .disabled 没有意义；蓝图和截图根本不参与加载，加了也是误导。
    var canToggle = kind === 'mod' || kind === 'resourcepack' || kind === 'shader';
    shown.forEach(function (item) {
      // 加载器对不上的模组整行标红：装进去肯定跑不起来，
      // 不该让用户在一堆正常模组里靠猜
      var row = el('div', 'inst-item'
        + (item.disabled ? ' off' : '')
        + (item.conflict ? ' conflict' : ''));

      if (instBatch && canToggle) {
        // 批量模式下整行就是勾选框：点一下选中，再点取消。
        // 和平时「点一下禁用」是同一个手势，不需要再记一套操作。
        row.classList.add('selectable');
        if (instSelected[item.fileName]) { row.classList.add('selected'); }
        row.appendChild(el('span', 'inst-check', '✓'));
        row.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('button')) { return; }
          if (instSelected[item.fileName]) {
            delete instSelected[item.fileName];
          } else {
            instSelected[item.fileName] = true;
          }
          row.classList.toggle('selected');
          updateInstCount();
        });
      } else if (canToggle) {
        // 整行就是开关（PCL 那种）：点一下置灰、再点一下恢复。
        // 不再单独放勾选框 —— 一个 12px 的方块当开关，点击目标太小。
        row.classList.add('toggleable');
        row.title = item.disabled ? '点击启用' : '点击禁用';
        row.addEventListener('click', function (e) {
          // 行里还有删除按钮，别把它的点击也吃掉
          if (e.target && e.target.closest && e.target.closest('button')) { return; }
          apiCall('setAddonEnabled', [instId, kind, item.fileName, item.disabled])
            .then(function () { refreshInstContent(kind); });
        });
      }

      // 左边那张图标：模组是 jar 里的 icon.png，资源包是 pack.png，
      // 存档是游戏自己截的 icon.png。认不出就换成首字母色块
      row.appendChild(instItemIcon(item, kind));

      var main = el('div', 'inst-item-main');
      var line = el('div', 'inst-item-title', item.name);
      if (item.conflict) {
        line.appendChild(el('span', 'inst-tag bad', (item.loader || '').toUpperCase()));
      }
      main.appendChild(line);
      var sub = [];
      // 存档只能报 level.dat 的大小，加个单位说明，免得被当成整个存档的体积
      sub.push(isWorld ? (fmtSize(item.size || 0) + ' level.dat') : fmtSize(item.size || 0));
      // 冲突的模组要说清楚是跟谁对不上，光红一条用户不知道怎么办
      if (item.conflict) {
        sub.push(tf('这是 {0} 模组，和当前实例的加载器不匹配', (item.loader || '').toUpperCase()));
      }
      main.appendChild(el('div', 'inst-item-sub', sub.join(' · ')));
      row.appendChild(main);

      // 管理动作全进右键菜单。行里原来挂着一个 ✕，紧挨着可点击的整行，
      // 想点开关却点到删除的事故太多了。
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openAddonMenu(e.clientX, e.clientY, item, kind);
      });

      box.appendChild(row);
    });
  }

  /// 内容列表的右键菜单：模组多一项「查看详情」。
  ///
  /// 存档/截图也走这里 —— 它们同样需要「打开所在文件夹」和「删除」，
  /// 只是没有 jar 元数据可看。
  function openAddonMenu(x, y, item, kind) {
    var items = [];
    if (kind === 'mod') {
      items.push({ label: '查看模组详情', run: function () { showAddonDetails(item, kind); } });
    }
    items.push({ label: '打开所在文件夹', run: function () {
      call('showAddonInExplorer', instId, kind, item.fileName);
    } });
    items.push({ label: '删除', danger: true, run: function () {
      askConfirm(tf('删除「{0}」？', item.name)).then(function (yes) {
        if (!yes) { return; }
        apiCall('removeAddon', [instId, kind, item.fileName]).then(function () {
          refreshInstContent(kind);
        });
      });
    } });
    showCtx(x, y, items);
  }

  /// 模组详情。数据每次都从 jar 现读 —— 用户可能刚把文件换掉，
  /// 拿列表里那份缓存信息会对不上。
  function showAddonDetails(item, kind) {
    apiCall('addonDetails', [instId, kind, item.fileName]).then(function (raw) {
      var d = asJson(raw);
      var body = document.getElementById('crash-content');
      if (!body) { return; }
      body.innerHTML = '';
      var title = document.getElementById('crash-modal-title');
      if (title) { title.textContent = tr('模组详情'); }

      if (!d || d.error) {
        body.appendChild(el('div', 'empty', (d && d.error) || '读不出来'));
        openModal('crash-modal');
        return;
      }

      var meta = d.meta || {};
      // 不用 crash-headline：那个带粉底，是崩溃分析专用。模组详情要中性。
      var head = el('div', 'addon-head');
      // 图标和列表里同一张：点了哪个模组，弹窗里一眼能对上
      head.appendChild(instItemIcon({
        fileName: d.fileName,
        name: item.name,
        modified: d.modified || 0
      }, kind));
      head.appendChild(el('h4', null, meta.name || item.name));
      if (d.loader) {
        head.appendChild(el('span', 'inst-tag' + (d.conflict ? ' bad' : ''), d.loader.toUpperCase()));
      }
      body.appendChild(head);

      var kv = el('div', 'addon-kv');
      function row(k, v) {
        if (v == null || v === '') { return; }
        var line = el('div', 'addon-kv-row');
        line.appendChild(el('span', 'k', k));
        line.appendChild(el('span', 'v', String(v)));
        kv.appendChild(line);
      }
      row('模组 ID', meta.id);
      row('版本', meta.version);
      row('文件名', d.fileName);
      row('大小', fmtSize(d.size || 0));
      if (d.modified) { row('修改时间', fmtTime(d.modified)); }
      if (d.conflict) {
        row('加载器', d.loader.toUpperCase() + tr('（和当前实例不匹配）'));
      }
      row('路径', d.path);
      body.appendChild(kv);

      var deps = meta.depends || [];
      if (deps.length) {
        var sec = el('div', 'crash-sec');
        sec.appendChild(el('h5', null, tr('依赖')));
        var list = el('div', 'scan-list');
        deps.forEach(function (dep) {
          var line = el('div', 'scan-row');
          // 不用 .need：那是依赖检查里标「缺哪个」的红字，
          // 详情弹窗只是展示，标红会让人以为这个依赖没装
          line.appendChild(el('span', 'dep-id', dep.id));
          line.appendChild(el('span', 'dep-range', dep.range || '*'));
          list.appendChild(line);
        });
        sec.appendChild(list);
        body.appendChild(sec);
      }

      openModal('crash-modal');
    });
  }

  /// 删 / 禁用之后：重载当前列表，同时刷新标签上的计数
  function refreshInstContent(kind) {
    // 装完东西缓存一定过期，走 force 绕过
    if (instTab === kind) { loadInstContent(kind, true); }
    loadInstanceDetail();
  }


  // ---------------- 启动前检查 ----------------
  //
  // 后端在真正拉起进程之前跑一遍资源检查（Java 版本 / 内存 / 客户端 jar / 模组），
  // 有问题就推 onLaunchCheck 过来，由这里出弹窗。没问题的实例根本走不到这里 ——
  // 后端直接启动，用户看到的就是「点了就开」，不额外多一次点击。
  //
  // 分两档：blocking 是「几乎必然起不来」，默认按钮给「取消」；warnings 是
  // 「能开但可能出事」，默认按钮给「继续启动」。两档都是提示，不硬拦 ——
  // 用户永远有权说「我知道，让我试」。

  var lcInstanceId = '';

  function openLaunchCheck(d) {
    if (!d || !d.instanceId) { return; }
    lcInstanceId = d.instanceId;

    var blocking = d.blocking || [];
    var warnings = d.warnings || [];
    var sub = document.getElementById('lc-sub');
    var list = document.getElementById('lc-list');
    var ok = document.getElementById('lc-ok');
    list.innerHTML = '';

    if (blocking.length) {
      sub.textContent = tr('检测到以下问题，游戏可能无法启动。');
      ok.textContent = tr('继续');
      ok.classList.remove('primary');
      ok.classList.add('ghost');
    } else {
      sub.textContent = tr('检测到以下问题，可能影响游戏运行。');
      ok.textContent = tr('继续');
      ok.classList.add('primary');
      ok.classList.remove('ghost');
    }

    blocking.forEach(function (it) { list.appendChild(lcRow(it, 'block')); });
    warnings.forEach(function (it) { list.appendChild(lcRow(it, 'warn')); });

    document.getElementById('lc-modal').classList.remove('hidden');
  }

  /// 把 `{0}` / `{1}` 换成后端给的参数。
  ///
  /// 顺序是「先翻模板，再填数字」：语言包里的键是带占位符的模板，
  /// 反过来（先填再翻）就永远查不到，等于没翻。
  function lcFill(text, params) {
    if (!text || !params || !params.length) { return text; }
    return String(text).replace(/\{(\d+)\}/g, function (m, i) {
      var v = params[+i];
      return v == null ? m : String(v);
    });
  }

  function lcRow(item, kind) {
    var row = el('div', 'lc-row ' + kind);
    var head = el('div', 'lc-row-head');
    head.appendChild(el('span', 'lc-dot'));
    head.appendChild(el('strong', null, lcFill(tr(item.title || ''), item.params)));
    row.appendChild(head);
    if (item.detail) {
      row.appendChild(el('p', 'lc-detail', lcFill(tr(item.detail), item.params)));
    }
    return row;
  }

  /// 关弹窗。`cancelled` 为真时告诉后端「这次不启动」，把放行标记清掉 ——
  /// 不清的话下一次点启动会被当成「已确认」，检查就白做了。
  function closeLaunchCheck(cancelled) {
    document.getElementById('lc-modal').classList.add('hidden');
    if (cancelled && lcInstanceId) {
      call('cancelLaunch', lcInstanceId);
    }
    lcInstanceId = '';
  }

  function initLaunchCheck() {
    var close = document.getElementById('lc-close');
    var cancel = document.getElementById('lc-cancel');
    var ok = document.getElementById('lc-ok');
    var modal = document.getElementById('lc-modal');
    if (!close || !cancel || !ok || !modal) { return; }

    close.addEventListener('click', function () { closeLaunchCheck(true); });
    cancel.addEventListener('click', function () { closeLaunchCheck(true); });
    ok.addEventListener('click', function () {
      var id = lcInstanceId;
      // 先关窗再启动：后端会重新走一遍检查以外的流程，
      // 弹窗留在屏幕上会盖住启动后的任务条。
      closeLaunchCheck(false);
      if (id) { call('launchConfirmed', id); }
    });
    // 点遮罩等于取消（和别的弹窗一致）
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeLaunchCheck(true); }
    });
  }
/* 启动进度弹窗。
 *
 * 点「启动」之后，从准备到游戏窗口出现有几秒到几十秒。原来这段时间页面上
 * 什么提示都没有，用户不知道是在下载依赖、在等 Java 还是在等窗口。
 *
 * 数据来自 Java 侧 LaunchProgressBridge，它把 HMCL 启动管线的阶段推进
 * 转发过来（检测 Java 版本 → 处理游戏依赖 → 校验游戏文件 → 登录 → 等待游戏启动）。
 * 这里只负责画，不做任何启动决策。
 */
(function () {
  'use strict';

  var REVEAL_DELAY = 250;   // 这么快就完成的话不弹，避免闪一下

  /// 状态的最小停留时间。
  ///
  /// 本地缓存命中时，五个阶段可能在 200ms 内全部跑完，用户只看到最后一句，
  /// 等于没显示。这里保证每次切换至少挂 320ms，太快的阶段会被合并成最后一个 ——
  /// 宁可少显示一步，也不要闪成一片。
  ///
  /// 文字和进度条一起切换：只节流文字会让「正在补全资源文件」配着 80% 的条，
  /// 看着像两个不同步的东西。
  var MIN_STATE_MS = 320;

  var revealTimer = 0;
  var flushTimer = 0;
  var open = false;
  var finished = false;

  var percent = 0;              // 当前显示的进度
  var queue = [];               // 待播放的状态，按到达顺序排
  var pendingFinish = null;     // 队列播完之后再处理的结束事件
  var lastAt = 0;

  /// 用户点了取消之后的静默期。后端要杀进程，收尾事件可能过几秒才到，
  /// 期间推过来的任何状态（包括 executor 报的失败）都不该再弹出来。
  var silentUntil = 0;

  /// 这一轮启动是否要在游戏退出后把窗口放回来（设置里的「隐藏，游戏退出后再打开」）。
  var reopenOnExit = false;

  function node(id) { return document.getElementById(id); }
  function tr(key) { return window.tr ? window.tr(key) : key; }

  /// 拿当前窗口对象。JavaFX 模式下没有 `__TAURI__`，返回 null，调用点静默跳过。
  function launcherWindow() {
    var tauri = window.__TAURI__;
    if (!tauri || !tauri.window) { return null; }
    try {
      return tauri.window.getCurrentWindow ? tauri.window.getCurrentWindow() : tauri.window.getCurrent();
    } catch (e) {
      return null;
    }
  }

  /// 启动成功后把启动器收起来。
  ///
  /// 壳模式下界面本身就是一个 Tauri 窗口，JavaFX 的 `LauncherVisibility.HIDE`
  /// 对它完全无效 —— 那个枚举只管 JavaFX 的 Stage。所以窗口要由页面自己调。
  function hideLauncherWindow() {
    var win = launcherWindow();
    if (win && win.hide) {
      try { win.hide(); } catch (e) { /* 隐藏失败就留着，总比崩了强 */ }
    }
  }

  function showLauncherWindow() {
    var win = launcherWindow();
    if (!win) { return; }
    try {
      if (win.show) { win.show(); }
      if (win.unminimize) { win.unminimize(); }
      if (win.setFocus) { win.setFocus(); }
    } catch (e) { /* 同上 */ }
  }

  /// 播放队列里的一项。文字和条一起换，保证读到的是一致的一帧。
  function render(next) {
    if (next.label) {
      var stage = node('lp-stage');
      var text = tr(next.label);
      if (stage && text !== stage.textContent) { stage.textContent = text; }
    }
    if (next.percent >= 0) {
      // 只许向前：阶段是跳着报的，偶尔会先收到靠后的再收到靠前的
      if (next.percent > percent) { percent = next.percent; }
      var fill = node('lp-fill');
      var bar = node('lp-bar');
      if (fill) {
        if (bar) { bar.classList.remove('pending'); }
        fill.style.width = Math.round(Math.max(4, percent * 100)) + '%';
      }
    }
    lastAt = Date.now();
  }

  /// 按固定节奏播放队列。
  ///
  /// 不是「合并丢弃」而是「排队播放」：本地缓存命中时五个阶段 200ms 就跑完了，
  /// 如果只显示最后一个，「补全依赖」「校验文件」这些步骤用户永远看不到 ——
  /// 那这几行文案就等于没写。宁可启动完成后多播一秒，也要把步骤走一遍。
  function pump() {
    if (!open) { return; }

    var since = Date.now() - lastAt;
    if (since < MIN_STATE_MS) {
      if (!flushTimer) {
        flushTimer = setTimeout(function () {
          flushTimer = 0;
          pump();
        }, MIN_STATE_MS - since);
      }
      return;
    }

    var next = queue.shift();
    if (!next) {
      var done = pendingFinish;
      if (done) {
        pendingFinish = null;
        finish(done);
      }
      return;
    }

    render(next);

    if (queue.length && !flushTimer) {
      flushTimer = setTimeout(function () {
        flushTimer = 0;
        pump();
      }, MIN_STATE_MS);
    }
  }

  function applyState(label, value) {
    if (!label && !(typeof value === 'number' && value >= 0)) { return; }
    queue.push({
      label: label || '',
      percent: typeof value === 'number' ? value : -1
    });
    // 队列别无限涨：同一阶段重复上报时只留最后一条
    if (queue.length > 12) { queue.splice(0, queue.length - 12); }
    pump();
  }

  function show() {
    var modal = node('lp-modal');
    if (!modal || open) { return; }
    open = true;
    finished = false;
    silentUntil = 0;
    lastAt = 0;
    percent = 0;

    var card = modal.querySelector('.lp-body');
    if (card) { card.classList.remove('failed'); }

    var stage = node('lp-stage');
    if (stage) { stage.textContent = tr('正在准备启动…'); }

    var fill = node('lp-fill');
    if (fill) { fill.style.width = '0%'; }
    var bar = node('lp-bar');
    if (bar) { bar.classList.add('pending'); }
    // 队列里攒的是弹窗出现之前攒下的阶段，马上开始播第一个
    lastAt = 0;

    var note = node('lp-note');
    if (note) {
      note.textContent = '';
      note.classList.remove('error');
    }
    var cancel = node('lp-cancel');
    if (cancel) {
      cancel.textContent = tr('取消启动');
      cancel.disabled = false;
      cancel.hidden = false;
    }

    modal.classList.remove('hidden');
    // 弹窗出现之前攒下的阶段，从第一项开始播
    pump();
  }

  function hide() {
    var modal = node('lp-modal');
    if (modal) { modal.classList.add('hidden'); }
    // 文字一起清掉：下次打开如果不带阶段，不该先闪一下上一轮的结果
    var stage = node('lp-stage');
    if (stage) { stage.textContent = ''; }

    open = false;
    percent = 0;
    finished = false;
    queue = [];
    pendingFinish = null;
    lastAt = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = 0;
    }
  }

  /// 失败时卡片留着，把原因写清楚，用户点「关闭」才走。
  function showFailure(error) {
    var modal = node('lp-modal');
    if (!modal) { return; }
    if (!open) { show(); }
    finished = true;

    var card = modal.querySelector('.lp-body');
    if (card) { card.classList.add('failed'); }
    var stage = node('lp-stage');
    if (stage) { stage.textContent = tr('启动失败'); }

    var note = node('lp-note');
    if (note) {
      note.textContent = error;
      note.classList.add('error');
    }
    var cancel = node('lp-cancel');
    if (cancel) {
      cancel.textContent = tr('关闭');
      cancel.disabled = false;
      cancel.hidden = false;
    }
  }

  function finish(data) {
    // 队列里还有没播完的阶段：先播完再收尾，否则用户永远看不到中间那几步
    if (queue.length) {
      pendingFinish = data;
      pump();
      return;
    }

    var error = data.error || '';

    if (error === 'cancelled') {
      hide();
      return;
    }
    if (error) {
      showFailure(error);
      return;
    }

    // 成功：把条推满，停一下让用户看到「走完了」，再关
    if (!open) { return; }   // 快到没来得及弹，不打扰
    finished = true;
    render({ label: '游戏已启动', percent: 1 });
    var btn = node('lp-cancel');
    if (btn) { btn.hidden = true; }
    setTimeout(hide, 520);

    if (data.hideLauncher) {
      reopenOnExit = !!data.reopenLauncher;
      // 比弹窗关闭晚一点：先让「游戏已启动」露个面，窗口再收起来，
      // 否则用户会觉得点完启动界面直接没了
      setTimeout(hideLauncherWindow, 900);
    }
  }

  /// Java 侧推过来的进度。参数是一段 JSON 文本，和别的回调保持一致。
  function onProgress(json) {
    var data = null;
    try { data = JSON.parse(json); } catch (e) { return; }
    if (!data) { return; }

    // 点了取消之后的收尾事件全部丢掉：那时候弹窗已经收了，
    // 再把「启动失败：xxx」推出来就是自己给自己找麻烦
    if (Date.now() < silentUntil) { return; }

    if (data.done) {
      if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = 0;
      }
      finish(data);
      return;
    }

    applyState(data.label || '', typeof data.percent === 'number' ? data.percent : -1);

    if (!open) {
      // 第一条：延迟一点再弹。本地缓存命中时整个启动 300ms 就完了，
      // 弹一下马上消失比不弹更烦人。
      if (!revealTimer && !finished) {
        revealTimer = setTimeout(function () {
          revealTimer = 0;
          if (!finished) { show(); }
        }, REVEAL_DELAY);
      }
    }
  }

  function bind() {
    var cancel = node('lp-cancel');
    if (!cancel) { return; }
    cancel.addEventListener('click', function () {
      if (finished) { hide(); return; }
      // 点了就立刻收起：后端还要杀进程、清临时目录，可能几秒。
      // 让用户盯着一个「正在取消…」的框等，不如直接消失。
      silentUntil = Date.now() + 4000;
      hide();
      try { call('cancelLaunchProgress'); } catch (e) { /* 后端没实现也不影响关闭 */ }
    });
  }

  window.__launchProgress = onProgress;

  /// 游戏退出时由 Java 侧推过来。只有「隐藏，退出后再打开」才主动恢复窗口 ——
  /// 单纯的「隐藏启动器」是让用户自己从任务栏找回来。
  window.__launchShowWindow = function () {
    if (reopenOnExit) {
      reopenOnExit = false;
      showLauncherWindow();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
  // ---------------- 实例：探索 / 管理菜单 ----------------
  //
  // 对照 HMCL 的 GameInstancePage.Skin 里那两个 PopupMenu。那边挂在左侧栏底部，
  // 这里挂在顶部信息带右侧，位置不同但条目一致。

  /// 探索菜单：打开实例运行目录下的各个子文件夹。
  /// 顺序照抄 HMCL 的 browseList（游戏目录、config、mods…logs、crash-reports）。
  var INST_EXPLORE = [
    { label: '游戏目录', sub: '' },
    { label: 'config', sub: 'config' },
    { label: 'mods', sub: 'mods' },
    { label: 'resourcepacks', sub: 'resourcepacks' },
    { label: 'saves', sub: 'saves' },
    { label: 'schematics', sub: 'schematics' },
    { label: 'shaderpacks', sub: 'shaderpacks' },
    { label: 'screenshots', sub: 'screenshots' },
    { label: 'logs', sub: 'logs' },
    { label: 'crash-reports', sub: 'crash-reports' }
  ];

  function openInstExploreMenu(anchor) {
    if (!instId) { return; }
    var rect = anchor.getBoundingClientRect();
    var items = INST_EXPLORE.map(function (it) {
      return {
        label: it.label,
        action: function () { call('instanceOpenSubfolder', instId, it.sub); }
      };
    });
    showContextMenu(rect.left, rect.bottom + 4, items);
  }

  /// 管理菜单。顺序与分组照抄 HMCL 的 managementList：
  /// 测试启动 / 启动脚本 → 改名 / 复制 / 删除 / 导出 → 截图 → 资源索引 / 清资源 / 清库 / 清垃圾。
  function openInstManageMenu(anchor) {
    if (!instId) { return; }
    var rect = anchor.getBoundingClientRect();
    var name = (instData && instData.name) || instId;
    var items = [
      {
        label: '检查游戏完整性',
        action: function () { checkGameIntegrity(); }
      },
      {
        label: '检查整合包更新',
        action: function () { call('modpackUpdateRefresh', instId); }
      },
      {
        label: '导出实例为 ZIP…',
        action: function () { exportInstanceZip(); }
      },
      {
        label: '导出整合包…',
        action: function () { openModpackExport(); }
      },
      {
        label: '测试启动',
        action: function () { call('launchTest', instId); }
      },
      {
        label: '重命名…',
        action: function () {
          askName(tf('把「{0}」改成', name), name).then(function (value) {
            if (value && value.trim() && value.trim() !== name) {
              call('instanceRename', instId, value.trim());
            }
          });
        }
      },
      {
        label: '复制实例…',
        action: function () {
          askName('复制出来的实例叫什么名字', name + tr('-副本')).then(function (value) {
            if (!value || !value.trim()) { return; }
            // 存档动辄几百 MB，复制与否差别很大，照 HMCL 那样单独问一句
            askConfirm('复制时一并带走存档吗？选「确定」连存档一起复制。').then(function (withSaves) {
              call('instanceDuplicate', instId, value.trim(), !!withSaves);
            });
          });
        }
      },
      {
        label: '删除实例',
        danger: true,
        action: function () {
          askConfirm(tf('删除「{0}」？这个操作不可撤销，实例目录会被整个删掉。', name)).then(function (yes) {
            if (!yes) { return; }
            call('instanceDelete', instId);
            // 实例没了，回到列表页
            setTimeout(function () { go('instances'); }, 700);
          });
        }
      },
      {
        label: '清理垃圾文件',
        action: function () { call('instanceClean', instId); }
      },
      {
        label: '重新下载资源索引',
        action: function () {
          askConfirm('重新下载这个版本的资源索引？贴图显示异常时用。').then(function (yes) {
            if (yes) { call('instanceRedownloadAssets', instId); }
          });
        }
      },
      {
        label: '清除资源文件',
        danger: true,
        action: function () {
          // assets 是整个游戏目录共享的，必须讲清楚
          askConfirm('删除游戏目录下的 assets？这会影响到这个目录里的所有实例，它们下次启动都要重新下载。').then(function (yes) {
            if (yes) { call('instanceClearAssets', instId); }
          });
        }
      },
      {
        label: '清除库文件',
        danger: true,
        action: function () {
          askConfirm('删除游戏目录下的 libraries？同样影响这个目录里的所有实例。').then(function (yes) {
            if (yes) { call('instanceClearLibraries', instId); }
          });
        }
      }
    ];
    showContextMenu(rect.left, rect.bottom + 4, items);
  }

  function bindInstancePage() {
    var back = document.getElementById('inst-back');
    if (back) {
      back.addEventListener('click', function () { go('instances'); });
    }
    var launch = document.getElementById('inst-launch');
    if (launch) {
      launch.addEventListener('click', function () {
        if (!instId) { return; }
        if (instId !== state.selected) { call('selectInstance', instId); }
        call('launchInstance');
      });
    }
    var testBtn = document.getElementById('inst-test');
    if (testBtn) {
      testBtn.addEventListener('click', function () {
        if (instId) { call('launchTest', instId); }
      });
    }
    var exploreBtn = document.getElementById('inst-explore');
    if (exploreBtn) {
      exploreBtn.addEventListener('click', function () { openInstExploreMenu(this); });
    }
    var manageBtn = document.getElementById('inst-manage');
    if (manageBtn) {
      manageBtn.addEventListener('click', function () { openInstManageMenu(this); });
    }

    // ---------------- 已装资源更新 ----------------
    var checkUpd = document.getElementById('inst-check-upd');
    if (checkUpd) {
      checkUpd.addEventListener('click', function () { checkAddonUpdates(this); });
    }
    var updClose = document.getElementById('upd-close');
    if (updClose) {
      updClose.addEventListener('click', function () { closeModal('upd-modal'); });
    }
    var updModal = document.getElementById('upd-modal');
    if (updModal) {
      updModal.addEventListener('click', function (e) {
        if (e.target === updModal) { closeModal('upd-modal'); }
      });
    }
    var updPickAll = document.getElementById('upd-check-all');
    if (updPickAll) {
      updPickAll.addEventListener('click', togglePickAll);
    }
    var updSel = document.getElementById('upd-btn-selected');
    if (updSel) {
      updSel.addEventListener('click', function () {
        var items = (updData && updData.items) || [];
        doApplyUpdates(items.filter(function (x) { return updPicked[x.file]; }), updSel);
      });
    }
    var updAll = document.getElementById('upd-btn-all');
    if (updAll) {
      updAll.addEventListener('click', function () {
        doApplyUpdates((updData && updData.items) || [], updAll);
      });
    }

    // ---------------- 游戏文件完整性 ----------------
    var integClose = document.getElementById('integ-close');
    if (integClose) {
      integClose.addEventListener('click', function () { closeModal('integ-modal'); });
    }
    var integModal = document.getElementById('integ-modal');
    if (integModal) {
      integModal.addEventListener('click', function (e) {
        if (e.target === integModal) { closeModal('integ-modal'); }
      });
    }

    // ---------------- 导出整合包 ----------------
    var mpClose = document.getElementById('mp-export-close');    if (mpClose) { mpClose.addEventListener('click', function () { closeModal('mp-export-modal'); }); }
    var mpCancel = document.getElementById('mp-export-cancel');
    if (mpCancel) { mpCancel.addEventListener('click', function () { closeModal('mp-export-modal'); }); }
    var mpGo = document.getElementById('mp-export-go');
    if (mpGo) { mpGo.addEventListener('click', doExportModpack); }
    var mpSeg = document.getElementById('mp-export-format');
    if (mpSeg) {
      mpSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-fmt]') : null;
        if (!btn) { return; }
        mpFormat = btn.getAttribute('data-fmt');
        syncMpFormat();
      });
    }
    var mpModal = document.getElementById('mp-export-modal');
    if (mpModal) {
      mpModal.addEventListener('click', function (e) {
        if (e.target === mpModal) { closeModal('mp-export-modal'); }
      });
    }

    // ---------------- 实例主题 ----------------
    var themeIconPick = document.getElementById('theme-icon-pick');
    if (themeIconPick) {
      themeIconPick.addEventListener('click', function () { pickThemeImage('theme-icon'); });
    }
    var themeIconReset = document.getElementById('theme-icon-reset');
    if (themeIconReset) {
      themeIconReset.addEventListener('click', function () {
        if (!instId) { return; }
        apiCall('instanceThemeResetIcon', [instId]).then(function (raw) {
          var d = asJson(raw);
          if (!d || !d.ok) { toast((d && d.error) || tr('恢复失败')); return; }
          toast(tr('已恢复默认图标'));
          // 图标变了，列表和 hero 都要重画
          loadInstanceDetail();
          loadInstanceTheme(true);
        });
      });
    }

    var themeBgPick = document.getElementById('theme-bg-pick');
    if (themeBgPick) {
      themeBgPick.addEventListener('click', function () { pickThemeImage('theme-bg'); });
    }
    var themeBgClear = document.getElementById('theme-bg-clear');
    if (themeBgClear) {
      themeBgClear.addEventListener('click', function () {
        var target = instId || themeTargetInstance();
        if (!target) { return; }
        apiCall('instanceThemeClearBackground', [target]).then(function (raw) {
          var d = asJson(raw);
          if (!d || !d.ok) { toast((d && d.error) || tr('移除失败')); return; }
          themeBgUrl = '';
          renderThemeBgPreview();
          applyInstanceTheme();
          toast(tr('背景图已移除'));
        });
      });
    }

    // ---------- 启动器外观 ----------
    var launcherOn = document.getElementById('theme-launcher-on');
    if (launcherOn) {
      launcherOn.addEventListener('change', function () {
        syncLauncherFields();
        // 勾上立刻套到界面上，让用户当场看到效果；持久化要点保存。
        // 只有「这正好是选中的实例」才预览，否则在别人的主题页勾一下，
        // 整个启动器就换皮了。
        if (instTheme) { instTheme.launcher = launcherOn.checked; }
        syncSelectedThemeFromPanel();
      });
    }
    var launcherIconPick = document.getElementById('theme-launcher-icon-pick');
    if (launcherIconPick) {
      launcherIconPick.addEventListener('click', function () { pickThemeImage('theme-launcher-icon'); });
    }
    var launcherIconReset = document.getElementById('theme-launcher-icon-reset');
    if (launcherIconReset) {
      launcherIconReset.addEventListener('click', function () { resetLauncherIcon(launcherIconReset); });
    }

    // ---------- 色环 ----------
    // 用 pointer capture：按住拖出圆盘也能继续取色，不用往 window 上挂监听
    var wheel = document.getElementById('theme-wheel');
    if (wheel) {
      var wheelPicking = false;
      wheel.addEventListener('pointerdown', function (e) {
        wheelPicking = true;
        try { wheel.setPointerCapture(e.pointerId); } catch (err) { /* 老 WebView 忽略 */ }
        wheelPick(e);
        e.preventDefault();
      });
      wheel.addEventListener('pointermove', function (e) {
        if (wheelPicking) { wheelPick(e); }
      });
      wheel.addEventListener('pointerup', function () { wheelPicking = false; });
      wheel.addEventListener('pointercancel', function () { wheelPicking = false; });
    }
    var themeAccent = document.getElementById('theme-accent');
    if (themeAccent) {
      themeAccent.addEventListener('input', function () {
        syncThemeSwatches();
        updateAccentPreview();
        drawThemeWheel();
      });
    }

    var themeSave = document.getElementById('theme-save');
    if (themeSave) {
      themeSave.addEventListener('click', function () { saveInstanceTheme(themeSave); });
    }

    var updApply = document.getElementById('inst-update-apply');
    if (updApply) {
      updApply.addEventListener('click', function () {
        var u = instId ? modpackUpdates[instId] : null;
        if (!u || !u.hasUpdate) { return; }
        var target = (instData && instData.name) || instId;
        askConfirm(tf('把「{0}」更新到 {1}？', target, u.latestVersion || '')
          + '\n\n存档和设置会保留，整合包里的模组会按新版替换。更新前会自动备份整个实例。'
        ).then(function (yes) {
          if (!yes) { return; }
          call('modpackUpdateApply', instId);
          toast(tf('开始更新到 {0}，进度看右上角', u.latestVersion || ''));
        });
      });
    }
    var updClose = document.getElementById('inst-update-close');
    if (updClose) {
      updClose.addEventListener('click', function () {
        if (instId) { modpackUpdateIgnored[instId] = true; }
        renderInstUpdateBar();
      });
    }

    // ---------------- 内容列表：搜索 / 排序 / 批量 ----------------
    var instSearch = document.getElementById('inst-content-search');
    if (instSearch) {
      instSearch.addEventListener('input', function () {
        instQuery = this.value || '';
        if (instItemsCache.length) {
          renderInstContent(instContentKind, { items: instItemsCache });
        }
      });
    }
    var instSortSel = document.getElementById('inst-content-sort');
    if (instSortSel) {
      instSortSel.addEventListener('change', function () {
        instSort = this.value || 'name';
        if (instItemsCache.length) {
          renderInstContent(instContentKind, { items: instItemsCache });
        }
      });
    }
    var instBatchBtn = document.getElementById('inst-content-batch');
    if (instBatchBtn) {
      instBatchBtn.addEventListener('click', function () { setInstBatch(!instBatch); });
    }
    var instBatchExit = document.getElementById('inst-batch-exit');
    if (instBatchExit) {
      instBatchExit.addEventListener('click', function () { setInstBatch(false); });
    }
    var instBatchAll = document.getElementById('inst-batch-all');
    if (instBatchAll) {
      instBatchAll.addEventListener('click', function () {
        var shown = filterInstItems(instItemsCache);
        // 已经全选中就是「全不选」，否则一次选满当前筛选结果
        var allPicked = shown.length > 0 && shown.every(function (it) {
          return instSelected[it.fileName];
        });
        instSelected = {};
        if (!allPicked) {
          shown.forEach(function (it) { instSelected[it.fileName] = true; });
        }
        renderInstContent(instContentKind, { items: instItemsCache });
      });
    }
    bindBatchAction('inst-batch-enable', true);
    bindBatchAction('inst-batch-disable', false);
    var instBatchDelete = document.getElementById('inst-batch-delete');
    if (instBatchDelete) {
      instBatchDelete.addEventListener('click', function () {
        var files = Object.keys(instSelected);
        if (!files.length) {
          toast('先在列表里勾几项', 'error');
          return;
        }
        askConfirm(tf('删除选中的 {0} 项？存档目录会被整个删掉，无法撤销。', files.length))
          .then(function (yes) {
            if (!yes) { return; }
            apiCall('addonBatchRemove', [instId, instContentKind, JSON.stringify(files)])
              .then(function () {
                instSelected = {};
                refreshInstContent(instContentKind);
              });
          });
      });
    }

    var nav = document.getElementById('inst-nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-itab]');
        if (btn) { setInstTab(btn.getAttribute('data-itab')); }
      });
    }

    var installBtn = document.getElementById('inst-installer-add');
    if (installBtn) {
      installBtn.addEventListener('click', function () {
        openLoaderModal((instData && instData.gameVersion) || '', instId);
      });
    }
    var contentFolder = document.getElementById('inst-content-folder');
    if (contentFolder) {
      contentFolder.addEventListener('click', function () {
        // 打开当前分类对应的子目录，而不是笼统地打开运行目录——
        // 在「模组」标签下点「打开文件夹」却落到版本根目录，很别扭
        if (!instId) { return; }
        call('instanceOpenSubfolder', instId, INST_SUB_DIR[instContentKind] || '');
      });
    }

    // 设置项：全部走 instanceSetting，key 和 Java 侧 switch 里的一一对应
    bindInstanceSetting('inst-auto-memory', 'autoMemory', 'check');
    mountMemoryMeter('inst-', function (key, mb) {
      if (instId) { call('instanceSetting', instId, key, String(mb)); }
    });
    bindInstanceSetting('inst-jvm', 'jvmOptions');
    bindInstanceSetting('inst-window-type', 'windowType');
    bindInstanceSetting('inst-width', 'width');
    bindInstanceSetting('inst-height', 'height');
    bindInstanceSetting('inst-game-args', 'gameArguments');
    bindInstanceSetting('inst-java-type', 'javaType');
    bindInstanceSetting('inst-java-path', 'customJavaPath');
    bindInstanceSetting('inst-running-dir', 'runningDirectory');
    bindInstanceSetting('inst-priority', 'processPriority');
    bindInstanceSetting('inst-launcher-visibility', 'launcherVisibility');
    bindInstanceSetting('inst-quick-play', 'quickPlay');
    bindInstanceSetting('inst-quick-sp', 'quickPlaySingleplayer');
    bindInstanceSetting('inst-quick-mp', 'quickPlayMultiplayer');
    bindInstanceSetting('inst-not-check-jvm', 'notCheckJVM', 'check');
    bindInstanceSetting('inst-not-check-game', 'notCheckGame', 'check');
    bindInstanceSetting('inst-not-use-javaw', 'notUseJavaw', 'check');
    bindInstanceSetting('inst-no-jvm-options', 'noJVMOptions', 'check');
    bindInstanceSetting('inst-no-opt-jvm-options', 'noOptimizingJVMOptions', 'check');
    bindInstanceSetting('inst-allow-auto-agent', 'allowAutoAgent', 'check');
    bindInstanceSetting('inst-disable-auto-game-options', 'disableAutoGameOptions', 'check');
  }

  function bindInstanceSetting(id, key, kind) {
    var node = document.getElementById(id);
    if (!node) { return; }
    var eventName = (kind === 'check' || node.tagName === 'SELECT') ? 'change' : 'change';
    node.addEventListener(eventName, function () {
      if (!instId) { return; }
      var value = kind === 'check' ? String(!!node.checked) : String(node.value == null ? '' : node.value);
      call('instanceSetting', instId, key, value);
      // 改「自动分配内存」要立刻锁/解锁滑条，不等后端回推
      if (key === 'autoMemory') {
        var d = (instData && instData.game) || {};
        renderMemoryMeter('inst-', d.maxMemory || 0, d.minMemory || 0, d, !!node.checked);
      }
      if (key === 'windowType') {
        var sizeRow = document.getElementById('inst-row-size');
        if (sizeRow) { sizeRow.hidden = node.value !== 'windowed'; }
      }
      if (key === 'javaType') {
        var jpRow = document.getElementById('inst-row-java-path');
        if (jpRow) { jpRow.hidden = node.value !== 'custom'; }
      }
      if (key === 'quickPlay') {
        // 选「直接进入存档」才需要存档名，选「直连服务器」才需要地址
        var spRow = document.getElementById('inst-row-quick-sp');
        var mpRow = document.getElementById('inst-row-quick-mp');
        if (spRow) { spRow.hidden = node.value !== 'singleplayer'; }
        if (mpRow) { mpRow.hidden = node.value !== 'multiplayer'; }
      }
      // 提示条可以立刻消失：写了任意一项就说明这个实例已经有独立设置了
      var hint = document.getElementById('inst-inherit-hint');
      if (hint) { hint.hidden = true; }
    });
  }

  // ---------------- 实例内容（模组 / 资源包 / 光影） ----------------

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
    document.getElementById('addons-title').textContent = tr('实例内容 · ') + instanceId;

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
      remove.title = tr('删除');
      remove.addEventListener('click', function () {
        askConfirm(tf('删除「{0}」？', item.name)).then(function (yes) {
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

  function initDownload() {
    var seg = document.getElementById('dl-filter');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-filter]');
        if (!b) { return; }
        var btns = seg.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) { btns[i].classList.remove('active'); }
        b.classList.add('active');
        dlFilter = b.getAttribute('data-filter');
        // 换筛选 = 换一批数据，页码必须归零：停在「第 5 页」上换到只有 2 页的分类，
        // 夹页逻辑虽然兜住了，但用户看到的是「点了筛选却还在原来的位置」
        dlPage = 0;
        renderDownloadList();
      });
    }

    var search = document.getElementById('dl-search');
    if (search) {
      search.addEventListener('input', function () {
        dlQuery = this.value || '';
        dlPage = 0;
        renderDownloadList();
      });
    }

    // 游戏版本翻页
    var dlPrev = document.getElementById('dl-prev');
    if (dlPrev) {
      dlPrev.addEventListener('click', function () { setDlPage(dlPage - 1); });
    }
    var dlNext = document.getElementById('dl-next');
    if (dlNext) {
      dlNext.addEventListener('click', function () { setDlPage(dlPage + 1); });
    }

    // 每页条数。默认 100，范围 20~200，选择记在本机（和主题一样走 localStorage）
    var dlPageSel = markToolbarSelect('dl-page-size');
    if (dlPageSel) {
      dlPageSel.value = String(dlPageSize);
      if (csRegistry['dl-page-size']) { csRegistry['dl-page-size'].rebuild(); }
      dlPageSel.addEventListener('change', function () {
        setDlPageSize(this.value, true);
        // 夹过之后回写实际值：用户从 DevTools 塞个 999，界面上不能还显示 999
        this.value = String(dlPageSize);
        if (csRegistry['dl-page-size']) { csRegistry['dl-page-size'].rebuild(); }
      });
    }

    var refresh = document.getElementById('dl-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        dlVersions = null;
        dlLoadError = '';
        dlPage = 0;
        renderDownloadList();
        call('requestVersions', true);
      });
    }

    // ---- 内容分类的交互 ----
    var tabs = document.getElementById('dl-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-dltab]');
        if (b) { switchDownloadTab(b.getAttribute('data-dltab')); }
      });
    }

    /// 工具栏里的自绘下拉统一登记：宽度写死在 CSS 里，不让内容决定。
    /// 实例名、类别名都是不可控长度，一旦让它按文字撑，整行就被顶折了。
    function markToolbarSelect(id) {
      var sel = document.getElementById(id);
      if (!sel) { return null; }
      enhanceSelect(sel);
      var wrap = sel.closest('.cs-wrap');
      if (wrap) {
        wrap.classList.add('ad-sel');
        wrap.setAttribute('data-ad-sel', id);
      }
      return sel;
    }

    markToolbarSelect('ad-sort');
    markToolbarSelect('ad-instance');
    var adCatSel = markToolbarSelect('ad-cat');
    if (adCatSel) {
      adCatSel.addEventListener('change', function () {
        // 换类别不动搜索词：用户的意思是「在这个词的结果里再按类别筛」
        adCat = this.value || '';
        adPage = 0;
        requestAddonSearch();
      });
    }

    var adSearch = document.getElementById('ad-search');
    if (adSearch) {
      adSearch.addEventListener('input', function () {
        var v = this.value || '';
        clearTimeout(adSearchTimer);
        // 每次按键都打一次 Modrinth 会被限流，停手 350ms 再发
        adSearchTimer = setTimeout(function () {
          adQuery = v;
          adPage = 0;
          requestAddonSearch();
        }, 350);
      });
    }

    var adSortSel = document.getElementById('ad-sort');
    if (adSortSel) {
      adSortSel.addEventListener('change', function () {
        adSort = this.value;
        adPage = 0;
        requestAddonSearch();
      });
    }

    var adInstSel = document.getElementById('ad-instance');
    if (adInstSel) {
      adInstSel.addEventListener('change', function () {
        adInstPicked[adType] = this.value;
        adInstanceTouched = true;   // 用户自己选过就别再自动改了
        adPage = 0;
        requestAddonSearch();
      });
    }

    var adImport = document.getElementById('ad-import');
    if (adImport) {
      adImport.addEventListener('click', importLocalAddon);
    }

    var adReset = document.getElementById('ad-reset');
    if (adReset) {
      adReset.addEventListener('click', resetAddonSearch);
    }

    var adPrev = document.getElementById('ad-prev');
    if (adPrev) {
      adPrev.addEventListener('click', function () {
        if (adPage <= 0) { return; }
        adPage--; requestAddonSearch();
      });
    }
    var adNext = document.getElementById('ad-next');
    if (adNext) {
      adNext.addEventListener('click', function () {
        if (adPage + 1 >= adTotalPages) { return; }
        adPage++; requestAddonSearch();
      });
    }

    var newsClose = document.getElementById('news-close');
    if (newsClose) { newsClose.addEventListener('click', closeNewsDetail); }
    var newsModal = document.getElementById('news-modal');
    if (newsModal) {
      newsModal.addEventListener('click', function (e) {
        if (e.target === newsModal) { closeNewsDetail(); }
      });
    }

    var adverClose = document.getElementById('adver-close');
    if (adverClose) { adverClose.addEventListener('click', closeAddonVersions); }
    var adverCancel = document.getElementById('adver-cancel');
    if (adverCancel) { adverCancel.addEventListener('click', closeAddonVersions); }
    var adverModal = document.getElementById('adver-modal');
    if (adverModal) {
      adverModal.addEventListener('click', function (e) {
        if (e.target === adverModal) { closeAddonVersions(); }
      });
    }

    // 版本弹窗的筛选条：改完就地重画，不再打网络——数据已经全在手里了
    var adverGv = document.getElementById('adver-gv');
    if (adverGv) {
      adverGv.addEventListener('change', function () {
        adVerGv = this.value;
        renderAdverFilters();
        renderAdverList();
      });
    }
    var adverLoader = document.getElementById('adver-loader');
    if (adverLoader) {
      adverLoader.addEventListener('change', function () {
        adVerLoader = this.value;
        renderAdverFilters();
        renderAdverList();
      });
    }
    var adverRelease = document.getElementById('adver-release-only');
    if (adverRelease) {
      adverRelease.addEventListener('change', function () {
        adVerReleaseOnly = this.checked;
        renderAdverFilters();
        renderAdverList();
      });
    }

    // 下载确认弹窗
    var dlcClose = document.getElementById('dlc-close');
    if (dlcClose) { dlcClose.addEventListener('click', closeDownloadConfirm); }
    var dlcCancel = document.getElementById('dlc-cancel');
    if (dlcCancel) { dlcCancel.addEventListener('click', closeDownloadConfirm); }
    var dlcOk = document.getElementById('dlc-ok');
    if (dlcOk) { dlcOk.addEventListener('click', confirmDownload); }
    var dlcBrowse = document.getElementById('dlc-browse');
    if (dlcBrowse) {
      dlcBrowse.addEventListener('click', chooseSaveDirectory);
    }
    // 文件名里回车 = 确认下载
    var dlcName = document.getElementById('dlc-name');
    if (dlcName) {
      dlcName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { confirmDownload(); }
      });
    }
    var dlcModal = document.getElementById('dlc-modal');
    if (dlcModal) {
      dlcModal.addEventListener('click', function (e) {
        if (e.target === dlcModal) { closeDownloadConfirm(); }
      });
    }
  }

  // ---------------- 下载页：内容分类 ----------------
  //
  // 六类：游戏版本走 Mojang 清单（上面那套），其余五类走 Modrinth。
  // 数据链路：搜索 → 卡片网格 → 点卡片拉版本 → 选版本 → 下载到实例目录。
  // 具体的 HTTP / 目录判定都在 Java 的 AddonService 里，这边只负责呈现。

  var dlTab = 'game';
  var adType = '';
  var adPage = 0;
  var adTotalPages = 0;
  var adQuery = '';
  var adSort = 'relevancy';
  var adItems = [];
  var adTarget = null;        // 当前打开版本窗的项目
  var adVersionItems = [];
  var adVersionTotal = 0;
  // 版本弹窗里的筛选状态
  var adVerGv = '';
  var adVerLoader = '';
  var adVerReleaseOnly = false;
  /// 每个资源类型各自选中的实例。
  /// 共用一个变量会串台：模组页自动挑上当前实例后，切到光影页也会按那个
  /// 实例的版本和加载器去筛，「进过模组页」前后同一个页面条数就不一样。
  var adInstPicked = {};
  /// 当前类型选中的实例 id，没选就是空串（表示不筛）。
  function adInstId() { return adInstPicked[adType] || ''; }
  /// 用户手动改过「实例」下拉没有。手动改过就不再自动跟当前实例，
  /// 否则选「暂未选择实例」会在下一次状态推送时被撤销。
  var adInstanceTouched = false;
  /// 用户手动切过内容平台没有。设置里那个「默认内容源」只在用户没手动切过时套用，
  /// 否则每次状态推送都会把他刚选的平台顶回去。
  var adSourceTouched = false;
  /// CurseForge 能不能用（构建期有没有 API Key）。null = 还没问出来。
  /// 设置里的默认内容源要套到下载页时，得先过这一关：
  /// 默认设成 CF、但这版根本没 key，切过去就是一片空白。
  var cfReady = null;
  var adSearchTimer = null;
  // 搜索请求序号。连点类别芯片会同时发出多个请求，回来的顺序不保证；
  // 只有 seq 等于当前值的响应才算数，其余直接丢。
  var adReqSeq = 0;

  // 类别。两家平台各一套表，所以缓存键是 `类型|平台`：
  // Modrinth 给的是 `adventure` 这种 slug，CurseForge 给的是 434 这种数字 id，
  // 混用的话点哪个类别都搜不出东西。
  var adCatGroups = [];   // 当前类型 + 平台的 [{key, items:[{slug, name}]}]
  var adCatCache = {};    // "type|source" -> groups，切走再切回来不重新拉
  var adCat = '';         // 当前选中的 slug（单选），空串 = 全部类别

  /// 接口的 header → 中文组名。认不出来的直接用原 key。
  var AD_CAT_GROUP = {
    categories: '类别', features: '特性', resolutions: '分辨率',
    'performance impact': '性能影响'
  };

  // 世界也要选目标实例：存档得知道放进哪个实例的 saves 里
  var AD_INSTANCE_TYPES = { mod: 1, resourcepack: 1, shader: 1, world: 1 };

  /// Modrinth 的分类 slug → 中文。抄的是 HMCL 的 I18N_zh_Hans.properties
  /// 里 `modrinth.category.*` 那批键，不自己翻——不然同一个 "decoration"
  /// 在启动器和网页上会显示成两个词。
  var MODRINTH_CATEGORY = {
    adventure: '冒险', atmosphere: '大气效果', audio: '音频', babric: 'Babric',
    blocks: '方块', bloom: '泛光', 'bta-babric': 'BTA (Babric)', bukkit: 'Bukkit',
    bungeecord: 'BungeeCord', canvas: 'Canvas', cartoon: '卡通', challenging: '挑战',
    'colored-lighting': '彩色光照', combat: '战斗', 'core-shaders': '核心着色器',
    cursed: '邪门', datapack: '数据包', decoration: '装饰', economy: '经济',
    entities: '实体', environment: '环境', equipment: '装备', fabric: 'Fabric',
    fantasy: '奇幻', folia: 'Folia', foliage: '植被', fonts: '字体', food: '食物',
    forge: 'Forge', 'game-mechanics': '机制', gui: 'GUI', high: '高', iris: 'Iris',
    items: '物品', 'java-agent': 'Java Agent', 'kitchen-sink': '水槽',
    'legacy-fabric': 'Legacy Fabric', library: '库', lightweight: '轻量',
    liteloader: 'LiteLoader', locale: '本地化', low: '低', magic: '魔法',
    management: '管理', medium: '中', minecraft: 'Minecraft', minigame: '小游戏',
    misc: '其他', mobs: '生物', modded: '模组适配', models: '模型',
    modloader: "Risugami's ModLoader", multiplayer: '多人', neoforge: 'NeoForge',
    nilloader: 'NilLoader', optifine: 'OptiFine', optimization: '优化',
    ornithe: 'Ornithe', paper: 'Paper', 'path-tracing': '路径追踪', pbr: 'PBR',
    potato: '土豆', purpur: 'Purpur', quests: '任务', quilt: 'Quilt',
    realistic: '写实风格', reflections: '反射', rift: 'Rift', screenshot: '仅供截图',
    'semi-realistic': '半写实风格', shadows: '阴影', simplistic: '极简风格',
    social: '社交', spigot: 'Spigot', sponge: 'Sponge', storage: '存储',
    technology: '科技', themed: '主题风格', transportation: '交通', tweaks: '优化',
    utility: '实用', vanilla: '原版着色器', 'vanilla-like': '原版风格',
    velocity: 'Velocity', waterfall: 'Waterfall', worldgen: '地形',
    '8x-': '8x 或更低', '32x': '32x', '48x': '48x', '64x': '64x'
  };

  function categoryLabel(slug) {
    if (!slug) { return ''; }
    return MODRINTH_CATEGORY[slug] || slug;
  }

  /// CurseForge 的分类名 → 中文。按英文原名做键，因为接口给的 id 会随
  /// 分类重建而变，名字反而是稳定的。命中不了就原样显示英文——
  /// 显示 `Blood Magic` 比显示一个猜的中文名好。
  var CF_CATEGORY = {
    // 模组
    'Armor, Tools, and Weapons': '装备与武器', 'Server Utility': '服务端工具',
    'Map and Information': '地图与信息', 'Addons': '附属', 'Bug Fixes': '修复',
    'API and Library': 'API 与前置', 'Food': '食物', 'Education': '教育',
    'Technology': '科技', 'Storage': '存储', 'Utility & QoL': '实用与体验',
    'Redstone': '红石', 'Miscellaneous': '杂项', 'World Gen': '世界生成',
    'Performance': '优化', 'Cosmetic': '装饰', 'Twitch Integration': 'Twitch 集成',
    'Adventure and RPG': '冒险与 RPG', 'Magic': '魔法', 'Horror': '恐怖',
    'CreativeMode': '创造模式',
    // 整合包
    'Extra Large': '超大', 'Small / Light': '轻量', 'Combat / PvP': '战斗 / PvP',
    'Sci-Fi': '科幻', 'FTB Official Pack': 'FTB 官方包', 'Quests': '任务',
    'Tech': '科技', 'Skyblock': '空岛', 'Map Based': '地图包',
    'Multiplayer': '多人', 'Mini Game': '小游戏',
    // 资源包 / 光影
    'Photo Realistic': '写实', 'Traditional': '传统', 'Font Packs': '字体',
    'Mod Support': '支持模组', 'Medieval': '中世纪', 'Data Packs': '数据包',
    'Animated': '动态', 'Realistic': '写实', 'Fantasy': '奇幻', 'Vanilla': '原版',
    // 世界
    'Puzzle': '解谜', 'Survival': '生存', 'Creation': '创造',
    'Modded World': '模组世界', 'Adventure': '冒险', 'Game Map': '游戏地图',
    'Parkour': '跑酷'
  };

  /// 类别芯片上的文字。没翻译过的 slug 折成「Kitchen Sink」这种标题式，
  /// 比原样打印 `kitchen-sink` 好看，也不用为了一个新类别去改代码。
  function adCatLabel(slug, name) {
    // CurseForge 直接给英文名（`Armor, Tools, and Weapons`），先过一遍中文表；
    // Modrinth 只给 slug，走自己的词表。
    if (name) { return CF_CATEGORY[name] || name; }
    if (!slug) { return ''; }
    if (MODRINTH_CATEGORY[slug]) { return MODRINTH_CATEGORY[slug]; }
    return slug.replace(/-+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  // ---------------- 自绘下拉 ----------------
  //
  // 原生 select 的弹层是系统画的（灰底方角），在玻璃面板里很突兀。
  // 这里把 select 留在 DOM 里负责数据和 change 事件，视觉换成自己画的。
  var csRegistry = {};

  var CARET_SVG = '<svg class="cs-caret" viewBox="0 0 12 12"><path d="M2.6 4.4L6 7.8l3.4-3.4z"/></svg>';

  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced) { return; }
    sel.dataset.enhanced = '1';

    var wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('cs-native');

    var btn = el('button', 'cs-btn');
    btn.type = 'button';
    var label = el('span', 'cs-label');
    btn.appendChild(label);
    btn.insertAdjacentHTML('beforeend', CARET_SVG);
    wrap.appendChild(btn);

    var menu = el('div', 'cs-menu hidden');
    wrap.appendChild(menu);

    function rebuild() {
      var opt = sel.options[sel.selectedIndex];
      label.textContent = opt ? opt.textContent : '';
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (o, i) {
        var item = el('div', 'cs-item' + (i === sel.selectedIndex ? ' on' : ''), o.textContent);
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          rebuild();
          menu.classList.add('hidden');
          btn.classList.remove('open');
        });
        menu.appendChild(item);
      });
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = menu.classList.contains('hidden');
      closeAllCustomSelects();
      if (willOpen) {
        menu.classList.remove('hidden');
        // 菜单现在会限高滚动（类别能有三十项）。上次滚到一半关掉，
        // 再打开还停在半截，看着像丢了几项。选中项在视野外就滚回去。
        var on = menu.querySelector('.cs-item.on');
        if (on) {
          var top = on.offsetTop;
          if (top < menu.scrollTop || top + on.offsetHeight > menu.scrollTop + menu.clientHeight) {
            menu.scrollTop = Math.max(0, top - menu.clientHeight / 2);
          }
        } else {
          menu.scrollTop = 0;
        }
        btn.classList.add('open');
      }
    });

    rebuild();
    if (sel.id) { csRegistry[sel.id] = { rebuild: rebuild }; }

    // 选项是动态填的（语言列表、实例列表、存档列表…），变了就重建按钮文案与菜单，
    // 否则自绘按钮上会一直显示第一项
    try {
      new MutationObserver(function () { rebuild(); })
        .observe(sel, { childList: true, subtree: true });
    } catch (e) { /* WebView 太老没有 MutationObserver 就退化：靠调用方手动 rebuild */ }

    // 脚本直接改 sel.value 时（比如恢复上次选的盔甲），按钮上的文字不会跟着变，
    // 因为 rebuild 只在点选项 / 改 options 时跑。把入口挂出去，调用方自己喊一声。
    sel.__csRebuild = rebuild;
  }

  /// 把某个子树里所有还没换过的 select 都换成自绘下拉。
  function enhanceAllSelects(root) {
    var list = (root || document).querySelectorAll('select:not([data-enhanced])');
    for (var i = 0; i < list.length; i++) {
      enhanceSelect(list[i]);
    }
  }

  /// 页面是动态渲染的（切页、开弹窗都会新建 DOM），新出现的 select 也要接上，
  /// 不然「第一次进实例设置是原生、刷新一下变自绘」这种不一致会一直存在
  function observeNewSelects() {
    if (!window.MutationObserver) { return; }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) { continue; }
          if (node.tagName === 'SELECT' && !node.dataset.enhanced) {
            enhanceSelect(node);
          } else if (node.querySelector && node.querySelector('select:not([data-enhanced])')) {
            enhanceAllSelects(node);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function closeAllCustomSelects() {
    var menus = document.querySelectorAll('.cs-menu');
    for (var i = 0; i < menus.length; i++) { menus[i].classList.add('hidden'); }
    var btns = document.querySelectorAll('.cs-btn.open');
    for (var j = 0; j < btns.length; j++) { btns[j].classList.remove('open'); }
  }

  document.addEventListener('click', closeAllCustomSelects);

  // 关于页的致谢链接：壳把外部导航全拦了，所以链接只带 data-url，
  // 点击时交给 Java 侧用系统默认浏览器打开
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-url]') : null;
    if (!a) { return; }
    e.preventDefault();
    call('openUrl', a.getAttribute('data-url'));
  });

  // ---------------- 搜索缓存 ----------------
  //
  // Modrinth 一次搜索要几百毫秒到几秒。来回切标签、翻页又翻回来、
  // 改完搜索又清空，同一批参数没必要重打一次。
  var adSearchCache = {};
  var adVersionCache = {};
  var AD_CACHE_MAX = 40;

  function cacheGet(cache, key) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
  }

  function cachePut(cache, key, value) {
    var keys = Object.keys(cache);
    if (keys.length >= AD_CACHE_MAX) { delete cache[keys[0]]; }
    cache[key] = value;
  }

  function currentInstance() {
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.selected) { return list[i]; }
    }
    return list[0] || null;
  }

  /// 当前在下载页选中的实例（不是启动器里选中的那个）。
  ///
  /// 两者的区别很关键：下拉第一项是「暂未选择实例」，用户可能故意不选，
  /// 这时候要展示全量、不按加载器和版本筛。所以这里不能用 currentInstance() 兜底。
  function adInstance() {
    var id = adInstId();
    if (!id) { return null; }
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  /// 筛选用的游戏版本。模组 / 资源包 / 光影都吃实例的版本；
  /// 没选实例就返回空，表示不筛。
  function adGameVersion() {
    var inst = adInstance();
    return inst ? (inst.gameVersion || '') : '';
  }

  /// 加载器筛选。**只有模组需要它**：装错加载器的 jar 会直接崩。
  ///
  /// 其余三类都不该拿实例的加载器去筛：
  /// - 整合包自带加载器（fabric 包还是 forge 包由作者定），用当前实例的
  ///   `fabric` 去筛，只支持 forge 的整合包会被整片过滤掉 —— 表现就是
  ///   「整合包页一条都没有」。
  /// - 资源包和光影跟加载器毫无关系，筛了纯属自减结果。
  function adLoader() {
    if (adType !== 'mod') { return ''; }
    var inst = adInstance();
    if (!inst) { return ''; }
    var loader = inst.loader || '';
    // 中文标签（原版 / 未知）不是 Modrinth 的 loader 名，当成不筛
    if (!loader || loader === '原版' || loader === '未知') { return ''; }
    return loader;
  }

  function switchDownloadTab(tab) {
    dlTab = tab;
    // 上一个分类可能滚了好几屏，新分类只有一行加载提示。
    // 不复位的话停在半空，看着像「什么都没有」。
    var body = document.querySelector('.page-body');
    if (body) { body.scrollTop = 0; }
    var btns = document.querySelectorAll('#dl-tabs button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-dltab') === tab);
    }
    document.getElementById('dl-pane-game').hidden = tab !== 'game';
    document.getElementById('dl-pane-addon').hidden = tab === 'game';

    if (tab === 'game') { return; }

    // 世界只存在于 CurseForge，没有「选哪个平台」这回事 —— 藏掉那个下拉，
    // 摆一个选了也没用的开关比不摆更让人困惑。
    var adSource = document.getElementById('ad-source');
    if (adSource) {
      // 原生 select 已经被 enhanceSelect 包成自定义下拉了，
      // 直接 hidden 原生元素没用，得连外层的 .cs-wrap 一起藏
      adSource.hidden = (tab === 'world');
      var wrap = adSource.closest('.cs-wrap');
      if (wrap) { wrap.hidden = (tab === 'world'); }
    }

    adType = tab;
    adPage = 0;
    adItems = [];
    adTotalPages = 0;
    // 类别必须清掉：分类表是按资源类型分的，`adventure` 拿到资源包查询里
    // facets 一筛就是零结果，CurseForge 的数字 id 更是另一套体系。
    adCat = '';
    // 搜索词也一起清。切分类 = 换一批内容，留着上一个分类的词只会得到
    // 「零结果 + 一个跟自己无关的关键词」，用户还得手动删一次才算重来。
    // 防抖定时器必须一起清掉：打字后 350ms 内切 tab，那个定时器会把旧词
    // 又写回 adQuery，等于刚清完又被自己顶回去。
    clearTimeout(adSearchTimer);
    adSearchTimer = null;
    adQuery = '';
    var adSearchBox = document.getElementById('ad-search');
    if (adSearchBox) { adSearchBox.value = ''; }
    updateAddonToolbar();
    requestAddonCategories();
    requestAddonSearch();
  }

  function updateAddonToolbar() {
    var needsInstance = !!AD_INSTANCE_TYPES[adType];
    var inst = document.getElementById('ad-instance');
    inst.hidden = !needsInstance;
    // 自绘下拉外面套了一层 .cs-wrap，隐藏 select 的同时得把壳也藏掉，
    // 不然工具栏里会留一个空的圆角框
    var instWrap = inst.closest('.cs-wrap');
    if (instWrap) { instWrap.hidden = !needsInstance; }
    if (needsInstance) {
      inst.innerHTML = '';
      var list = (state && state.instances) || [];

      // 第一项永远是「暂未选择实例」——不按版本和加载器筛，看全量。
      // 一个实例都没有时它是唯一选项，正好符合「没有可用实例就展示所有模组」。
      var none = el('option', null, '暂未选择实例');
      none.value = '';
      inst.appendChild(none);

      list.forEach(function (it) {
        var o = el('option', null, it.name + (it.gameVersion ? '  ' + it.gameVersion : ''));
        o.value = it.id;
        if (it.id === adInstId()) { o.selected = true; }
        inst.appendChild(o);
      });

      // 只有模组默认挑当前实例 —— 装错加载器的 jar 会直接崩，值得先筛上。
      // 资源包 / 光影 / 世界跟加载器无关，默认看全量；用户想按实例筛自己选。
      //
      // 只在用户没动过下拉时自动挑。否则用户选了「暂未选择实例」，
      // 下一次状态推送重建工具栏时又会被拽回当前实例，等于选不了。
      if (!adInstanceTouched && !adInstId() && list.length && adType === 'mod') {
        var cur = currentInstance();
        if (cur) { adInstPicked[adType] = cur.id; inst.value = cur.id; }
      }
      if (!list.length) {
        adInstPicked[adType] = '';
        inst.value = '';
      }
      // 原生 select 换了 options，自绘那一层要跟着重建
      if (csRegistry['ad-instance']) { csRegistry['ad-instance'].rebuild(); }
    }

    // 模组只从在线库下；其余几类本地导入才有意义
    var importBtn = document.getElementById('ad-import');
    importBtn.hidden = adType === 'mod';
    var label = { modpack: '导入整合包', world: '导入世界', resourcepack: '导入文件', shader: '导入文件' };
    document.getElementById('ad-import-label').textContent = label[adType] || '导入';

    applyAddonSearchHint();
  }

  /// 搜索框的占位提示。两家平台的索引语言不一样：
  /// Modrinth 建了中文索引，CurseForge 只有英文标题。
  /// 提示就写在输入框里 —— 用户点进来还没打字的时候正好看得见。
  function applyAddonSearchHint() {
    var box = document.getElementById('ad-search');
    if (!box) { return; }
    box.placeholder = adSourceValue() === 'curseforge'
      ? tr('仅支持英文搜索')
      : tr('支持中英文搜索');
  }

  /// 当前选的内容平台。世界只有 CurseForge，其它类型默认 Modrinth。
  function adSourceValue() {
    if (adType === 'world') { return 'curseforge'; }
    var sel = document.getElementById('ad-source');
    return sel && sel.value ? sel.value : 'modrinth';
  }

  function addonSearchKey() {
    // 平台也算进 key：同一个词在 Modrinth 和 CurseForge 上是两套结果
    return [adType, adSourceValue(), adGameVersion(), adQuery, adPage, adSort, adLoader(), adCategory()].join('|');
  }

  // ---------------- 下载页：类别下拉 ----------------

  /// 当前选中的类别。单选，空串 = 全部。后端直接当 category 参数用：
  /// Modrinth 收 slug，CurseForge 收数字 id，各归各的，前端不解释。
  function adCategory() {
    return adCat;
  }

  /// 分类表的缓存键。平台必须算进去 —— 上面那张表两家完全不一样。
  function adCatKey() {
    return adType + '|' + adSourceValue();
  }

  function requestAddonCategories() {
    var key = adCatKey();
    var cached = adCatCache[key];
    if (cached) {
      adCatGroups = cached;
      renderAddonCategories();
      return;
    }
    // 还没拿到就先清空下拉，只留「全部类别」
    adCatGroups = [];
    renderAddonCategories();
    call('addonCategories', adType, adSourceValue());
  }

  /// 把分类表填进工具栏那个下拉。
  ///
  /// Modrinth 一次给四组（类别 / 特性 / 分辨率 / 性能影响），挤成 chips 要占三四行，
  /// 首屏全被筛选项吃掉。这里全塞进一个下拉：多组时给选项加「组名 · 」前缀，
  /// 一组（CurseForge 就是一组）就不用前缀。
  function renderAddonCategories() {
    var sel = document.getElementById('ad-cat');
    if (!sel) { return; }

    sel.innerHTML = '';
    var all = el('option', null, tr('全部类别'));
    all.value = '';
    sel.appendChild(all);

    var multi = adCatGroups.length > 1;
    adCatGroups.forEach(function (g) {
      var items = (g && g.items) || [];
      var prefix = multi ? ((AD_CAT_GROUP[g.key] || g.key) + ' · ') : '';
      items.forEach(function (it) {
        if (!it || !it.slug) { return; }
        var opt = el('option', null, prefix + adCatLabel(it.slug, it.name));
        opt.value = it.slug;
        sel.appendChild(opt);
      });
    });

    // 换平台/换类型后老 slug 可能不在新表里，落回「全部」而不是让下拉空着
    sel.value = adCat;
    if (sel.value !== adCat) {
      adCat = '';
      sel.value = '';
    }
    if (csRegistry['ad-cat']) { csRegistry['ad-cat'].rebuild(); }
  }

  function requestAddonSearch() {
    var grid = document.getElementById('ad-grid');

    // 页数属于「这一次查询」，换分类 / 换类别 / 换词都得立刻清掉。
    // 不清的话新结果回来之前，界面上还挂着上一个分类的「共 87 页」，
    // 用户会以为光影有 87 页。
    var countEl = document.getElementById('ad-count');
    if (countEl) { countEl.textContent = ''; }

    var cached = cacheGet(adSearchCache, addonSearchKey());
    if (cached) {
      adReqSeq++;          // 作废在途请求，否则它回来会把缓存结果盖掉
      applyAddonSearch(cached);
      return;
    }

    grid.innerHTML = '';
    var searchLoad = el('div', 'empty');
    searchLoad.appendChild(loadingRow('正在搜索…'));
    grid.appendChild(searchLoad);
    document.getElementById('ad-pager').hidden = true;
    adReqSeq++;
    call('addonSearch', adType, adGameVersion(), adQuery, String(adPage), adSort,
      adLoader(), adCategory(), String(adReqSeq), adSourceValue());
  }

  /// 把一次搜索结果落到界面上。缓存命中和网络返回走同一段。
  function applyAddonSearch(data) {
    var grid = document.getElementById('ad-grid');
    if (!data || data.type !== adType) { return; }

    adItems = data.items || [];
    adPage = data.page || 0;
    adTotalPages = data.totalPages || 0;

    if (data.error) {
      grid.innerHTML = '';
      var fail = el('div', 'empty ad-fail');
      fail.appendChild(el('p', 'ad-fail-text', friendlyError(data.error)));
      // 重试只在这里给：协议正常但没结果是「这个平台真没有」，刷多少次都一样
      var retry = el('button', 'btn ghost small', '重新搜索');
      retry.addEventListener('click', function () {
        delete adSearchCache[addonSearchKey()];
        requestAddonSearch();
      });
      fail.appendChild(retry);
      grid.appendChild(fail);
      document.getElementById('ad-count').textContent = '';
      document.getElementById('ad-pager').hidden = true;
      return;
    }

    document.getElementById('ad-count').textContent =
      adTotalPages > 0 ? (tr('共 ') + adTotalPages + tr(' 页')) : '';
    renderAddonGrid();

    var pager = document.getElementById('ad-pager');
    pager.hidden = adTotalPages <= 1;
    if (!pager.hidden) {
      document.getElementById('ad-page-label').textContent =
        (adPage + 1) + ' / ' + adTotalPages;
      document.getElementById('ad-prev').disabled = adPage <= 0;
      document.getElementById('ad-next').disabled = adPage + 1 >= adTotalPages;
    }
  }

  /// 搜不到东西时说人话，重点是告诉用户下一步该干嘛。
  ///
  /// 最坑的一种是「CurseForge + 中文关键词」：这不是没内容，是平台压根不索引中文。
  /// 这时候只说「没有搜到内容」，用户会换个中文词再试，试三次就开始怀疑启动器。
  /// 重置搜索：清空关键词，回到默认来源和「全部类别」。
  ///
  /// 三样一起清才对。用户点这个按钮的意思是「这个词/这个平台我搜不下去了，重来」，
  /// 只清关键词会留下一个本来就搜不到的来源，等于没重置。
  function resetAddonSearch() {
    var box = document.getElementById('ad-search');
    if (box) { box.value = ''; }
    adQuery = '';
    adPage = 0;
    adCat = '';
    adSearchCache = {};

    // 默认来源跟设置走；缺 Key 的构建里不能切过去，那会是一片空白
    var def = (state && state.download && state.download.defaultAddonSource) || 'modrinth';
    if (def === 'curseforge' && cfReady === false) { def = 'modrinth'; }

    var sel = document.getElementById('ad-source');
    // 世界只有 CurseForge，那个下拉本来就藏着，别去动它
    if (sel && adType !== 'world' && sel.value !== def) {
      sel.value = def;
      if (csRegistry['ad-source']) { csRegistry['ad-source'].rebuild(); }
      call('setAddonSource', def);
    }

    // 来源可能换了，分类表跟着换；已选类别上面已经清空
    requestAddonCategories();
    applyAddonSearchHint();
    requestAddonSearch();
  }

  function adEmptyText() {
    var q = (adQuery || '').trim();
    if (q) {
      return tf('暂未搜索到「{0}」，请尝试更换搜索关键词或切换下载源。', q);
    }
    return '暂未搜索到内容，请尝试更换搜索关键词或切换下载源。';
  }

  function renderAddonGrid() {
    var grid = document.getElementById('ad-grid');
    grid.innerHTML = '';

    if (!adItems.length) {
      grid.appendChild(el('div', 'empty', adEmptyText()));
      return;
    }

    adItems.forEach(function (it) {
      var card = el('div', 'ad-card');

      if (it.iconUrl) {
        card.appendChild(buildAddonIcon(it));
      } else {
        card.appendChild(adPlaceholderIcon(it.title));
      }

      var body = el('div', 'ad-body');
      body.appendChild(el('div', 'ad-title', it.title || ''));
      var meta = it.author ? (tr('作者 ') + it.author) : '';
      body.appendChild(el('div', 'ad-meta', meta));
      if (it.description) {
        body.appendChild(el('div', 'ad-desc', it.description));
      }
      if (it.categories && it.categories.length) {
        var tags = el('div', 'ad-tags');
        // 分类里既有内容性质（库 / 优化 / 装饰）也有加载器（Fabric / Forge），
        // 跟 HMCL 的卡片一样全列出来，用户一眼能判断这个资源合不合用
        it.categories.forEach(function (c) {
          tags.appendChild(el('span', 'tag', categoryLabel(c)));
        });
        body.appendChild(tags);
      }
      card.appendChild(body);

      card.addEventListener('click', function () { openAddonVersions(it); });
      grid.appendChild(card);
    });

    // 一页 20 张卡片同时"啪"地出现太硬。按 18ms 递进淡入，前 6 张带延迟，
    // 后面的同时落位 —— 用户视线本来也只跟着前几张走。
    stagger(grid);
  }

  /// Modrinth 的图标放在 cdn.modrinth.com，这个域名在国内经常连不上
  /// （实测 curl 和 JVM 都 connect timeout，而同域的 api.modrinth.com 正常）。
  /// 所以按「直连 → 公共图片代理」的顺序试，全挂了才退回字母块。
  ///
  /// wsrv.nl 是老牌的开源图片缓存服务，它自己去取 cdn 上的图再转给我们，
  /// 国内能连上，代价是多一跳、图会被重新编码。
  /// 拼「核心进程」的 HTTP 地址。壳模式下 port/token 挂在页面 URL 上；
  /// JavaFX 模式没有这两样，返回 null（那种模式不走本地 HTTP）。
  function apiEndpoint(path, params) {
    var base = apiBase();
    if (!base) { return null; }
    var url = 'http://127.0.0.1:' + base.port + path;
    var parts = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null) { parts.push(k + '=' + encodeURIComponent(params[k])); }
      });
    }
    parts.push('token=' + encodeURIComponent(base.token));
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
  }

  function iconCandidates(url) {
    var list = [url];
    var m = /^https?:\/\/(.+)$/i.exec(url || '');
    if (m) {
      var bare = encodeURIComponent(m[1]);
      list.push('https://wsrv.nl/?url=' + bare + '&w=96&h=96&fit=cover');
      list.push('https://images.weserv.nl/?url=' + bare + '&w=96&h=96&fit=cover');
    }
    return list;
  }

  // 图标 blob 的 objectURL 缓存。key 是原始的 cdn 地址。
  // 上限防止内存无限涨——一页 20 个图标、每个十几 KB，300 个也就几 MB。
  var iconBlobCache = {};
  var ICON_BLOB_MAX = 300;

  /// 建一个卡片图标。
  ///
  /// **不能直接 `img.src = 后端地址`**：页面在 `tauri.localhost`（公开地址空间），
  /// 后端在 `127.0.0.1`（本地），WebView2 对 <img> 这类 subresource 的
  /// Private Network Access 检查比 fetch 严得多——同一个地址 `fetch` 返回 200，
  /// `<img>` 会 0ms 直接 error（实测）。
  ///
  /// 所以走 fetch 拿 blob，再 `createObjectURL` 给 img。这样只要能取到字节就一定显示，
  /// 不依赖浏览器的私有网络策略。
  function buildAddonIcon(item) {
    var local = apiEndpoint('/icon', { u: item.iconUrl });
    if (!local) {
      // 非壳模式（JavaFX WebView）没有本地 HTTP，直接请求原地址
      return buildRemoteIcon(item);
    }

    var img = document.createElement('img');
    img.className = 'ad-icon loading';

    var cached = iconBlobCache[item.iconUrl];
    if (cached) {
      img.src = cached;
      img.classList.remove('loading');
      return img;
    }

    fetch(local).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.blob();
    }).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      rememberIconBlob(item.iconUrl, objectUrl);
      img.src = objectUrl;
      img.classList.remove('loading');
    }).catch(function () {
      // 取不到就换字母占位，别留一块空白
      if (img.parentNode) {
        img.replaceWith(adPlaceholderIcon(item.title));
      }
    });

    return img;
  }

  function rememberIconBlob(key, objectUrl) {
    var keys = Object.keys(iconBlobCache);
    if (keys.length >= ICON_BLOB_MAX) {
      var oldest = keys[0];
      try { URL.revokeObjectURL(iconBlobCache[oldest]); } catch (e) { /* 忽略 */ }
      delete iconBlobCache[oldest];
    }
    iconBlobCache[key] = objectUrl;
  }

  /// 非壳模式的退路：直接请求远程地址，失败换代理、再失败换字母。
  function buildRemoteIcon(item) {
    var urls = iconCandidates(item.iconUrl);
    var img = document.createElement('img');
    img.className = 'ad-icon loading';
    img.loading = 'lazy';
    img.decoding = 'async';

    var index = 0;
    var timer = null;

    function tryNext() {
      clearTimeout(timer);
      if (index >= urls.length) {
        if (img.parentNode) {
          img.replaceWith(adPlaceholderIcon(item.title));
        }
        return;
      }
      var src = urls[index++];
      timer = setTimeout(tryNext, 7000);
      img.onload = function () {
        clearTimeout(timer);
        if (img.naturalWidth > 0) {
          img.classList.remove('loading');
        } else {
          tryNext();
        }
      };
      img.onerror = tryNext;
      img.src = src;
    }

    tryNext();
    return img;
  }

  /// 图标拉不到时的占位：用项目名算一个稳定色，显示首字母。
  ///
  /// Modrinth 的图标放在 cdn.modrinth.com，国内经常连不上，一屏全是灰块很难看。
  /// 按名字哈希上色之后，每个项目有固定配色，看着像设计好的字母头像。
  function adPlaceholderIcon(title) {
    var name = (title || '?').trim() || '?';
    var hue = 0;
    for (var i = 0; i < name.length; i++) {
      hue = (hue * 31 + name.charCodeAt(i)) % 360;
    }
    var d = el('div', 'ad-icon placeholder', name.charAt(0).toUpperCase());
    d.style.background = 'hsl(' + hue + ', 62%, 93%)';
    d.style.color = 'hsl(' + hue + ', 48%, 40%)';
    return d;
  }

  // ---------------- 版本选择（大弹窗） ----------------
  //
  // 之前的做法是「服务端按实例版本 + 加载器筛，回来几条就列几条」，用户既看不到
  // 这个资源还支持哪些版本，也没法挑。现在只让服务端按加载器筛（那是硬兼容门槛），
  // 游戏版本不筛，全部拉回来在前端分类：
  //   · 和实例完全匹配的排最前，打「推荐」
  //   · 顶部给「游戏版本 / 加载器 / 只看正式版」三个筛选
  //   · 每行写清加载器、支持的游戏版本、版本类型、更新时间、文件名和大小
  // HMCL 也是这么做的（分出当前实例可用的那些，再让人挑）。

  /// 版本缓存只按加载器区分：游戏版本现在是前端筛的，换版本不该重新拉一遍。
  function addonVersionKey(slug) {
    return [adType, slug, adLoader()].join('|');
  }

  function openAddonVersions(item) {
    adTarget = item;
    adVersionItems = [];
    adVersionTotal = 0;

    // 默认只按加载器筛（那是硬兼容门槛，跨加载器的文件装了也跑不了）。
    // 游戏版本不筛：这里要承担「这个资源支持哪些版本」的展示职责，
    // 一上来就按实例版本收窄，用户看到的常常只有一条，甚至零条。
    // 和实例完全匹配的靠排序和「推荐」徽章顶到最前面。
    adVerGv = '';
    adVerLoader = (adLoader() || '').toLowerCase();
    adVerReleaseOnly = false;

    document.getElementById('adver-title').textContent = item.title || '选择版本';
    // 副标题里点一句当前实例是什么，用户才明白「推荐」是按什么算出来的
    var subParts = [];
    if (item.author) { subParts.push(tr('作者 ') + item.author); }
    var instInfo = adInstance();
    if (instInfo) {
      var tag = instInfo.gameVersion || '';
      if (instInfo.loader && instInfo.loader !== '原版') {
        tag += (tag ? ' · ' : '') + instInfo.loader;
      }
      if (tag) { subParts.push(tr('当前实例 ') + tag); }
    }
    document.getElementById('adver-sub').textContent = subParts.join('   ·   ');
    document.getElementById('adver-modal').classList.remove('hidden');
    renderAdverFilters();
    renderAdverList();

    var cached = cacheGet(adVersionCache, addonVersionKey(item.slug));
    if (cached) {
      setAdverVersions(cached, 0);
      return;
    }
    // 游戏版本传空：要在弹窗里按版本分类，就不能让服务端先筛掉
    call('addonVersions', adType, item.slug, '', adLoader());
  }

  function closeAddonVersions() {
    document.getElementById('adver-modal').classList.add('hidden');
    adTarget = null;
    adVersionItems = [];
  }

  /// 收到版本数据：先存起来，再重建筛选条和列表。
  function setAdverVersions(items, total) {
    adVersionItems = items || [];
    adVersionTotal = total || adVersionItems.length;

    // 筛选默认值可能不在数据里（实例的版本这个资源根本不支持），那就退回「全部」
    var gvs = adverGameVersions();
    if (adVerGv && gvs.indexOf(adVerGv) < 0) {
      adVerGv = '';
    }
    var loaders = adverLoaders();
    if (adVerLoader && loaders.indexOf(adVerLoader) < 0) {
      adVerLoader = '';
    }

    renderAdverFilters();
    renderAdverList();
  }

  /// 数据里出现过的游戏版本，新的在前。Modrinth 给的是字符串，
  /// 直接字典序会把 1.9 排到 1.10 后面，所以要按数值段比。
  function adverGameVersions() {
    var seen = {};
    var out = [];
    adVersionItems.forEach(function (v) {
      (v.gameVersions || []).forEach(function (g) {
        if (g && !seen[g]) { seen[g] = 1; out.push(g); }
      });
    });
    // 实例的版本即使没出现在列表里也放进去，用户才好切回「当前实例」
    var instGv = adGameVersion();
    if (instGv && !seen[instGv]) { out.unshift(instGv); seen[instGv] = 1; }
    out.sort(function (a, b) { return compareGameVersion(b, a); });
    return out;
  }

  function adverLoaders() {
    var seen = {};
    var out = [];
    adVersionItems.forEach(function (v) {
      (v.loaders || []).forEach(function (l) {
        if (l && !seen[l]) { seen[l] = 1; out.push(l); }
      });
    });
    out.sort();
    return out;
  }

  /// 1.21.10 > 1.21.4 > 1.9：按数值比，不是字符串比
  function compareGameVersion(a, b) {
    var pa = String(a || '').split(/[.\-+]/);
    var pb = String(b || '').split(/[.\-+]/);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i], 10);
      var y = parseInt(pb[i], 10);
      if (isNaN(x) && isNaN(y)) { continue; }
      if (isNaN(x)) { return -1; }
      if (isNaN(y)) { return 1; }
      if (x !== y) { return x - y; }
    }
    return 0;
  }

  function renderAdverFilters() {
    var gvSel = document.getElementById('adver-gv');
    var ldSel = document.getElementById('adver-loader');
    if (!gvSel || !ldSel) { return; }

    var instGv = adGameVersion();
    gvSel.innerHTML = '';
    var allGv = el('option', null, '全部版本');
    allGv.value = '';
    gvSel.appendChild(allGv);
    adverGameVersions().forEach(function (g) {
      var o = el('option', null, g + (g === instGv ? '（当前实例）' : ''));
      o.value = g;
      gvSel.appendChild(o);
    });
    gvSel.value = adVerGv;

    ldSel.innerHTML = '';
    var allLd = el('option', null, '全部加载器');
    allLd.value = '';
    ldSel.appendChild(allLd);
    adverLoaders().forEach(function (l) {
      var o = el('option', null, loaderLabel(l));
      o.value = l;
      ldSel.appendChild(o);
    });
    ldSel.value = adVerLoader;

    document.getElementById('adver-release-only').checked = adVerReleaseOnly;

    var count = document.getElementById('adver-count');
    if (!adVersionItems.length) {
      count.textContent = '';
    } else {
      var shown = filterAdverVersions().length;
      count.textContent = shown === adVersionTotal
        ? (tr('共 ') + adVersionTotal + tr(' 个版本'))
        : (shown + ' / ' + adVersionTotal + tr(' 个版本'));
    }
  }

  /// 加载器 slug → 显示名。Modrinth 里全小写。
  function loaderLabel(slug) {
    var map = {
      fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt',
      liteloader: 'LiteLoader', 'legacy-fabric': 'Legacy Fabric',
      iris: 'Iris', optifine: 'OptiFine', datapack: '数据包', minecraft: '原版',
      canvas: 'Canvas', rift: 'Rift', modloader: 'ModLoader'
    };
    return map[slug] || slug;
  }

  var ADVER_TYPE_LABEL = { release: '正式版', beta: '测试版', alpha: '快照版' };

  /// 当前筛选 + 排序后的版本。
  ///
  /// 排序：「和实例匹配」优先，其次正式版，再按发布时间新→旧。
  /// 用户点进来第一条就是能直接用的那个，不用自己找。
  function filterAdverVersions() {
    var instGv = adGameVersion();
    var instLoader = (adLoader() || '').toLowerCase();

    var list = adVersionItems.filter(function (v) {
      if (adVerReleaseOnly && (v.type || 'release') !== 'release') { return false; }
      if (adVerLoader && (v.loaders || []).indexOf(adVerLoader) < 0) { return false; }
      if (adVerGv && (v.gameVersions || []).indexOf(adVerGv) < 0) { return false; }
      return true;
    });

    function score(v) {
      var s = 0;
      if (instGv && (v.gameVersions || []).indexOf(instGv) >= 0) { s += 4; }
      if (instLoader && (v.loaders || []).indexOf(instLoader) >= 0) { s += 2; }
      if ((v.type || 'release') === 'release') { s += 1; }
      return s;
    }

    list.sort(function (a, b) {
      var d = score(b) - score(a);
      if (d) { return d; }
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    return list;
  }

  /// 这个版本算不算「推荐」：同时命中实例的游戏版本和加载器
  function isRecommended(v) {
    var instGv = adGameVersion();
    var instLoader = (adLoader() || '').toLowerCase();
    if (!instGv && !instLoader) { return false; }
    var gvOk = !instGv || (v.gameVersions || []).indexOf(instGv) >= 0;
    var ldOk = !instLoader || (v.loaders || []).indexOf(instLoader) >= 0;
    return gvOk && ldOk;
  }

  function renderAdverList() {
    var list = document.getElementById('adver-list');
    if (!list) { return; }
    list.innerHTML = '';

    if (!adTarget) { return; }

    if (!adVersionItems.length) {
      list.appendChild(loadingRow('正在拉取版本…'));
      return;
    }

    var rows = filterAdverVersions();
    if (!rows.length) {
      list.appendChild(el('div', 'adver-empty',
        '当前筛选下没有版本。把上面的游戏版本或加载器改成「全部」再试试。'));
      return;
    }

    var shown = rows.slice(0, 200);
    shown.forEach(function (v) {
      list.appendChild(buildAdverRow(v));
    });
    if (rows.length > shown.length) {
      list.appendChild(el('div', 'adver-empty',
        tr('还有 ') + (rows.length - shown.length) + tr(' 个更早的版本，用上面的筛选缩小范围。')));
    }
  }

  function buildAdverRow(v) {
    var row = el('div', 'adver-row' + (isRecommended(v) ? ' recommended' : ''));

    var info = el('div', 'adver-info');

    var line1 = el('div', 'adver-line1');
    line1.appendChild(el('span', 'adver-name', v.name || v.version || v.versionId));
    if (v.version && v.name && v.version !== v.name) {
      line1.appendChild(el('span', 'adver-ver', v.version));
    }
    var type = v.type || 'release';
    line1.appendChild(el('span', 'adver-type ' + type, ADVER_TYPE_LABEL[type] || type));
    if (isRecommended(v)) { line1.appendChild(el('span', 'adver-rec', '推荐')); }
    info.appendChild(line1);

    // 加载器 + 支持的游戏版本。游戏版本多的时候只列前几个
    var line2 = el('div', 'adver-line2');
    (v.loaders || []).forEach(function (l) {
      line2.appendChild(el('span', 'tag loader', loaderLabel(l)));
    });
    var gvs = v.gameVersions || [];
    gvs.slice(0, 6).forEach(function (g) {
      line2.appendChild(el('span', 'tag', g));
    });
    if (gvs.length > 6) {
      line2.appendChild(el('span', 'tag more', '+' + (gvs.length - 6) + tr(' 个版本')));
    }
    if (line2.childNodes.length) { info.appendChild(line2); }

    var line3 = el('div', 'adver-line3');
    if (v.date) { line3.appendChild(el('span', null, tr('更新于 ') + String(v.date).slice(0, 10))); }
    if (v.size > 0) { line3.appendChild(el('span', null, fmtSize(v.size))); }
    if (v.filename) { line3.appendChild(el('span', null, v.filename)); }
    if (v.downloads > 0) { line3.appendChild(el('span', null, fmtCount(v.downloads) + tr(' 次下载'))); }
    info.appendChild(line3);

    row.appendChild(info);

    var act = el('div', 'adver-actions');
    var btn = el('button', 'btn primary small', '下载');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      openDownloadConfirm(adTarget, v);
    });
    act.appendChild(btn);
    row.appendChild(act);

    return row;
  }

  // ---------------- 下载确认 ----------------
  //
  // 两件事合在一个弹窗里：文件名可改；有实例就直接进它的 mods 目录，
  // 没实例就当场让用户挑一个目录。

  var dlcItem = null;
  var dlcVersion = null;

  function openDownloadConfirm(item, version) {
    if (!item || !version) { return; }
    dlcItem = item;
    dlcVersion = version;

    var isPack = adType === 'modpack';
    // 世界是 zip，进来要解压成 saves/<名字>/。让用户改 zip 文件名没有意义，
    // 目录名由压缩包里的存档名决定（AddonService.uniqueSaveName 处理重名）。
    var isWorld = adType === 'world';
    document.getElementById('dlc-name-field').hidden = isPack || isWorld;
    document.getElementById('dlc-name2-field').hidden = !isPack;
    document.getElementById('dlc-dir-field').hidden = isPack;

    var sum = document.getElementById('dlc-summary');
    sum.innerHTML = '';
    if (item.iconUrl) {
      var img = document.createElement('img');
      img.src = item.iconUrl;
      sum.appendChild(img);
    }
    var main = el('div', 'dlc-sum-main');
    main.appendChild(el('strong', null, item.title || ''));
    var sub = [version.name || version.version || ''];
    if (version.loaders && version.loaders.length) {
      sub.push(version.loaders.map(loaderLabel).join(' / '));
    }
    if (version.size > 0) { sub.push(fmtSize(version.size)); }
    main.appendChild(el('span', null, sub.join(' · ')));
    sum.appendChild(main);

    if (isPack) {
      document.getElementById('dlc-name2').value = '';
    } else {
      document.getElementById('dlc-name').value = version.filename || '';
      var instId = AD_INSTANCE_TYPES[adType] ? adInstId() : '';
      var browse = document.getElementById('dlc-browse');

      if (instId) {
        // 有实例：默认落到实例目录，用户不用自己挑；但按钮照样给——
        // 「先下到桌面、回头自己拷」是真实需求，锁死位置只会逼人绕一圈。
        setDlcDir('');
        browse.hidden = false;
        browse.textContent = tr('更改…');
        apiCall('addonTargetDirectory', [adType, instId]).then(function (dir) {
          if (dlcItem === item && typeof dir === 'string' && dir) {
            setDlcDir(dir);
          }
        });
      } else {
        // 没实例：位置留空让用户自己挑。
        // 不在这里自动弹选择框——一进来就跳一个系统窗口太打扰，
        // 而且用户可能想先改文件名。点「浏览…」或「开始下载」时再弹。
        browse.hidden = false;
        browse.textContent = tr('浏览…');
        setDlcDir('');
      }
    }

    document.getElementById('dlc-modal').classList.remove('hidden');
    setTimeout(function () {
      var f = isPack ? document.getElementById('dlc-name2') : document.getElementById('dlc-name');
      if (f) { f.focus(); }
    }, 50);
  }

  /// 路径中间省略。
  ///
  /// <p>头尾都比中间有用：开头是盘符（判断落在哪个盘），结尾是最后一级目录
  /// （mods / shaderpacks / 实例名）。只截尾部的话，用户永远看不到自己下到哪儿。
  function middleEllipsis(text, head, tail) {
    var s = String(text || '');
    if (s.length <= head + tail + 1) { return s; }
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }

  /// 写保存位置。值存在隐藏 input 里（提交时要原始路径），显示的是省略过的版本。
  function setDlcDir(dir) {
    var value = dir ? String(dir) : '';
    var input = document.getElementById('dlc-dir');
    if (input) { input.value = value; }
    var view = document.getElementById('dlc-path');
    if (view) {
      view.textContent = value ? middleEllipsis(value, 20, 34) : tr('还没选保存位置');
      view.title = value;
      view.classList.toggle('empty', !value);
    }
  }

  function getDlcDir() {
    var input = document.getElementById('dlc-dir');
    return input ? input.value.trim() : '';
  }

  function closeDownloadConfirm() {
    document.getElementById('dlc-modal').classList.add('hidden');
    dlcItem = null;
    dlcVersion = null;
  }

  /// 打开系统目录选择框，选中后写回保存位置。
  function chooseSaveDirectory() {
    if (!apiBase()) {
      toast(tr('壳模式下才能弹目录选择框'));
      return;
    }
    apiCall('chooseDirectory', ['选择保存位置']).then(function (value) {
      var dir = value ? String(value) : '';
      if (dir) { setDlcDir(dir); }
    });
  }

  function confirmDownload() {
    var item = dlcItem;
    var v = dlcVersion;
    if (!item || !v) { return; }

    if (adType === 'modpack') {
      var name = document.getElementById('dlc-name2').value.trim();
      closeDownloadConfirm();
      closeAddonVersions();
      call('installModpackRemote', item.slug, v.versionId, item.iconUrl || '', name);
      toast(tf('开始下载整合包「{0}」', item.title));
      return;
    }

    var dir = getDlcDir();
    var fileName = document.getElementById('dlc-name').value.trim();
    var instId = AD_INSTANCE_TYPES[adType] ? adInstId() : '';

    if (!dir) {
      // 没选位置就别开始：默认落到游戏根目录会让人找不到下到哪儿去了
      chooseSaveDirectory();
      return;
    }

    closeDownloadConfirm();
    closeAddonVersions();
    // 传填在框里的那个目录。有实例时它就是实例目录（后端算好推过来的），
    // 用户点「更改…」换过之后也能生效——原来这里写的是 instId ? '' : dir，
    // 把用户的更改直接丢掉了。
    call('addonInstall', adType, item.slug, v.versionId, instId, fileName, dir);
    toast(tf('开始下载「{0}」', item.title + ' ' + (v.version || v.versionId)));
  }

  /// 本地导入：File 对象直接当 fetch 的 body 传上去，Java 侧流式落盘。
  /// 不走 base64 —— 几百 MB 的整合包转成字符串会把内存吃光。
  function importLocalAddon() {
    // 整合包走「系统对话框 + 直接给后端路径」：不要经过 HTTP 上传，
    // 一个几百 MB 的包上传等于白拷两份。装完由后端推任务进度。
    if (adType === 'modpack') {
      call('pickModpackFile');
      return;
    }
    var kind = adType === 'world' ? 'world'
      : adType === 'shader' ? 'shader'
        : adType === 'resourcepack' ? 'resourcepack' : 'modpack';

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.mrpack';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) { return; }
      uploadLocalAddon(kind, f);
    });
    input.click();
  }

  function uploadLocalAddon(kind, file) {
    if (!apiBase()) {
      toast(tr('本地导入只在壳模式可用'));
      return;
    }

    var url = apiEndpoint('/api/upload/' + kind, {
      name: file.name,
      instanceId: adInstId()
    });

    toast(tr('正在上传 ') + file.name + '（' + Math.round(file.size / 1048576) + ' MB）…');

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { toast(tr('上传失败：') + ((j && j.error) || '未知错误'), 'error'); }
      })
      .catch(function (e) { toast(tr('上传失败：') + e, 'error'); });
  }

  // ---------------- 外观页 ----------------

  var apData = null;
  var apTab = 'skin';
  var serverCapes = null;
  /// 上一次外观数据属于哪个账号。切账号时要靠它把 serverCapes 丢掉 ——
  /// 那份列表是「某个账号的披风」，不是全局的。
  var apAccountUuid = '';
  var ctxMenu = null;

  function closeCtx() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }

  // ---------------- 前端 3D 预览（壳模式） ----------------
  //
  // JavaFX WebView 下的预览是 Java 侧渲染成 PNG 推过来的静态图：拖一次视角要等
  // 一轮重绘，待机摆动靠 500ms 定时截图。换成 Tauri 壳后 WebView2 有 WebGL，
  // 直接在前端用 skinview3d 渲染，拖拽是即时的，后端也不用再空转。
  //
  // 只在壳模式启用（window.__HMCL_SHIM__ 存在）；JavaFX 那边继续走后端出图。

  var viewer = null;
  var viewerFailed = false;
  /// 各标签页「第一次拖拽之前」的机位。controls.reset() 不能用 —— 它还原的是
  /// OrbitControls 构造那一瞬间的位置，那时 skinview3d 还没把相机拉到合适距离，
  /// restore 出来会怼到脸上。所以自己记一份稳定的。
  ///
  /// 按标签页分开存：皮肤页的原位是正面、披风页是背面 3/4。只记一份的话，
  /// 在披风页点复位会转回正面，披风直接看不见了。
  var viewerHomeByTab = {};

  /// 用户在预览框上滚出来的缩放倍数。
  /// 100% 就是「整个人填满预览框」那个取景，滚轮最远放到 150%、最小收到 50%。
  /// 这里存的是相对 100% 的倍数，实际取景由 frameViewer 换算。
  var USER_ZOOM = 1;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 1.5;
  /// 100% 时人物占框高的比例。0.75 = 头顶留一指、脚底也留一指，
  /// 整个人完整落在框里，四周都有余量。50%/150% 档位是相对它的倍数。
  var BASE_FILL = 0.75;

  function wantsFrontend3d() {
    return !viewerFailed && !!window.skinview3d && !!window.__HMCL_SHIM__;
  }

  /// 画布该多大：**内容区**尺寸，不是 clientWidth/Height。
  ///
  /// clientWidth 含 padding。之前直接拿它当画布宽高，画布比内容区大一圈，
  /// `.preview-slot` 又是 overflow:hidden，结果下半身被裁掉、人物看着偏下。
  function previewSize() {
    var slot = document.getElementById('preview-slot');
    if (!slot) { return { w: 320, h: 400 }; }
    var cs = getComputedStyle(slot);
    var padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var w = Math.round(slot.clientWidth - padX);
    var h = Math.round(slot.clientHeight - padY);
    return { w: Math.max(160, w), h: Math.max(200, h) };
  }

  function ensureViewer() {
    if (viewer) { return viewer; }
    if (!wantsFrontend3d()) { return null; }

    var canvas = document.getElementById('ap-preview-3d');
    if (!canvas) { return null; }

    var size = previewSize();
    try {
      viewer = new window.skinview3d.SkinViewer({
        canvas: canvas,
        width: size.w,
        height: size.h
      });
    } catch (e) {
      // WebGL 不可用（远程桌面、显卡驱动异常）就退回后端的 PNG
      console.error('[3d] 初始化失败，回退到后端预览', e);
      viewerFailed = true;
      canvas.hidden = true;
      return null;
    }

    document.getElementById('ap-preview').hidden = true;
    canvas.hidden = false;
    // 留个调试口子：自动化测试要读相机/包围盒，不靠截图目测。
    // 只是个只读引用，不影响运行。
    window.__skinViewer = viewer;

    viewer.autoRotate = false;
    try { viewer.zoom = 0.9; } catch (ignored) {}
    if (viewer.controls) {
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
      viewer.controls.enableRotate = true;
      // 别让视角转到脚底或头顶
      viewer.controls.minPolarAngle = Math.PI * 0.28;
      viewer.controls.maxPolarAngle = Math.PI * 0.72;
    }
    // 用户转过视角就记在这个标签名下，之后这个标签不再自动摆位
    if (viewer.controls && viewer.controls.addEventListener) {
      // 第一次按下鼠标那一刻把机位存下来当「原位」。OrbitControls 的 reset()
      // 不能用 —— 它还原的是构造那一瞬间的位置，那时相机还没拉到合适距离，
      // 恢复出来会怼到脸上（实测 7.7 而不是正常的 49.7）。
      viewer.controls.addEventListener('start', function () {
        if (!viewerHomeByTab[apTab]) {
          viewerHomeByTab[apTab] = {
            pos: viewer.camera.position.clone(),
            target: viewer.controls.target.clone()
          };
        }
      });
      viewer.controls.addEventListener('end', function () {
        var yaw = currentViewerYaw();
        if (yaw !== null) { tabYaw[apTab] = yaw; }
      });
    }
    // 轻微待机摆动，比完全静止自然
    try { viewer.animation = new window.skinview3d.IdleAnimation(); } catch (ignored) {}

    window.addEventListener('resize', resizeViewer);

    // 左栏宽度随窗口变（rail 展开/收起也会变），窗口 resize 事件抓不到这些变化
    if (window.ResizeObserver) {
      window.__slotObserver = new ResizeObserver(function () {
        resizeViewer();
        frameViewer();
      });
      window.__slotObserver.observe(document.getElementById('preview-slot'));
    }

    bindPreviewZoom();
    frameViewer();
    return viewer;
  }

  /// 3D 视角：皮肤页看正面，披风页转到背面。
  ///
  /// 后端也有一套同样的逻辑（previewYaw），但它是给 JavaFX 那边渲染 PNG 用的；
  /// 壳模式的 3D 是前端 skinview3d 画的，后端那张图直接丢掉，所以这里必须自己转——
  /// 不然在披风页选了一件，预览还是正面，用户根本看不到披在背后的是什么。
  /// 每个标签页各自记一份视角。切标签时不再把相机拽回默认值——
  /// 之前就是这样，用户转到侧面看一眼、切个标签再回来，角度全丢了，
  /// 看起来像「3D 预览被重置了」。两个标签本来就共用同一块 canvas 和同一个 viewer。
  var tabYaw = { skin: 0, cape: null };   // null = 这个标签还没定过视角

  function currentViewerYaw() {
    var v = viewer;
    if (!v || !v.camera || !v.controls) { return null; }
    var t = v.controls.target || { x: 0, y: 0, z: 0 };
    var dx = v.camera.position.x - t.x;
    var dz = v.camera.position.z - t.z;
    return Math.atan2(dx, dz);
  }

  function setViewerYaw(radians) {
    var v = viewer;
    if (!v || !v.camera) { return; }
    var controls = v.controls;
    var target = (controls && controls.target) ? controls.target : { x: 0, y: 0, z: 0 };
    var dx = v.camera.position.x - target.x;
    var dz = v.camera.position.z - target.z;
    var radius = Math.sqrt(dx * dx + dz * dz);
    if (!radius) { return; }
    v.camera.position.x = target.x + Math.sin(radians) * radius;
    v.camera.position.z = target.z + Math.cos(radians) * radius;
    v.camera.lookAt(target.x, target.y, target.z);
    if (controls && controls.update) { controls.update(); }
  }

  function resizeViewer() {
    if (!viewer) { return; }
    var size = previewSize();
    if (Math.abs(viewer.width - size.w) > 2 || Math.abs(viewer.height - size.h) > 2) {
      viewer.width = size.w;
      viewer.height = size.h;
    }
  }

  /// 把人物摆到视野正中，并按框高留白缩放。
  ///
  /// 两个坑：
  /// 1. skinview3d 的相机固定看向原点，而人物模型的**脚底**在原点——
  ///    直接渲染人整体偏上，4:5 的竖框里头顶被切掉。这里按几何包围盒
  ///    把人物中心挪到原点（重复调用是幂等的，位置累加量自然为 0）。
  /// 2. 默认 zoom 下身高占框高约 94%，几乎顶满。缩到 ~72%，
  ///    和右边那些皮肤卡片的小人视觉重量才对得上。
  function frameViewer() {
    var v = viewer;
    if (!v || !v.playerObject || !v.camera) { return; }
    // 页面切走时容器是 0×0，这时候取景算出来的是垃圾值，
    // 切回来又不会自动纠正，等于把缩放弄坏
    if (!v.width || !v.height) { return; }
    try {
      v.playerObject.updateWorldMatrix(true, true);

      var minY = Infinity, maxY = -Infinity;
      v.playerObject.traverse(function (o) {
        if (!o.isMesh || !o.geometry) { return; }
        // 耳朵（deadmau5 那种）会高出头顶 5 个单位、还伸出两侧，
        // 算进去人物就会被整体上推，看着不居中。取景只按身体算。
        // 盔甲同理：它比皮肤大一圈，算进去会让「穿甲」比「不穿」小一号，
        // 同一个角色切来切去尺寸会跳。
        if (/ear/i.test(o.name || '')) { return; }
        if (/^armor/i.test(o.name || '')) { return; }
        o.geometry.computeBoundingBox();
        var bb = o.geometry.boundingBox.clone();
        bb.applyMatrix4(o.matrixWorld);
        if (bb.min.y < minY) { minY = bb.min.y; }
        if (bb.max.y > maxY) { maxY = bb.max.y; }
      });
      if (!isFinite(minY) || !isFinite(maxY) || maxY <= minY) { return; }

      // 盔甲比皮肤大一圈（头盔顶 +1、靴底 -1）。取景不把盔甲算进包围盒
      // （否则穿脱时尺寸会跳），但这里补上那 1 格余量：
      // 不然穿甲时头盔顶贴边、靴子探出框外，看着像被裁了。
      minY -= 1;
      maxY += 1;

      // 几何中心落到原点。包围盒是带当前位移算出来的，所以这一步可以反复做
      var center = (minY + maxY) / 2;
      v.playerObject.position.y -= center;
      var bottom = minY - center;
      var top = maxY - center;

      // 目标占框高 = 基准 50% × 用户缩放。
      //
      // **不能**拿「实测占用 × 倍数」反复逼近：那等于假设 zoom 和占高成正比，
      // 而库里的相机距离是 d = A + K/zoom（带一个固定偏移），高倍时差得远，
      // 迭代会来回震荡——表现就是滚一下大一下，再点一下又变小。
      // 这里直接从物理关系解出来：
      //   占高比例 = H / (2·d·tan(fov/2))  ⇒  d = H / (2·tan(fov/2)·目标)
      // d 与 zoom 的 A/K 两个常数不硬编码，现场取两个点拟合，换库版本也不会错。
      var TARGET = BASE_FILL * USER_ZOOM;
      var height = top - bottom;
      var halfTan = Math.tan(v.camera.fov * Math.PI / 360);
      var dNeeded = height / (2 * halfTan * TARGET);

      var z1 = 1, z2 = 2;
      v.zoom = z1;
      var d1 = v.camera.position.length();
      v.zoom = z2;
      var d2 = v.camera.position.length();

      var solved = z1;
      if (d1 > 0 && d2 > 0 && Math.abs(d1 - d2) > 1e-6) {
        // d = A + K/zoom
        var K = (d1 - d2) / (1 / z1 - 1 / z2);
        var A = d1 - K / z1;
        var denom = dNeeded - A;
        solved = Math.abs(denom) < 1e-6 ? z1 : K / denom;
        if (!isFinite(solved) || solved <= 0) { solved = z1; }
      }
      v.zoom = Math.min(64, Math.max(0.05, solved));
    } catch (e) {
      console.warn('[3d] 取景失败', e);
    }
  }

  /// 预览框上的滚轮缩放。
  ///
  /// 不用 skinview3d 自带的 controls.zoom——那个是连续值，没法钉死 25%/300%，
  /// 也没法保证 100% 对应「占框高一半」。这里自己记倍数，取景统一由 frameViewer 算。
  function bindPreviewZoom() {
    var slot = document.getElementById('preview-slot');
    if (!slot || slot.dataset.zoomBound) { return; }
    slot.dataset.zoomBound = '1';

    slot.addEventListener('wheel', function (e) {
      if (!viewer) { return; }
      e.preventDefault();
      // 触控板一次事件可能带很大的 deltaY，按方向只走一档，手感更稳
      var step = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setUserZoom(USER_ZOOM * step);
    }, { passive: false });

    // 双击复位：滚歪了不用一点点滚回来
    slot.addEventListener('dblclick', function () {
      if (!viewer) { return; }
      setUserZoom(1);
    });
  }

  function setUserZoom(next) {
    var clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (Math.abs(clamped - USER_ZOOM) < 0.001) { return; }
    USER_ZOOM = clamped;
    frameViewer();
    showZoomBadge();
  }

  var zoomBadgeTimer = null;

  function showZoomBadge() {
    var badge = document.getElementById('preview-zoom');
    if (!badge) { return; }
    badge.textContent = Math.round(USER_ZOOM * 100) + '%';
    badge.hidden = false;
    badge.classList.add('on');
    clearTimeout(zoomBadgeTimer);
    zoomBadgeTimer = setTimeout(function () {
      badge.classList.remove('on');
      // 等淡出动画结束再真正藏起来
      setTimeout(function () { if (!badge.classList.contains('on')) { badge.hidden = true; } }, 220);
    }, 900);
  }

  function findAsset(list, id) {
    if (!list || !id) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  // ---------------- 盔甲预览 ----------------
  //
  // 皮肤站那套（blessing-skin-server 里的 skinview3d 3.x）只画皮肤、披风、鞘翅，
  // 没有盔甲模型，所以这里自己补：`vendor/skinview3d.bundle.js` 是
  // `tools/skinview3d-armor` 那个打了盔甲层的本地构建，几何按 **1.21.1** 的
  // HumanoidArmorLayer 摆（头盔/胸甲/靴子外扩 1px，护腿 0.5px，手臂只到上臂）。
  //
  // 贴图是 1.21.1 客户端的原版图层，内置在 `img/armor/` 下。四个部位各一个下拉，
  // 可以混搭（头盔钻石 + 胸甲皮革 + 护腿铁 + 靴子金），默认全都不穿。

  var ARMOR_DIR = 'img/armor/';

  /// 四个装备槽，顺序就是界面上的排列顺序
  var ARMOR_SLOTS = [
    { id: 'helmet', label: '头盔' },
    { id: 'chest', label: '胸甲' },
    { id: 'legs', label: '护腿' },
    { id: 'boots', label: '靴子' }
  ];

  /// 能穿的材质。`only` 表示只有这个槽能用（海龟壳只做头盔，贴图也只有头盔那一块）。
  /// `item` 是物品图标的前缀：金在游戏里叫 golden，跟贴图名 gold 不一样。
  var ARMOR_MATERIALS = [
    // 皮革的物品图标在游戏里是靠染料色染上去的（贴图本身是灰度），
    // 直接显示原图会是一张白图，所以准备了 *_dyed.png
    { id: 'leather', name: '皮革', item: 'leather', dye: true },
    { id: 'chainmail', name: '锁链', item: 'chainmail' },
    { id: 'iron', name: '铁', item: 'iron' },
    // 铜盔甲是 1.21.9 才有的，1.21.1 的客户端里没有这套图层 ——
    // 贴图和图标是拿铁的按亮度映射成铜色生成的（见 AGENT.md）
    { id: 'copper', name: '铜', item: 'copper' },
    { id: 'gold', name: '金', item: 'golden' },
    { id: 'diamond', name: '钻石', item: 'diamond' },
    { id: 'netherite', name: '下界合金', item: 'netherite' },
    { id: 'turtle', name: '海龟壳', item: 'turtle', only: 'helmet' }
  ];

  /// 槽位到物品图标后缀的映射（护腿在游戏里叫 leggings）
  var ARMOR_ITEM_SUFFIX = {
    helmet: 'helmet',
    chest: 'chestplate',
    legs: 'leggings',
    boots: 'boots'
  };

  /// 四个槽当前穿的材质，空串表示没穿。不再用 <select>：
  /// 图标比下拉直观，而且能一眼看出哪个部位还空着。
  var armorSel = { helmet: '', chest: '', legs: '', boots: '' };
  /// 盔甲总开关。默认关：大多数人只是看皮肤，一进来先套四个空框没必要；
  /// 关着的时候四件装备完全不参与渲染，格子也不出现
  var armorOn = false;
  /// 弹窗当前在给哪个槽选
  var armorPickSlot = null;

  /// 某个材质在某槽的物品图标路径
  function armorItemIcon(mat, slot) {
    return 'img/item/' + mat.item + '_' + ARMOR_ITEM_SUFFIX[slot]
      + (mat.dye ? '_dyed' : '') + '.png';
  }

  /// 皮革在游戏里可染色：基础图层是灰度，要乘上染料色（默认这个棕）
  var LEATHER_COLOR = '#a06540';

  var armorImages = null;
  var armorImagesLoading = null;
  /// 鞘翅自己的贴图（灰紫那对翅膀）；披风里没带鞘翅图案时才用它
  var elytraImage = null;
  /// 上一次套上去的组合，形如 "helmet:iron,chest:diamond"
  var viewerArmorSig = null;

  function loadImageEl(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /// 各材质的图层 + 皮革染色遮罩 + 一张鞘翅图，第一次用到时一次读完。
  /// 海龟壳只有 layer_1，别去请求不存在的 layer_2（会 404）。
  function ensureArmorImages() {
    if (armorImages) { return Promise.resolve(armorImages); }
    if (armorImagesLoading) { return armorImagesLoading; }

    armorImagesLoading = Promise.all(ARMOR_MATERIALS.map(function (mat) {
      var id = mat.id;
      var layer1 = loadImageEl(ARMOR_DIR + id + '_layer_1.png');
      var layer2 = id === 'turtle'
        ? Promise.resolve(null)
        : loadImageEl(ARMOR_DIR + id + '_layer_2.png');
      var overlay = id === 'leather'
        ? loadImageEl(ARMOR_DIR + 'leather_layer_1_overlay.png')
        : Promise.resolve(null);
      return Promise.all([layer1, layer2, overlay]).then(function (imgs) {
        return [id, { l1: imgs[0], l2: imgs[1], overlay: imgs[2] }];
      });
    })).then(function (pairs) {
      var out = {};
      pairs.forEach(function (p) { if (p[1].l1) { out[p[0]] = p[1]; } });
      armorImages = out;
      armorImagesLoading = null;
      return loadImageEl(ARMOR_DIR + 'elytra.png');
    }).then(function (img) {
      elytraImage = img;
      return armorImages;
    });
    return armorImagesLoading;
  }

  /// 皮革染色：灰度底 × 染料色，再盖一层遮罩（拉链、缝线那些细节）。
  ///
  /// `multiply` 会把透明区域也涂上颜色，所以接着用 `destination-in`
  /// 拿底图的 alpha 当遮罩裁回来 —— 顺序反了边缘会多出一圈实色。
  function leatherArmorCanvas(base, overlay) {
    var w = base.naturalWidth || base.width || 64;
    var h = base.naturalHeight || base.height || 32;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0, w, h);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = LEATHER_COLOR;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(base, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    if (overlay) { ctx.drawImage(overlay, 0, 0, w, h); }
    return c;
  }

  /// 取某个槽要用的图：护腿用 layer_2，其余用 layer_1；皮革现染一次后缓存。
  function armorTextureFor(materialId, slot) {
    var real = armorImages && armorImages[materialId];
    if (!real) { return null; }
    if (materialId === 'leather') {
      if (slot === 'legs') {
        if (!real._inner) { real._inner = leatherArmorCanvas(real.l2 || real.l1, real.overlay); }
        return real._inner;
      }
      if (!real._outer) { real._outer = leatherArmorCanvas(real.l1, real.overlay); }
      return real._outer;
    }
    return slot === 'legs' ? (real.l2 || real.l1) : real.l1;
  }

  /// 四个槽当前的组合，用来判断要不要重画 —— 每次 syncViewer 都重画
  /// 会重建纹理，画面会闪一下。
  function armorSignature() {
    if (!armorOn) { return 'off'; }
    var parts = [];
    for (var i = 0; i < ARMOR_SLOTS.length; i++) {
      var id = ARMOR_SLOTS[i].id;
      if (armorSel[id]) { parts.push(id + ':' + armorSel[id]); }
    }
    return parts.join(',');
  }

  /// 盔甲开关的按钮态跟着 armorOn 走（syncViewer 每次都会调一次）。
  function renderArmorSeg() {
    var seg = document.getElementById('armor-seg');
    if (!seg) { return; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var on = (btns[i].getAttribute('data-armor') === 'on') === armorOn;
      btns[i].classList.toggle('active', on);
    }
  }

  /// 把四个槽的当前选择套到 viewer 上。
  function applyArmor(v) {
    if (!v) { return; }
    if (!armorImages) {
      // 图还没读完：读完再画一次，用户不用再点
      ensureArmorImages().then(function () { if (v === viewer) { applyArmor(v); } });
      return;
    }
    var parts = {};
    for (var i = 0; i < ARMOR_SLOTS.length; i++) {
      var slot = ARMOR_SLOTS[i].id;
      var id = armorSel[slot];
      // 没选的槽也要显式给 null，否则上一次穿的还挂在身上；
      // 总开关关掉时一律 null —— 这就是「关掉就真的不渲染」
      parts[slot] = (armorOn && id) ? armorTextureFor(id, slot) : null;
    }
    try {
      v.loadArmors(parts);
    } catch (e) {
      console.error('[3d] 盔甲加载失败', e);
    }
  }

  /// 把四个槽的当前选择画到格子上：穿了就显示物品图标 + 实线框，
  /// 没穿显示虚线框和「空」字（和「无登录账号」那个头像占位是同一套视觉）。
  function renderArmorCells() {
    var cells = document.querySelectorAll('#ap-armor-row .armor-cell');
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var slot = cell.getAttribute('data-slot');
      var img = cell.querySelector('img');
      var empty = cell.querySelector('.ac-empty');
      var mat = null;
      for (var j = 0; j < ARMOR_MATERIALS.length; j++) {
        if (ARMOR_MATERIALS[j].id === armorSel[slot]) { mat = ARMOR_MATERIALS[j]; break; }
      }
      if (mat) {
        img.src = armorItemIcon(mat, slot);
        img.hidden = false;
        if (empty) { empty.hidden = true; }
        cell.classList.add('on');
        cell.title = ARMOR_SLOTS[i].label + '：' + mat.name;
      } else {
        img.hidden = true;
        if (empty) { empty.hidden = false; }
        cell.classList.remove('on');
        // 悬停提示只留部位名，别带操作说明 —— 格子的虚线边框已经说明可以点了
        cell.title = ARMOR_SLOTS[i].label;
      }
    }
  }

  /// 贴着槽位弹出的小浮层：列出这个槽能穿的所有材质，第一格是「无」。
  ///
  /// 不做成全屏对话框 —— 换一件甲只是想看一眼效果，盖住 3D 预览反而没法判断。
  function openArmorPicker(slot, anchor) {
    armorPickSlot = slot;
    var label = '装备';
    for (var i = 0; i < ARMOR_SLOTS.length; i++) {
      if (ARMOR_SLOTS[i].id === slot) { label = ARMOR_SLOTS[i].label; }
    }
    var title = document.getElementById('armor-pick-title');
    if (title) { title.textContent = label; }

    var grid = document.getElementById('armor-pick-grid');
    var pop = document.getElementById('armor-picker');
    if (!grid || !pop) { return; }
    grid.innerHTML = '';

    // 「无」：和图标的 26px 同尺寸的虚线空框
    var none = el('button', 'armor-pop-item' + (armorSel[slot] ? '' : ' on'));
    none.appendChild(el('span', 'apn-empty', '无'));
    none.appendChild(el('span', 'apn', '不穿'));
    none.addEventListener('click', function () { pickArmor(''); });
    grid.appendChild(none);

    for (var j = 0; j < ARMOR_MATERIALS.length; j++) {
      var mat = ARMOR_MATERIALS[j];
      if (mat.only && mat.only !== slot) { continue; }
      (function (m) {
        var item = el('button', 'armor-pop-item' + (armorSel[slot] === m.id ? ' on' : ''));
        var img = document.createElement('img');
        img.src = armorItemIcon(m, slot);
        img.alt = m.name;
        item.appendChild(img);
        item.appendChild(el('span', 'apn', m.name));
        item.addEventListener('click', function () { pickArmor(m.id); });
        grid.appendChild(item);
      })(mat);
    }

    // 先显示再量尺寸，否则 offsetWidth/Height 都是 0
    pop.hidden = false;
    placeArmorPicker(anchor);
  }

  /// 把浮层摆在槽位正下方；下面放不下就翻到上面，再夹在视口内。
  function placeArmorPicker(anchor) {
    var pop = document.getElementById('armor-picker');
    if (!pop || !anchor) { return; }
    var r = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth;
    var ph = pop.offsetHeight;
    var gap = 8;

    var left = r.left + r.width / 2 - pw / 2;
    var top = r.bottom + gap;
    // 四个格子贴在最下面，弹层要往上翻 —— 侧栏高度不够时也不会被窗口裁掉
    if (top + ph > window.innerHeight - 8) {
      top = r.top - ph - gap;
    }
    if (top < 8) { top = 8; }
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));

    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }

  function closeArmorPicker() {
    var pop = document.getElementById('armor-picker');
    if (pop) { pop.hidden = true; }
    armorPickSlot = null;
  }

  function pickArmor(materialId) {
    if (!armorPickSlot) { return; }
    armorSel[armorPickSlot] = materialId || '';
    renderArmorCells();
    applyArmor(viewer);
    closeArmorPicker();
  }

  /// 格子的点击、浮层的关闭，只绑一次。
  function initArmorCells() {
    var cells = document.querySelectorAll('#ap-armor-row .armor-cell');
    for (var i = 0; i < cells.length; i++) {
      (function (cell) {
        cell.addEventListener('click', function (e) {
          var pop = document.getElementById('armor-picker');
          // 再点同一个格子就是收起，不用先点空白处
          if (pop && !pop.hidden && armorPickSlot === cell.getAttribute('data-slot')) {
            closeArmorPicker();
            return;
          }
          openArmorPicker(cell.getAttribute('data-slot'), cell);
          e.stopPropagation();
        });
      })(cells[i]);
    }

    // 点浮层以外的地方收起。用 mousedown 而不是 click：
    // click 要等鼠标抬起，中间拖动选择文字也会触发，手感发飘。
    document.addEventListener('mousedown', function (e) {
      var pop = document.getElementById('armor-picker');
      if (!pop || pop.hidden) { return; }
      if (pop.contains(e.target)) { return; }
      if (e.target.closest && e.target.closest('.armor-cell')) { return; }
      closeArmorPicker();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeArmorPicker(); }
    });
    // 滚动、改窗口大小时位置就失效了，直接收起来，免得贴错地方
    window.addEventListener('resize', function () { closeArmorPicker(); });
    var body = document.getElementById('page-body');
    if (body) { body.addEventListener('scroll', function () { closeArmorPicker(); }, true); }

    renderArmorCells();
  }

  /// 动作状态：站着还是走起来。skinview3d 自带 WalkingAnimation，
  /// 皮肤站（Viewer.tsx）也是拿它切换的 —— 只是它做成了循环 4 种动画的按钮，
  /// 这里只要「站立 / 行走」两态，看得清就够了。
  var skinAnim = 'idle';

  function applyAnimation(v) {
    if (!v) { return; }
    var S = window.skinview3d;
    if (!S) { return; }
    try {
      var isWalk = S.WalkingAnimation && v.animation instanceof S.WalkingAnimation;
      var isIdle = S.IdleAnimation && v.animation instanceof S.IdleAnimation;

      if (skinAnim === 'walk') {
        if (!isWalk) {
          v.animation = new S.WalkingAnimation();
        }
        v.animation.speed = 0.7;
        return;
      }

      // 「站立」不是完全静止：游戏里站着的时候手臂会随呼吸轻微摆动，
      // skinview3d 的 IdleAnimation 就是做这个的（手臂绕 z 轴 ±0.03 弧度，
      // 顺带让披风轻轻飘）。皮肤站的四态循环里也包含它。
      if (!isIdle) {
        // 从行走切回来时腿还停在迈步的中间姿势，先复位一次再交给 idle ——
        // IdleAnimation 只管手臂和披风，不动腿。
        if (isWalk && v.playerObject && typeof v.playerObject.resetJoints === 'function') {
          v.playerObject.resetJoints();
        }
        if (S.IdleAnimation) {
          v.animation = new S.IdleAnimation();
        } else {
          v.animation = null;
        }
      }
    } catch (e) { /* 老 bundle 没有动画类就当不支持 */ }
  }

  function renderAnimSeg() {
    var seg = document.getElementById('anim-seg');
    if (!seg) { return; }
    var row = document.getElementById('ap-anim-row');
    // 只有能真跑动画时才露出这组按钮：JavaFX 模式是后端渲的 PNG，
    // 点了也没反应，不如藏起来
    seg.hidden = false;
    if (row) { row.hidden = false; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-anim') === skinAnim;
      btns[i].classList.toggle('active', on);
    }
  }

  /// 后背装备。游戏里「鞘翅」和「披风」共用同一张贴图，只是换了个模型 ——
  /// skinview3d 把这件事做成 `playerObject.backEquipment` 上的一个开关，
  /// 皮肤站（blessing-skin-server）的 Viewer.tsx 也是这么切的。
  var backEquipment = 'cape';

  /// 披风贴图里自带鞘翅图案吗？
  ///
  /// 鞘翅模型用的是 64x32 贴图上的 x=22..46 / y=0..24 这一条（skinview3d 的
  /// `setCapeUVs(box, 22, 0, 10, 20, 2)`：左右各 2px 侧面 + 10px 正面 + 10px 背面）。
  /// 披风本体只用 0..22，所以这块只要被画满，就说明这张图是「披风 + 鞘翅」的合并图。
  ///
  /// 之前这里只测了 (22,0) 起 10x20 的一小块，而实际翅膀图案画在 x 31..45 ——
  /// 正好落在检测框外面，所以自带鞘翅的披风一直被当成「没有鞘翅」。
  function capeHasElytraArt(v) {
    try {
      var c = v.capeCanvas;
      if (!c || !c.width || !c.height) { return false; }
      // 检测框只罩「翅膀实际会画到的那一块」：x 28..46、y 0..22。
      // 不取整个 UV 区（22..46）：披风本体的右边缘会溢进来，把普通披风
      // 误判成自带鞘翅；也不取 24..46，那样翅膀只占 15%，和噪声太接近。
      var sx = Math.round(28 * c.width / 64);
      var sy = 0;
      var sw = Math.max(1, Math.round(18 * c.width / 64));
      var sh = Math.max(1, Math.round(22 * c.height / 32));
      var data = c.getContext('2d').getImageData(sx, sy, sw, sh).data;
      var hits = 0;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] > 8) { hits++; }
      }
      // 翅膀是斜着铺的，中间还有透明缝隙，实测这张「披风+鞘翅」合并图是 20.4%。
      // 阈值取 10%：够低，翅膀画得稀疏也能认出来；又够高，普通披风在这一块
      // 几乎是全空的（实测 Migration 披风整块只有个位数像素），不会误判。
      return hits >= (data.length / 4) * 0.10;
    } catch (e) {
      return false;
    }
  }

  /// 把鞘翅图案补到「正反两面」。
  ///
  /// 原版 elytra.png 只把翅膀画在 UV 的背面那块（64x32 坐标里 x 36..46），
  /// 正面（x 24..34）是空的 —— 因为游戏里玩家永远从背后看翅膀，正面看不见。
  /// 但预览可以随便转，转过去就是一张透明的空翅膀，看着像「里面被掏空了」。
  ///
  /// 这里量一下两面的不透明像素，把有内容的那面贴到另一面上。翅膀是轴对称的，
  /// 镜像一下看不出区别；披风本体只用 x 0..22，碰不到。
  /// 鞘翅贴图只保留背面那一块。
  ///
  /// 原版鞘翅是**三面包的薄壳**：只有外表面有图，内侧是空的。之前这里做了两件
  /// 多余的事，都跟官方对不上：
  ///
  /// 1. 把正面（内表面）也补满 —— 内侧多出一层皮，从侧面看像给翅膀套了个壳；
  /// 2. 把侧面和底面的边缘像素铺过去 —— 那圈 UV 在模型上对应的是**颈部和披风
  ///    连接处**，不是鞘翅的底面。铺上图案之后，脖子后面会凭空多出一截蓝色条纹。
  ///
  /// 现在只清正面，别的都不动。翅膀就是一张单面薄片，和游戏里看到的一致。
  ///
  /// （函数名沿用旧名字，调用方不用改。）
  function mirrorElytra(canvas) {
    if (!canvas || !canvas.width || !canvas.height) { return canvas; }
    try {
      var w = canvas.width;
      var h = canvas.height;
      var out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      var ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, 0, 0);

      // 64x32 基准下的 UV：正面 24..34、背面 36..46，纵向 2..22
      var fw = Math.round(10 * w / 64);
      var fh = Math.round(20 * h / 32);
      var y = Math.round(2 * h / 32);
      var fx = Math.round(24 * w / 64);

      // 正面 = 内表面，清空。背面那块的图原样留着，不动。
      ctx.clearRect(fx, y, fw, fh);
      return out;
    } catch (e) {
      // 跨域画布读不了像素就原样返回
      return canvas;
    }
  }

  /// 当前应该用哪张图给鞘翅，返回已经补好两面的 canvas（或 null 表示不换）。
  function elytraCanvasFor(v) {
    if (backEquipment !== 'elytra') { return null; }
    var base = capeHasElytraArt(v) && v.capeCanvas ? v.capeCanvas : elytraImage;
    if (!base) { return null; }
    return mirrorElytra(base);
  }

  function applyBackEquipment(v, hasCape) {
    if (!v || !v.playerObject) { return; }
    try {
      // 没披风就什么都不该挂在背上：`resetCape()` 已经把 cape/elytra 两张
      // map 都清成 null，这时候再把 backEquipment 设成 'elytra'（或 'cape'），
      // 网格会带着空贴图渲染出来 —— 材质没有 map 就是纯白，
      // 看到的就是一条 1 像素宽的白边。所以这里必须设 null。
      if (!hasCape) {
        v.playerObject.backEquipment = null;
        return;
      }
      if (v.loadElytra) {
        // 披风自带鞘翅图案就用披风那张，否则用内置的灰紫翅膀；
        // 两张都过一遍 mirrorElytra —— 原版只画了背面，正面是透的
        v.loadElytra(elytraCanvasFor(v));
      }
      // 注意 loadCape 每次都会把 backEquipment 重置成 cape，
      // 所以换完披风要再喊一次，不然用户选的鞘翅会被打回披风
      v.playerObject.backEquipment = backEquipment;
    } catch (e) { /* 老 bundle 没这个属性就当没有 */ }
  }

  /// 两个按钮在**皮肤页和披风页都显示**（页面上都能转到背面看效果），
  /// 但前提是真的戴着披风：没披风就没有贴图，切鞘翅只会得到两只白板翅膀。
  ///
  /// `hasArt` 表示这件披风的贴图里画了鞘翅图案（合并图）。为真时在「鞘翅」
  /// 按钮上点一个小圆点 —— 不然用户看不出这件披风切过去是不是原版图案。
  function renderBackSeg(hasCape, hasArt) {
    var seg = document.getElementById('back-seg');
    if (!seg) { return; }
    var show = !!hasCape && wantsFrontend3d();
    seg.hidden = !show;
    var row = document.getElementById('ap-back-row');
    if (row) { row.hidden = !show; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute('data-back');
      btns[i].classList.toggle('active', key === backEquipment);
      if (key === 'elytra') {
        btns[i].classList.toggle('has-art', !!hasArt);
        btns[i].title = hasArt
          ? '这件披风自带鞘翅图案，切过去用它自己的'
          : '这件披风没有鞘翅图案，用内置的原版鞘翅';
      }
    }
  }

  /// 把 data URL 先解码成 <img>，再把 Image 交给 skinview3d。
  ///
  /// 直接传字符串时，skinview3d 内部要自己 new Image 等 onload；而它拿到结果后的
  /// 第一步是 `rc()` —— 里面 `clearRect` 之后才 `drawImage`，那段时间 skinCanvas
  /// 是空的，紧接着又 dispose 旧纹理重建。表现出来就是换皮肤那一下模型白闪。
  ///
  /// 传 HTMLImageElement 时它是同步 drawImage + 重建纹理，一帧内完成，看不到空窗。
  /// 解码失败就退回原路径，不能因为一张坏图把预览卡死。
  function loadSkinSmooth(v, src, model) {
    var apply = function (arg) {
      if (v !== viewer) { return; }
      try { v.loadSkin(arg, { model: model }); } catch (e) { console.error('[3d] loadSkin', e); }
    };
    var img = new Image();
    img.onload = function () { apply(img); };
    img.onerror = function () { apply(src); };
    img.src = src;
  }

  /// 披风同理。返回 Promise：调用方要等它画进 capeCanvas 再量鞘翅范围。
  function loadCapeSmooth(v, src) {
    if (!src) {
      try { return Promise.resolve(v.loadCape(null)); } catch (e) { return Promise.resolve(); }
    }
    return new Promise(function (resolve) {
      var img = new Image();
      var apply = function (arg) {
        if (v !== viewer) { resolve(); return; }
        try { resolve(v.loadCape(arg)); } catch (e) { resolve(); }
      };
      img.onload = function () { apply(img); };
      img.onerror = function () { apply(src); };
      img.src = src;
    });
  }

  function syncViewer() {
    var v = ensureViewer();
    if (!v || !apData) { return; }

    var state = apData.state || {};
    var skin = findAsset(apData.skins, state.skin);
    var cape = findAsset(apData.capes, state.cape);

    // 没选自定义皮肤就穿账号自带那张。
    // 后端在「没有本地皮肤但有账号纹理」时会把 state.skin 报成 null，
    // findAsset 因此返回 null，接下去就落到 accountSkinRaw 上。
    var skinSrc = (skin && skin.raw) || apData.accountSkinRaw || null;

    // 模型：state.model 是用户在「宽体/纤体」里手动选的那个，优先级最高。
    // 之前这里先看 asset.model，导致点了切换没反应——内置皮肤自带 model，
    // 把用户的选择盖掉了。
    var model;
    if (state.model === 'slim') { model = 'slim'; }
    else if (state.model === 'default' || state.model === 'wide') { model = 'classic'; }
    else if (skin && skin.model === 'slim') { model = 'slim'; }
    else { model = 'classic'; }

    // 披风来源分三种：
    //   - 本地资产（离线 / 外置认证，或者正版用户从本地列表里选的）
    //   - 正版账号的服务器披风：不在 apData.capes 里，得从 serverCapes 或账号纹理里取
    //   - 明确不戴
    var capeSrc = (cape && cape.raw) ? cape.raw : null;
    if (!capeSrc && apData.kind === 'microsoft') {
      var pending = apData.pendingServerCape;
      var list = serverCapes || [];
      if (pending === '') {
        capeSrc = null;                       // 用户明确摘掉了
      } else if (pending) {
        for (var ci = 0; ci < list.length; ci++) {
          if (list[ci].id === pending) { capeSrc = list[ci].raw || null; break; }
        }
        // 目标那件的展开图还没到手（列表是异步一张张推的）。这时候不能就
        // 这么空着——点了切换却看到模型上光秃秃一片，比显示旧图还吓人。
        // 后端在 selectServerCape 时已经把选中那件的图塞进 accountCapeRaw 了。
        if (!capeSrc) { capeSrc = apData.accountCapeRaw || null; }
      } else {
        // 没动过：用账号当前装备的那件。纹理还没到就先留空，
        // onCapePreview / onAppearance 到货后会再同步一次
        for (var cj = 0; cj < list.length; cj++) {
          if (list[cj].active && list[cj].raw) { capeSrc = list[cj].raw; break; }
        }
        if (!capeSrc) { capeSrc = apData.accountCapeRaw || null; }
      }
    }

    // 「看鞘翅」的归位判断放在 capeSrc 定稿之后，而且只在**确实没有披风**时才做。
    //
    // 两处坑：
    // 1. 原来这段写在服务器披风分支前面。正版账号的披风不在 apData.capes 里，
    //    每次 syncViewer 都先判成「没披风」，把鞘翅打回披风 —— 切皮肤/披风标签、
    //    数据一刷新就横跳一次。
    // 2. 光挪位置还不够：刚点了一件披风、纹理还在路上时 capeSrc 也是 null，
    //    按它判照样会打回披风。所以这里看的是「用户到底有没有披风」，
    //    不是「这一帧算不算得出图」。
    var reallyNoCape;
    if (apData.kind === 'microsoft') {
      var pend = apData.pendingServerCape;
      // pending === ''：用户明确摘掉了。null：没动过，看服务器有没有装备中的
      reallyNoCape = pend === ''
        ? true
        : (pend === null || pend === undefined)
          ? !(serverCapes || []).some(function (c) { return c.active; })
          : false;
    } else {
      reallyNoCape = !state.cape;
    }
    if (reallyNoCape) { backEquipment = 'cape'; }

    // 只有贴图或模型真的变了才重新加载。
    // skinview3d 的 loadSkin 每调一次都会重新建纹理，切宽体/纤体这种只改参数的操作
    // 再走一遍就会让 3D 区域闪白一下。
    var skinChanged = (skinSrc !== viewerSkinSrc) || (model !== viewerSkinModel);

    if (skinChanged && skinSrc) {
      viewerSkinSrc = skinSrc;
      viewerSkinModel = model;
      loadSkinSmooth(v, skinSrc, model);
    }

    if (capeSrc !== viewerCapeSrc) {
      viewerCapeSrc = capeSrc;
      var capeLoaded = loadCapeSmooth(v, capeSrc);
      // 传字符串时 loadCape 返回 Promise（内部 new Image 异步解码）。
      // 必须等它真的画进 capeCanvas 再量鞘翅区和套纹理，否则量到的是上一张
      // 披风的内容 —— 表现就是「换了披风，小圆点和翅膀要再切一次页才更新」。
      Promise.resolve(capeLoaded).then(function () {
        if (v !== viewer) { return; }
        applyBackEquipment(v, !!capeSrc);
        // 按钮用「有没有披风」判，不用「这一帧有没有图」——
        // 换披风时纹理解码要几十毫秒，按图判会让整排按钮闪一下
        renderBackSeg(!reallyNoCape, !!capeSrc && capeHasElytraArt(v));
      });
    } else {
      applyBackEquipment(v, !!capeSrc);
      renderBackSeg(!reallyNoCape, !!capeSrc && capeHasElytraArt(v));
    }

    // 内置贴图是本地文件，第一次进来先把它们读进内存
    ensureArmorImages();

    // 盔甲和皮肤/披风都是独立的材质槽，换皮肤不会把它冲掉，
    // 所以只在四件装备的组合变了时才重画
    // JavaFX 模式是后端渲染的静态 PNG，套不上盔甲，开关也一起收掉
    var armorRow = document.getElementById('ap-armor-row');
    if (armorRow) { armorRow.hidden = !armorOn || !wantsFrontend3d(); }
    var armorSwitchRow = document.getElementById('ap-armor-on-row');
    if (armorSwitchRow) { armorSwitchRow.hidden = !wantsFrontend3d(); }
    renderArmorSeg();
    var sig = armorSignature();
    if (sig !== viewerArmorSig) {
      viewerArmorSig = sig;
      applyArmor(v);
    }

    // 动作状态：站立 / 行走。放在取景之前，先让手脚摆到位再算画面
    applyAnimation(v);
    renderAnimSeg();

    // 披风页第一次进来转到背面 3/4，皮肤页转正；之后各用各记住的角度。
    // 没有披风时披风页也保持正面——转过去只会看到后脑勺。
    var yaw = tabYaw[apTab];
    if (yaw === null || yaw === undefined) {
      yaw = (apTab === 'cape' && capeSrc) ? Math.PI * 0.85 : 0;
      tabYaw[apTab] = yaw;
    }
    setViewerYaw(yaw);

    resizeViewer();
    // 取景只需要在模型变化（包围盒跟着变）时重算；
    // 换皮肤贴图不改包围盒，重算会让画面跳一下
    if (model !== viewerFramedModel) {
      viewerFramedModel = model;
      frameViewer();
    }
  }

  /// 上一次喂给 3D 预览的皮肤 / 模型 / 披风。用来判断要不要真的重新加载。
  var viewerSkinSrc = null;
  var viewerSkinModel = null;
  var viewerCapeSrc = null;
  var viewerFramedModel = null;
  /// 上一次套上的盔甲材质。undefined 表示还没套过（空串 = 明确不穿）
  var viewerArmor;

  function renderAppearance(data) {
    apData = data || apData;
    if (!apData) { return; }
    // Gson 默认不输出 null 字段，`pendingServerCape` 为 null 时整条就没了，
    // 读出来是 undefined，而下面各处判的是 `=== null`：结果「无披风」和「已装备」
    // 都不高亮，列表里一个 current 都没有。统一在这里补回 null。
    if (apData.pendingServerCape === undefined) { apData.pendingServerCape = null; }
    var kind = apData.kind || 'none';
    var readOnly = !!apData.readOnly;

    // 模型 / 背饰开关
    var model = (apData.state && apData.state.model) === 'slim' ? 'slim' : 'default';
    var segs = document.querySelectorAll('#model-seg button');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('active', segs[i].getAttribute('data-model') === model);
    }

    // 没有账号时「应用到账号」也没意义，一并禁用（否则点了只会得到一个空 promise）。
    // 没有未保存的修改时也禁用：这时候点它什么都不会发生，留着反而让人以为点了没反应。
    var cannotApply = readOnly || kind === 'none';
    var dirty = !!apData.dirty;
    var applyBtn = document.getElementById('ap-apply');
    applyBtn.disabled = cannotApply || !dirty;
    applyBtn.classList.toggle('primary', dirty && !cannotApply);
    applyBtn.classList.toggle('ghost', !dirty);
    document.getElementById('ap-import').disabled = readOnly;

    var hint = document.getElementById('ap-hint');
    if (kind === 'none') {
      hint.textContent = tr('先在账号页登录一个账号。');
    } else if (kind === 'authlib') {
      hint.textContent = tr('外置认证账号的外观由平台管理，这里只做预览，请前往对应平台修改。');
    } else {
      hint.textContent = '';
    }

    renderAssetGrid();
    syncViewer();
  }

  function assetCard(opts) {
    var card = el('div', 'asset-card' + (opts.current ? ' current' : ''));

    // 缩略图槽：固定高度，图片按原比例等比放进去（皮肤 16:32，披风 10:16）
    var well = el('div', 'asset-well');
    if (opts.emptyFrame) {
      well.appendChild(el('div', 'asset-empty-frame'));
    } else if (opts.glyph) {
      var glyph = el('div', 'asset-glyph');
      glyph.innerHTML = opts.glyph;
      well.appendChild(glyph);
    } else {
      var img = document.createElement('img');
      if (opts.preview) { img.src = opts.preview; }
      else { img.className = 'asset-placeholder'; }
      well.appendChild(img);
    }
    if (opts.badges && opts.badges.length) {
      var badges = el('div', 'asset-badges');
      opts.badges.forEach(function (b) { badges.appendChild(el('span', 'tag', b)); });
      well.appendChild(badges);
    }
    card.appendChild(well);

    // 底部一行：单选圆点 + 名称，和官方账号管理页的披风列表同一个信息结构
    var foot = el('div', 'asset-foot');
    foot.appendChild(el('span', 'asset-radio'));
    foot.appendChild(el('span', 'asset-name', opts.name || '未命名'));
    card.appendChild(foot);

    if (opts.id) { card.setAttribute('data-asset-id', opts.id); }
    // 记住这张卡自带的模型，切换选中态时要按它回填角标
    card.setAttribute('data-asset-model', opts.model || 'default');

    card.addEventListener('click', function (e) {
      e.stopPropagation();
      closeCtx();
      if (opts.onSelect) { opts.onSelect(); }
    });

    if (opts.onContext) {
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showCtx(e.clientX, e.clientY, opts.onContext);
      });
    }
    return card;
  }

  /// 右键菜单的全局关闭：点空白、按 Esc、窗口失焦都收起来。
  /// 只绑一次，用 captured mousedown——它在 click 之前触发，
  /// 点菜单项时会被 closest('.ctx') 挡下来。
  var ctxDismissBound = false;
  function bindCtxDismiss() {
    if (ctxDismissBound) { return; }
    ctxDismissBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!ctxMenu) { return; }
      if (e.target.closest('.ctx')) { return; }
      closeCtx();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (ctxMenu && e.key === 'Escape') { closeCtx(); }
    }, true);
    window.addEventListener('blur', closeCtx);
  }

  function showCtx(x, y, actions) {
    closeCtx();
    bindCtxDismiss();
    var menu = el('div', 'ctx');
    actions.forEach(function (action) {
      var btn = el('button', action.danger ? 'danger' : '', action.label);
      btn.addEventListener('click', function () {
        closeCtx();
        action.run();
      });
      menu.appendChild(btn);
    });
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);
    ctxMenu = menu;
  }

  /// 皮肤网格的结构签名。
  ///
  /// 只有「有哪些卡」变了才值得重建 DOM——选中态变化不算。
  /// 重建会把每张卡的 base64 预览图重新解码一遍，点一下别的皮肤整页闪一下
  /// 就是这么来的。
  var assetGridKey = '';

  function assetGridSignature() {
    if (!apData) { return ''; }
    var kind = apData.kind;
    var ids = [];
    if (apTab === 'skin') {
      if (kind === 'authlib' || kind === 'microsoft') { ids.push('__account__'); }
      (apData.skins || []).forEach(function (s) { ids.push(s.id + ':' + (s.name || '')); });
      return 'skin|' + kind + '|' + ids.join(',');
    }
    // 披风
    if (kind === 'microsoft') {
      ids.push('__none__');
      // 服务器披风是异步拉来的，列表到没到、有没有装备都影响卡片，一并进签名
      if (serverCapes === null) {
        ids.push('srv:pending');
      } else {
        ids.push('srv:' + serverCapes.map(function (c) {
          return c.id + (c.active ? '+' : '');
        }).join('.'));
      }
    } else if (kind === 'authlib') {
      ids.push('__account__');
    } else {
      ids.push('__none__');
      (apData.capes || []).forEach(function (c) { ids.push(c.id + ':' + (c.name || '')); });
    }
    return 'cape|' + kind + '|' + ids.join(',');
  }

  /// 只更新选中态和角标，不动 DOM 结构
  function syncAssetSelection() {
    var grid = document.getElementById('asset-grid');
    if (!grid || !apData) { return; }
    var state = apData.state || {};
    var kind = apData.kind;
    var cards = grid.querySelectorAll('.asset-card');

    // 披风这边的「当前」不是简单比 id：正版账号还要看 pending 和服务器下发的 active
    var pending = apData.pendingServerCape;
    var serverList = serverCapes || [];
    var serverHasActive = serverList.some(function (c) { return c.active; });
    var serverNoneSelected = pending === '' ? true : (pending === null && !serverHasActive);

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var id = card.getAttribute('data-asset-id');
      var isCurrent;

      if (apTab === 'skin') {
        var isAccount = id === '__account__';
        isCurrent = isAccount ? !state.skin : (state.skin === id);
      } else if (kind === 'microsoft') {
        if (id === '__none__') {
          isCurrent = serverNoneSelected;
        } else {
          var hit = null;
          for (var j = 0; j < serverList.length; j++) {
            if (serverList[j].id === id) { hit = serverList[j]; break; }
          }
          isCurrent = pending === null ? !!(hit && hit.active) : pending === id;
        }
      } else if (kind === 'authlib') {
        isCurrent = true;
      } else {
        isCurrent = id === '__none__' ? !state.cape : (state.cape === id);
      }

      card.classList.toggle('current', isCurrent);

      // 「账号当前皮肤 / 披风」的缩略图是异步到手的：卡片早就画好了，
      // 图晚几秒才来。以前这里只改选中态不改图，于是卡片一直挂着初次渲染时
      // 那张兜底皮肤（橙发绿衣），和右边 3D 里的真皮肤对不上。
      if (id === '__account__') {
        var accPreview = apTab === 'skin' ? apData.accountSkin : apData.accountCape;
        var accImg = card.querySelector('.asset-well img');
        if (accImg && accPreview && accImg.getAttribute('src') !== accPreview) {
          accImg.src = accPreview;
          accImg.classList.remove('asset-placeholder');
        }
      }

      // 皮肤卡角标跟「当前实际用的模型」走：选中那张显示 state.model，其余显示自带值
      if (apTab === 'skin' && id !== '__account__') {
        var badge = card.querySelector('.asset-badges .tag');
        if (badge) {
          var base = card.getAttribute('data-asset-model') || 'default';
          var shown = (isCurrent && state.model) ? state.model : base;
          badge.textContent = shown === 'slim' ? '纤体' : '宽体';
        }
      }
    }
  }

  /// 披风库卡片的右键菜单。刷新重拉的是「账号持有哪些披风」，
  /// 不是贴图 —— Mojang 发了新披风，本地不清 profile 缓存就看不到。
  var REFRESH_CAPE_ITEM = {
    label: '刷新账号披风',
    run: function () { call('refreshAccountCape'); }
  };

  /// 「导出纹理」菜单项。
  ///
  /// 两种来源分开走：本地资产有 id，后端直接复制原始文件（不重编码）；
  /// 正版账号的服务器皮肤/披风本地没有文件，只有页面上那张 dataUrl 缩略图，
  /// 交给后端落临时文件再导出。id 以 `__` 开头的是界面上的虚拟卡片。
  function exportItem(kind, id, preview, serverCape) {
    return {
      label: '导出纹理',
      run: function () {
        // 正版账号的服务器披风：本地只有缩略图，得让后端按 id 去拿原图
        if (serverCape) {
          call('exportServerCape', id);
          return;
        }
        if (id && id.indexOf('__') !== 0) {
          call('exportTexture', kind, id);
          return;
        }
        if (!preview) {
          toast('这张图还没加载出来，等缩略图显示后再试', 'error');
          return;
        }
        call('exportTextureData', preview, kind === 'cape' ? 'cape' : 'skin');
      }
    };
  }

  /// 把导出项放到菜单最前面。原来的菜单项照旧跟在后面。
  ///
  /// 不传 `items` 时返回只有导出项的菜单 —— 内置皮肤（Steve / Alex）
  /// 和只读账号的卡片就是这样：不能改名不能删，但纹理本身仍然导得出来。
  function withExport(kind, id, preview, items, serverCape) {
    var list = (items || []).slice();
    list.unshift(exportItem(kind, id, preview, serverCape));
    return list;
  }

  function renderAssetGrid() {
    var grid = document.getElementById('asset-grid');
    if (!apData) {
      grid.innerHTML = '';
      assetGridKey = '';
      return;
    }

    var sig = assetGridSignature();
    if (sig && sig === assetGridKey) {
      // 卡片没变，只改选中态——不重建，不闪
      syncAssetSelection();
      return;
    }
    // 只有第一次画这个网格才播入场动画。每次重建都重放的话，
    // 在披风列表里点一下会看到整排卡片依次淡入，比「刷新」还晃眼。
    var firstPaint = !assetGridKey;
    assetGridKey = sig;
    grid.innerHTML = '';

    // 资产区标题：给出「现在在看什么、有多少」，避免一堆卡片悬空在页面上
    var headLabel = document.getElementById('asset-head-label');
    var headCount = document.getElementById('asset-head-count');
    if (headLabel) {
      headLabel.textContent = apTab === 'skin' ? '皮肤库' : '披风';
    }
    if (headCount) {
      // 数「实际显示出来的卡片」而不是后端给的资产数：
      // 正版账号的披风来自服务器列表，本地 capes 是空的，照旧的算法会写成「披风 2 项」
      var n;
      if (apTab === 'skin') {
        n = (apData.skins || []).length;
        if (apData.kind === 'authlib' || apData.kind === 'microsoft') { n += 1; }
      } else if (apData.kind === 'microsoft') {
        n = (serverCapes || []).length + 1;   // 「无披风」也算一张
      } else {
        n = (apData.capes || []).length + 1;
      }
      headCount.textContent = n > 0 ? n + tr(' 项') : '';
    }

    var kind = apData.kind;
    var readOnly = !!apData.readOnly;
    var state = apData.state || {};

    if (apTab === 'skin') {
      var skins = apData.skins || [];
      if (kind === 'authlib' || kind === 'microsoft') {
        grid.appendChild(assetCard({
          id: '__account__',
          name: '账号当前皮肤',
          preview: apData.accountSkin,
          badges: ['服务器'],
          current: !state.skin,
          onSelect: function () { call('selectSkin', ''); },
          // 服务器皮肤 24 小时才自动同步一次（省两次网络往返），官网换了皮肤
          // 想立刻看到就走这里。外置认证的皮肤由平台管，没有刷新这回事。
          onContext: withExport('skin', '__account__', apData.accountSkinRaw,
            kind === 'microsoft'
              ? [{ label: '刷新服务器皮肤', run: function () { call('refreshAccountSkin'); } }]
              : [])
        }));
      }
      skins.forEach(function (s) {
        // 角标要跟「当前实际用的模型」一致：选中的那张卡显示 state.model
        // （用户手动切的宽体/纤体），没选中的卡才显示它自带的推荐值。
        // 之前一律读 s.model，切了纤体角标还是「宽体」，跟上面开关和 3D 都对不上。
        var isCurrent = state.skin === s.id;
        var shownModel = (isCurrent && state.model) ? state.model : s.model;
        grid.appendChild(assetCard({
          id: s.id,
          model: s.model,
          name: s.name,
          preview: s.preview,
          badges: [shownModel === 'slim' ? '纤体' : '宽体'].concat(s.builtin ? ['内置'] : []),
          current: isCurrent,
          onSelect: function () { call('selectSkin', s.id); },
          // 内置皮肤（原版 Steve / Alex）不给重命名和删除入口，但纹理本身导得出来
          onContext: withExport('skin', s.id, s.preview, s.builtin || readOnly ? [] : [
            { label: '重命名', run: function () {
                askName('重命名皮肤', s.name).then(function (name) {
                  if (name) { call('renameSkin', s.id, name); }
                });
              } },
            { label: '删除', danger: true, run: function () { call('removeSkin', s.id); } }
          ])
        }));
      });
      if (!skins.length && kind === 'offline') {
        grid.appendChild(el('div', 'empty', '还没有导入皮肤，点右上角「导入文件」。'));
      }
      document.getElementById('ap-tip').textContent = '';
    } else {
      var pending = apData.pendingServerCape;
      var capes = apData.capes || [];

      // 「不戴披风」不是「还没选」——它是一等选项，永远排在第一位

      if (kind === 'microsoft') {
        var list = serverCapes || [];
        var hasActive = list.some(function (c) { return c.active; });
        var noneSelected = pending === ''
          ? true
          : (pending === null && !hasActive);

        grid.appendChild(assetCard({
          id: '__none__',
          name: '无披风',
          emptyFrame: true,
          current: noneSelected,
          onSelect: function () { call('selectServerCape', ''); },
          // 空格子也给个刷新入口：新披风到手时用户不一定已经有「已装备」那件
          onContext: [REFRESH_CAPE_ITEM]
        }));

        if (!serverCapes) {
          var capeLoad = el('div', 'empty');
          capeLoad.appendChild(loadingRow('正在从 Mojang 拉取披风列表…'));
          grid.appendChild(capeLoad);
          call('requestServerCapes');
        } else if (!list.length) {
          grid.appendChild(el('div', 'empty', '这个账号没有可用披风。'));
        } else {
          list.forEach(function (c) {
            var current = pending === null ? !!c.active : pending === c.id;
            grid.appendChild(assetCard({
              id: c.id,
              name: c.name,
              preview: c.preview || null,
              badges: c.active ? ['已装备'] : [],
              current: current,
              onSelect: function () { call('selectServerCape', c.id); },
              onContext: withExport('cape', c.id, c.preview, [REFRESH_CAPE_ITEM], true)
            }));
          });
        }
        document.getElementById('ap-tip').textContent = '';
      } else if (kind === 'authlib') {
        grid.appendChild(assetCard({
          id: '__account__',
          name: '账号当前披风',
          preview: apData.accountCape,
          badges: ['服务器'],
          current: true,
          onContext: withExport('cape', '__account__', apData.accountCapeRaw, [])
        }));
        document.getElementById('ap-tip').textContent =
          '外置认证账号的披风由平台管理，这里只做预览。';
      } else {
        grid.appendChild(assetCard({
          id: '__none__',
          name: '无披风',
          emptyFrame: true,
          current: !state.cape,
          onSelect: function () { call('selectCape', ''); }
        }));

        capes.forEach(function (c) {
          grid.appendChild(assetCard({
            id: c.id,
            name: c.name,
            preview: c.preview,
            current: state.cape === c.id,
            onSelect: function () { call('selectCape', c.id); },
            onContext: withExport('cape', c.id, c.preview, readOnly ? [] : [
              { label: '重命名', run: function () {
                  askName('重命名披风', c.name).then(function (name) {
                    if (name) { call('renameCape', c.id, name); }
                  });
                } },
              { label: '删除', danger: true, run: function () { call('removeCape', c.id); } }
            ])
          }));
        });

        if (!capes.length) {
          grid.appendChild(el('div', 'empty', '还没有导入披风，点右上角「导入文件」。'));
        }
        // 这句说明用户明确要求删掉：占位框上已经写着「还没有导入披风」，
        // 再补一段长解释属于重复
        document.getElementById('ap-tip').textContent = '';
      }
    }
    if (firstPaint) { stagger(grid); }
  }

  /// 复位预览机位。
  ///
  /// 两条渲染路径分开处理：3D 模式（skinview3d）直接调它的 resetCamera；
  /// PNG 模式（JavaFX 出的图）把后端「用户转过视角」的标记清掉，
  /// refreshPreview 会重新按当前标签页算默认角度 —— 皮肤看正面、披风看背面。
  /// 复位预览机位。
  ///
  /// 拖拽转的是 OrbitControls 的相机，`controls.reset()` 就是干这个的 ——
  /// three.js 在构造时存了一份初始机位（position0 / target0），reset 会还原。
  /// 别指望 `viewer.resetCamera()`：这个 bundle 里没有那个方法，写了也是空转。
  ///
  /// 另一半是给 JavaFX 模式的：把后端「用户转过视角」的标记清掉，
  /// refreshPreview 会重新按标签页算默认角度（皮肤正面、披风背面 3/4）。
  /// 复位预览机位。
  ///
  /// 拖拽转的是 OrbitControls 的相机，`controls.reset()` 就是干这个的 ——
  /// three.js 在构造时存了一份初始机位（position0 / target0），reset 会还原。
  /// 别指望 `viewer.resetCamera()`：这个 bundle 里没有那个方法，写了也是空转。
  ///
  /// 另一半是给 JavaFX 模式的：把后端「用户转过视角」的标记清掉，
  /// refreshPreview 会重新按标签页算默认角度（皮肤正面、披风背面 3/4）。
  function resetPreviewView() {
    try {
      if (viewer) {
        var home = viewerHomeByTab[apTab];
        if (home) {
          // 这一页拖过：回到那之前的机位（皮肤页是正面，披风页是背面 3/4）
          viewer.camera.position.copy(home.pos);
          if (viewer.controls && viewer.controls.target) {
            viewer.controls.target.copy(home.target);
            viewer.controls.update();
          }
        } else {
          // 这一页还没拖过，但可能缩放过、上下拖过：把水平角摆回该有的方向，
          // 再让 frameViewer 重新算一遍距离
          var yaw = (apTab === 'cape' && viewerCapeSrc) ? Math.PI * 0.85 : 0;
          tabYaw[apTab] = yaw;
          setViewerYaw(yaw);
          frameViewer();
        }
        if (viewer.render) { viewer.render(); }
      }
    } catch (e) { /* 3D 没起来就交给后端那条路 */ }
    call('resetPreviewCamera');
  }

  function initPreviewDrag() {
    var img = document.getElementById('ap-preview');
    if (!img) { return; }

    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var pending = 0;

    img.addEventListener('mousedown', function (e) {
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) { return; }
      var dx = e.screenX - lastX;
      lastX = e.screenX;
      lastY = e.screenY;
      pending += dx;
      if (Math.abs(pending) < 2) { return; }
      call('rotatePreview', pending, 0);
      pending = 0;
    });

    window.addEventListener('mouseup', function () { dragging = false; });
  }

  function sendPreviewRect() {
    var slot = document.getElementById('preview-slot');
    if (!slot) { return; }
    var r = slot.getBoundingClientRect();

    // 预览区滚出可视范围时先藏起来，否则画布会浮在别的内容上面
    var visible = r.bottom > 0 && r.top < window.innerHeight && r.width > 1;
    call('setPreviewRect', visible ? r.left : 0, visible ? r.top : 0,
        visible ? r.width : 0, visible ? r.height : 0);
  }

  var previewRectTimer = null;

  function schedulePreviewRect() {
    if (previewRectTimer) { return; }
    previewRectTimer = setTimeout(function () {
      previewRectTimer = null;
      if (document.getElementById('page-appearance').classList.contains('active')) {
        sendPreviewRect();
      }
    }, 40);
  }

  function showAppearance() {
    var raw = call('appearance');
    if (raw) {
      try { renderAppearance(JSON.parse(raw)); } catch (e) { console.error(e); }
    }
    sendPreviewRect();
  }

  function initAppearance() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var all = document.querySelectorAll('.tab');
        for (var j = 0; j < all.length; j++) { all[j].classList.remove('active'); }
        this.classList.add('active');
        apTab = this.getAttribute('data-tab');
        call('setAppearanceTab', apTab);
        if (apTab === 'cape' && apData && apData.kind === 'microsoft') { call('requestServerCapes'); }
        renderAssetGrid();
        // 壳模式下 3D 在前端，切完标签得自己同步一次视角和贴图
        syncViewer();
      });
    }

    // 「应用到账号」：这个按钮以前压根没绑事件，点了完全没反应。
    // 真正的落盘/上传在 Java 侧 applyAppearance（离线=存本地，正版=上传，外置=提示去平台）
    var applyBtn = document.getElementById('ap-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        if (this.disabled) { return; }
        call('applyAppearance');
      });
    }

    // 复位机位：平时几乎看不见，鼠标放上去才亮起来
    var resetView = document.getElementById('ap-reset-view');
    if (resetView) {
      resetView.addEventListener('click', function () { resetPreviewView(); });
    }

    var modelBtns = document.querySelectorAll('#model-seg button');
    for (var m = 0; m < modelBtns.length; m++) {
      modelBtns[m].addEventListener('click', function () {
        call('setSkinModel', this.getAttribute('data-model'));
      });
    }

    // 披风 / 鞘翅：只换模型，贴图用的还是同一张披风
    var backSeg = document.getElementById('back-seg');
    if (backSeg) {
      backSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-back]') : null;
        if (!btn) { return; }
        backEquipment = btn.getAttribute('data-back');
        applyBackEquipment(viewer, true);
        renderBackSeg(true, !!(viewer && viewer.capeCanvas) && capeHasElytraArt(viewer));
        // 图还没读完的话，读完再套一次（第一次进外观页就切鞘翅时会碰到）
        if (!elytraImage) {
          ensureArmorImages().then(function () { applyBackEquipment(viewer, true); });
        }
      });
    }

    // 盔甲：格子和弹窗。纯前端的事，不落后端配置，也不记上次的选择 ——
    // 只是看效果用的，每次进来都是干净的一身。
    initArmorCells();

    // 盔甲总开关：和模型 / 动作 / 披风同一套 seg，关着的时候格子收起来、身上也不挂甲
    var armorSeg = document.getElementById('armor-seg');
    if (armorSeg) {
      armorSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-armor]') : null;
        if (!btn) { return; }
        armorOn = btn.getAttribute('data-armor') === 'on';
        renderArmorSeg();
        var row = document.getElementById('ap-armor-row');
        if (row) { row.hidden = !armorOn; }
        applyArmor(viewer);
        // 手动改完把签名同步掉，避免 syncViewer 里再重画一次（会闪）
        viewerArmorSig = armorSignature();
      });
    }

    // 动作：站立 / 行走。和皮肤站那套一致，直接换 viewer.animation。
    var animSeg = document.getElementById('anim-seg');
    if (animSeg) {
      animSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-anim]') : null;
        if (!btn) { return; }
        skinAnim = btn.getAttribute('data-anim') === 'walk' ? 'walk' : 'idle';
        applyAnimation(viewer);
        renderAnimSeg();
      });
    }

    // 导入文件。走页面自己的 <input type="file">，不调 Java 侧的 FileChooser——
    // 壳模式没有 JavaFX 窗口，那个对话框根本弹不出来，点了会毫无反应。
    // 读成 dataUrl 交给 Java，两边模式（WebView / WebView2）都能用。
    document.getElementById('ap-import').addEventListener('click', function () {
      if (this.disabled) { return; }
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) { return; }
        var reader = new FileReader();
        reader.onload = function () {
          call(apTab === 'cape' ? 'importCapeData' : 'importSkinData',
               String(reader.result), file.name);
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsDataURL(file);
        document.body.removeChild(input);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // ---------------- 设置页：顶部分区导航 ----------------

  var settingsAnchors = ['set-launcher', 'set-appearance', 'set-java', 'set-game', 'set-network', 'set-about'];
  // 点击跳转后，平滑滚动的每一帧都会触发 scroll 事件，会把高亮改回「途经的那个分区」。
  // 锁一段时间，等滚动停下来再交还给滚动监听。
  var anchorLockUntil = 0;
  // 当前高亮的分区。切页回来要靠它把滚动位置复原，
  // 否则会出现「标签写着关于、画面停在启动器设置」这种两边对不上的情况。
  var settingsAnchor = settingsAnchors[0];

  function setActiveAnchor(id) {
    var nav = document.getElementById('settings-nav');
    if (!nav) { return; }
    settingsAnchor = id;
    var btns = nav.querySelectorAll('button[data-anchor]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-anchor') === id);
    }
  }

  function scrollToAnchor(id) {
    var body = document.getElementById('page-body');
    var target = document.getElementById(id);
    if (!body || !target) { return; }
    // 用 rect 差值算，而不是 offsetTop——那个依赖定位祖先，换个布局就错。
    // 偏移量按吸顶导航的实际高度算：写死 70 时改一下字号或图标就会错位。
    var nav = document.getElementById('settings-nav');
    var offset = (nav ? nav.getBoundingClientRect().height : 62) + 10;
    var delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    var top = body.scrollTop + delta - offset;
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    anchorLockUntil = Date.now() + 700;
    setActiveAnchor(id);
  }

  /// 滚动时高亮当前所在的板块
  function updateActiveAnchor() {
    if (Date.now() < anchorLockUntil) { return; }
    var body = document.getElementById('page-body');
    if (!body) { return; }
    // #page-body 是所有页面共用的滚动容器，在主页 / 下载页滚一下同样会触发这里。
    // 设置页不可见时它那六个 section 的 rect 全是 0，逐个比下去会把高亮判成
    // 最后一格「关于」，还会把 settingsAnchor 一起带歪 —— 切回来就滚到底。
    var page = document.getElementById('page-settings');
    if (!page || !page.classList.contains('on')) { return; }
    var line = body.getBoundingClientRect().top + 90;
    var current = settingsAnchors[0];
    for (var i = 0; i < settingsAnchors.length; i++) {
      var sec = document.getElementById(settingsAnchors[i]);
      if (sec && sec.getBoundingClientRect().top <= line) { current = settingsAnchors[i]; }
    }
    setActiveAnchor(current);
  }

  /// 切回设置页时把滚动位置对齐到高亮的那一格。
  ///
  /// go() 切页一律把滚动容器归零（全站统一回顶），设置页的分区导航却是
  /// 滚动锚点式的 —— 高亮留在「关于」，画面停在最顶上的「启动器设置」，
  /// 上下就对不上了。这里按高亮位置滚一次，让两边说的是同一件事。
  function restoreSettingsAnchor() {
    var body = document.getElementById('page-body');
    if (!body) { return; }
    var id = settingsAnchor || settingsAnchors[0];
    // 停在第一格就不用动：go() 已经把 scrollTop 归零了，
    // 再算一遍反而会因为吸顶高度差出几像素。
    if (id === settingsAnchors[0]) { return; }
    var target = document.getElementById(id);
    if (!target) { return; }
    var nav = document.getElementById('settings-nav');
    var offset = (nav ? nav.getBoundingClientRect().height : 62) + 10;
    var delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
    body.scrollTop = Math.max(0, body.scrollTop + delta - offset);
    // 这个位置是程序设的，不是用户滚出来的。锁一下，别让紧跟着的 scroll
    // 事件把高亮挪到「视野里正好压线的那一格」—— 点的是关于就得停在关于，
    // 哪怕这一节贴着页底、滚不到导航下面。
    anchorLockUntil = Date.now() + 400;
  }

  function initSettings() {
    var nav = document.getElementById('settings-nav');
    var body = document.getElementById('page-body');
    if (!nav || !body) { return; }

    nav.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-anchor]');
      if (!btn) { return; }
      scrollToAnchor(btn.getAttribute('data-anchor'));
    });

    body.addEventListener('scroll', updateActiveAnchor, { passive: true });

    initDownloadSettings();
    initSettingsControls();

    // JavaFX 模式同步拿得到；壳模式返回 null，结果走 onSettings
    var raw = call('getSettings');
    if (raw) { window.__hmcl.onSettings(raw); }
    call('requestJavaList');
  }

  /// 把下载源同步到下载页工具栏上的两个下拉（游戏版本 / 模组各一个）。
  ///
  /// 它们和设置里那两个是同一个配置，只是放了个快捷入口 —— 装版本前想切镜像
  /// 不用先翻到设置页。
  function applyDownloadSourceToPage(value) {
    // 只管「游戏版本」那个下拉。模组那边选的是平台（Modrinth / CurseForge），
    // 跟官方源/镜像源不是一个维度，同步过去只会显示成牛头不对马嘴的值。
    var v = (value === 'default' || !value) ? 'official' : value;
    var sel = document.getElementById('dl-source');
    if (!sel) { return; }
    if (sel.value !== v) { sel.value = v; }
    if (csRegistry['dl-source']) { csRegistry['dl-source'].rebuild(); }
  }

  /// 「下载与网络」那一组：两个源下拉 + 线程数。
  function initDownloadSettings() {
    enhanceSelect(document.getElementById('set-version-source'));
    enhanceSelect(document.getElementById('set-file-source'));

    // 下载页上的快捷下拉：一次把「版本清单」和「文件」两个源都切了。
    // BMCLAPI 两个都镜像、官方两个都直连，分开设反而容易配出不匹配的组合。
    var dlSource = document.getElementById('dl-source');
    if (dlSource) {
      enhanceSelect(dlSource);
      dlSource.addEventListener('change', function () {
        var v = this.value;
        call('setDownloadSource', 'version', v);
        call('setDownloadSource', 'file', v);
        applyDownloadSourceToPage(v);
      });
    }

    // 内容平台（Modrinth / CurseForge）：目前只接了 Modrinth。
    // CurseForge 没配 API Key 时把选项禁掉，别让用户切过去搜出一片空白。
    var adSource = document.getElementById('ad-source');
    if (adSource) {
      enhanceSelect(adSource);
      // 和类别 / 实例 / 排序一样登记成定宽下拉（宽度见 app.css 的 .ad-sel）
      var srcWrap = adSource.closest('.cs-wrap');
      if (srcWrap) {
        srcWrap.classList.add('ad-sel');
        srcWrap.setAttribute('data-ad-sel', 'ad-source');
      }
      adSource.addEventListener('change', function () {
        call('setAddonSource', this.value);
        // 用户自己选过平台，之后别再拿设置里的默认值顶他
        adSourceTouched = true;
        // 换平台等于换了一整套数据源：清掉搜索缓存和分页，从头查一遍。
        // 不清的话切过去看到的还是上一个平台的结果。
        adSearchCache = {};
        // 分类表两家不通用，切了就得重新拉；已选的类别也跟着作废。
        // 搜索词保留 —— 用户就是想拿同一个词去另一家再搜一遍。
        adCat = '';
        requestAddonCategories();
        // 两个平台的索引语言不一样，提示语得跟着换
        applyAddonSearchHint();
        requestAddonSearch();
      });
      // API Key 是构建期注入的，某些构建里可能没有。没有就禁用这个选项并写明
      // 原因 —— 让用户切过去搜出一片空白，比直接说「缺 key」更难理解。
      apiCall('curseForgeAvailable').then(function (raw) {
        var ok = String(raw) === 'true' || raw === true;
        cfReady = ok;
        if (ok) { return; }
        var opt = adSource.querySelector('option[value="curseforge"]');
        if (!opt) { return; }
        opt.disabled = true;
        opt.textContent = 'CurseForge（缺少 API Key）';
        if (adSource.value === 'curseforge') {
          adSource.value = 'modrinth';
          adSource.dispatchEvent(new Event('change'));
        }
        if (csRegistry['ad-source']) { csRegistry['ad-source'].rebuild(); }
      });
    }

    var versionSelect = document.getElementById('set-version-source');
    if (versionSelect) {
      versionSelect.addEventListener('change', function () {
        call('setDownloadSource', 'version', this.value);
      });
    }

    var fileSelect = document.getElementById('set-file-source');
    if (fileSelect) {
      fileSelect.addEventListener('change', function () {
        call('setDownloadSource', 'file', this.value);
      });
    }

    var seg = document.getElementById('thread-mode-seg');
    if (seg) {
      seg.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-thread-mode]');
        if (!btn) { return; }
        var input = document.getElementById('set-threads');
        call('setDownloadThreads', btn.getAttribute('data-thread-mode'), input ? input.value : '64');
      });
    }

    var input = document.getElementById('set-threads');
    if (input) {
      input.addEventListener('change', function () {
        call('setDownloadThreads', 'manual', this.value);
      });
    }
  }

  /// 把后端返回的下载设置回填到控件上。
  function applyDownloadSettings(s) {
    if (s.defaultAddonSource) {
      fillSelect('set-addon-source', [
        { value: 'modrinth', label: 'Modrinth' },
        { value: 'curseforge', label: 'CurseForge' }
      ], s.defaultAddonSource);
    }

    // 「默认内容源」以前只回填设置页，下载页从来不读 ——
    // 设置里选了 CurseForge，下载页还停在 Modrinth，下面的搜索提示也跟着说「中英文均可」，
    // 等于告诉用户一个假话。两处得同步。
    // 只在用户没在下载页手动切过、且 CF 确实可用的时候套，免得把他刚选的平台顶回去。
    var adSel = document.getElementById('ad-source');
    if (adSel && s.defaultAddonSource && !adSourceTouched
        && cfReady !== false && adSel.value !== s.defaultAddonSource) {
      adSel.value = s.defaultAddonSource;
      if (csRegistry['ad-source']) { csRegistry['ad-source'].rebuild(); }
      // 平台换了，分类表也得跟着换（两家的分类不通用），已选类别作废
      adCat = '';
      requestAddonCategories();
      applyAddonSearchHint();
    }
    var versionSelect = document.getElementById('set-version-source');
    if (versionSelect && s.versionListSource) {
      versionSelect.value = s.versionListSource;
      if (csRegistry['set-version-source']) { csRegistry['set-version-source'].rebuild(); }
    }

    var fileSelect = document.getElementById('set-file-source');
    if (fileSelect && s.fileDownloadSource) {
      fileSelect.value = s.fileDownloadSource;
      if (csRegistry['set-file-source']) { csRegistry['set-file-source'].rebuild(); }
    }
    applyDownloadSourceToPage(s.fileDownloadSource);

    var auto = s.autoDownloadThreads !== false;
    var seg = document.getElementById('thread-mode-seg');
    if (seg) {
      var btns = seg.querySelectorAll('button[data-thread-mode]');
      for (var i = 0; i < btns.length; i++) {
        var mode = btns[i].getAttribute('data-thread-mode');
        btns[i].classList.toggle('active', auto ? mode === 'auto' : mode === 'manual');
      }
    }

    var input = document.getElementById('set-threads');
    if (input) {
      if (s.downloadThreads) { input.value = s.downloadThreads; }
      // 自动模式下手动值不生效，置灰免得用户以为是它起作用
      input.disabled = auto;
    }
  }

  /// 应用内的输入框。原来用浏览器 prompt()，在 WebView2 里会弹成
  /// 「tauri.localhost 显示」那种原生框，既不像应用的一部分也没法调样式。
  function askName(title, initial) {
    return new Promise(function (resolve) {
      var modal = document.getElementById('name-modal');
      var input = document.getElementById('name-input');
      if (!modal || !input) { resolve(null); return; }

      document.getElementById('name-title').textContent = title;
      input.value = initial || '';
      modal.classList.remove('hidden');
      setTimeout(function () { input.focus(); input.select(); }, 30);

      function cleanup() {
        modal.classList.add('hidden');
        document.removeEventListener('keydown', onKey);
        document.getElementById('name-ok').onclick = null;
        document.getElementById('name-cancel').onclick = null;
        document.getElementById('name-close').onclick = null;
      }
      function done(value) {
        cleanup();
        resolve(value && value.trim() ? value.trim() : null);
      }
      function onKey(e) {
        if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); done(null); }
      }

      document.addEventListener('keydown', onKey);
      document.getElementById('name-ok').onclick = function () { done(input.value); };
      document.getElementById('name-cancel').onclick = function () { done(null); };
      document.getElementById('name-close').onclick = function () { done(null); };
    });
  }

/* 多人联机页：托管「陶瓦联机（Terracotta）」。
 *
 * 原则是只调用、不修改：启动器负责下载、启动、退出，开房和加入都走陶瓦
 * 自己暴露的本地 HTTP 接口。这一页只做状态映射和按钮显隐，不参与协议细节。
 *
 * 状态来源是后端 lanState：
 *   exists      模块装好没有
 *   installing  正在下载
 *   installError 上一次下载失败的原因
 *   running     核心在跑（端口 + /state 有应答）
 *   starting    核心进程起来了但端口还没出来
 *   core.state  陶瓦自己的状态机
 */
(function () {
  'use strict';

  var LAN_RELEASES = 'https://github.com/burningtnt/Terracotta/releases';

  var lanTimer = null;
  var lanTimerMs = 0;
  var lanData = null;
  var lanLastFail = '';       // 上一次报过的下载失败原因，避免每轮都弹
  var lanLastStartError = '';

  /// 状态名 → 页面。陶瓦的状态机在 `core.state` 里，这里只做展示映射。
  var LAN_PHASE = {
    waiting: {
      badge: '待机',
      hint: '输入房间码后即可加入房间，若您为房主请点击创建房间',
      idle: ''
    },
    'host-scanning': {
      badge: '等待开局域网',
      hint: '请进入需多人联机的世界，对局域网开放',
      idle: '取消创建'
    },
    'host-starting': {
      badge: '正在开房',
      hint: '正在创建房间，稍候…',
      idle: '取消创建'
    },
    'host-ok': {
      badge: '房间已创建',
      hint: '已创建房间，发送房间码给好友加入房间即可',
      idle: '关闭房间'
    },
    'guest-connecting': {
      badge: '连接中',
      hint: '正在连接房主，稍候…',
      idle: '取消加入'
    },
    'guest-starting': {
      badge: '正在加入',
      hint: '正在加入房间，稍候…',
      idle: '取消加入'
    },
    'guest-ok': {
      badge: '已加入',
      hint: '已加入房间，打开游戏 → 多人游戏，双击「陶瓦联机大厅」进入',
      idle: '退出房间'
    },
    exception: {
      badge: '出错',
      hint: '联机出错了，可以退出房间后重试',
      idle: '回到待机'
    }
  };

  /// 只绑定一次。`initLan` 目前只在启动时调，但页面重建、热重载都会再进来一次，
  /// 重复 addEventListener 会让一次点击触发多次请求。
  var lanBound = false;

  function initLan() {
    if (lanBound) { return; }
    lanBound = true;

    var download = document.getElementById('lan-download');
    if (download) {
      download.addEventListener('click', function () { call('openUrl', LAN_RELEASES); });
    }

    var install = document.getElementById('lan-install');
    if (install) {
      install.addEventListener('click', function () {
        install.disabled = true;
        // 失败后重试：清掉上一轮的错误，让按钮回到「下载中」而不是继续红着
        lanLastFail = '';
        apiCall('lanInstall', []).then(function (raw) {
          install.disabled = false;
          var d = asJson(raw);
          if (d && d.ok === false && d.error) { toast(d.error, 'error'); }
          lanRefresh();
        });
      });
    }

    var start = document.getElementById('lan-start');
    if (start) {
      start.addEventListener('click', function () {
        start.disabled = true;
        apiCall('lanStart', []).then(function (raw) {
          start.disabled = false;
          var d = asJson(raw);
          if (d && d.ok === false && d.error) { toast(d.error, 'error'); }
          lanRefresh();
        });
      });
    }

    var host = document.getElementById('lan-host');
    if (host) { host.addEventListener('click', function () { lanAct('lanHost', []); }); }

    var join = document.getElementById('lan-join');
    if (join) {
      join.addEventListener('click', function () {
        var input = document.getElementById('lan-room-input');
        var code = input ? String(input.value || '').trim() : '';
        if (!code) {
          toast(tr('先填房间码'), 'error');
          if (input) { input.focus(); }
          return;
        }
        lanAct('lanJoin', [code]);
      });
    }

    var roomInput = document.getElementById('lan-room-input');
    if (roomInput) {
      roomInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && join) { join.click(); }
      });
    }

    var idle = document.getElementById('lan-idle');
    if (idle) { idle.addEventListener('click', function () { lanAct('lanIdle', []); }); }

    var copy = document.getElementById('lan-copy');
    if (copy) { copy.addEventListener('click', function () { lanCopyCode(); }); }
  }

  function lanAct(method, args) {
    apiCall(method, args).then(function (raw) {
      var d = asJson(raw);
      if (d && d.ok === false && d.error) {
        toast(d.error, 'error');
        return;
      }
      if (d) {
        lanData = d;
        renderLan(d);
      }
      lanRefresh();
    });
  }

  function lanCopyCode() {
    var code = document.getElementById('lan-room-code');
    if (!code) { return; }
    var text = code.textContent || '';
    if (!text) { return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(tr('房间码已复制'));
      }, function () {
        toast(tr('复制失败'), 'error');
      });
    }
  }

  /// 停在联机页时才轮询：核心可能被系统或用户从任务栏关掉，房间状态也在变。
  function showLan() {
    lanRefresh();
    startLanTimer(lanData && lanData.installing ? 700 : 1500);
  }

  function startLanTimer(ms) {
    if (lanTimer && lanTimerMs === ms) { return; }
    lanStopPoll();
    lanTimerMs = ms;
    lanTimer = setInterval(lanRefresh, ms);
  }

  function lanStopPoll() {
    if (lanTimer) {
      clearInterval(lanTimer);
      lanTimer = null;
      lanTimerMs = 0;
    }
  }

  function lanRefresh() {
    apiCall('lanState', []).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.ok) { return; }
      lanData = d;
      renderLan(d);
    });
  }

  function renderLan(d) {
    var installing = !!d.installing;
    var ready = !!d.exists;
    var running = !!d.running;
    var starting = !!d.starting;
    var failed = !installing && !ready && !!d.installError;
    var core = d.core || {};
    var phase = String(core.state || 'waiting');
    var view = LAN_PHASE[phase] || LAN_PHASE.waiting;

    // ---- 徽标 ----
    var badge = document.getElementById('lan-badge');
    if (badge) {
      if (installing) {
        badge.textContent = tf('下载中 {0}%', d.progress || 0);
        badge.className = 'lan-badge';
      } else if (failed) {
        badge.textContent = tr('下载失败');
        badge.className = 'lan-badge bad';
      } else if (!ready) {
        badge.textContent = tr('未加载');
        badge.className = 'lan-badge';
      } else if (starting) {
        badge.textContent = tr('启动中');
        badge.className = 'lan-badge';
      } else if (!running) {
        badge.textContent = tr('已就绪');
        badge.className = 'lan-badge ready';
      } else {
        badge.textContent = tr(view.badge);
        badge.className = 'lan-badge on';
      }
    }

    // ---- 一句话状态 ----
    var hint = document.getElementById('lan-hint');
    if (hint) {
      if (installing) {
        hint.textContent = tr('正在下载联机模块…');
      } else if (failed) {
        hint.textContent = tr('下载联机模块失败，请检查网络是否正常');
      } else if (!ready) {
        hint.textContent = tr('当前联机模块未加载，点击「下载联机模块」加载');
      } else if (starting) {
        hint.textContent = tr('正在启动联机核心…');
      } else if (!running) {
        hint.textContent = tr('联机模块已就绪');
      } else {
        hint.textContent = tr(view.hint);
      }
    }

    // ---- 按钮 ----
    // 「下载联机模块」在失败后也要留着：那就是重试入口
    toggleRow('lan-install', !ready && !installing);
    toggleRow('lan-start', ready && !running && !starting && !installing);
    // 待机时才给开房和加入：已经在房间里再点没有意义
    var idlePhase = running && phase === 'waiting';
    toggleRow('lan-host', idlePhase);
    toggleRow('lan-room-input', idlePhase);
    toggleRow('lan-join', idlePhase);
    toggleRow('lan-idle', running && !!view.idle);
    // 没有「停止核心」按钮：核心跟着启动器一起退出，用户不需要单独管

    var idle = document.getElementById('lan-idle');
    if (idle && view.idle) { idle.textContent = tr(view.idle); }

    // ---- 房间码：只有房主有 ----
    var room = document.getElementById('lan-room');
    var code = phase === 'host-ok' && core.room ? String(core.room) : '';
    if (room) { room.hidden = !code; }
    if (code) { setText('lan-room-code', code); }

    renderLanPlayers(core.profiles);

    // ---- 失败提示：只弹一次，别每 1.5 秒重复 ----
    if (!installing && d.installError) {
      if (d.installError !== lanLastFail) {
        lanLastFail = d.installError;
        toast(d.installError, 'error');
      }
    } else if (!d.installError) {
      lanLastFail = '';
    }

    if (!starting && d.startError && d.startError !== lanLastStartError) {
      lanLastStartError = d.startError;
      toast(d.startError, 'error');
    }
    if (!d.startError) { lanLastStartError = ''; }
  }

  /// 玩家列表。陶瓦给的 `profiles` 是「名字 → 状态」的对象，
  /// 房主自己那一条会带 `host` 标记。
  function renderLanPlayers(profiles) {
    var box = document.getElementById('lan-players');
    if (!box) { return; }
    if (!profiles) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    var names = Object.keys(profiles);
    if (!names.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.innerHTML = '';
    names.forEach(function (name) {
      var info = profiles[name] || {};
      var label = name || tr('匿名玩家');
      if (info.host) { label += ' · ' + tr('房主'); }
      box.appendChild(el('span', 'lan-player', label));
    });
    box.hidden = false;
  }

  window.initLan = initLan;
  window.showLan = showLan;
  window.lanStopPoll = lanStopPoll;
})();
  // 构建探针：确认页面跑的是这一版脚本（排查缓存问题时一眼定位）
  window.__buildProbe = 'export-menu-v1';

  // ---------------- Java 回调入口 ----------------

  window.__hmcl = {
    /// 检查更新的结果：打开弹窗列出可更新项。
    onAddonUpdates: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      finishUpdateCheck();
      if (!d || !d.ok) {
        toast((d && d.error) || tr('检查更新失败'), 'error');
        return;
      }
      showUpdateModal(d);
    },

    /// 批量更新完成：刷新当前标签页的内容列表。
    onAddonUpdatesApplied: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d) { return; }
      if (d.failed) {
        toast(tf('{0} 个已更新，{1} 个失败', d.updated, d.failed), 'error');
      } else {
        toast(tf('{0} 个资源已更新', d.updated), 'ok');
      }
      if (instTab === 'mod' || instTab === 'resourcepack' || instTab === 'shader') {
        // 刚更新过文件，缓存必过期
        loadInstContent(instTab, true);
      }
      if (typeof scanInstanceMods === 'function') { scanInstanceMods(); }
    },

    /// 游戏文件修复完成。
    onGameIntegrityFixed: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || !d.ok) { return; }
      toast(tr('游戏文件已补全'), 'ok');
    },

    /// 系统拖放的三条回调，故意留空。
    ///
    /// 壳模式下 Tauri 自己会发一套拖放事件（60-theme.js 的 initDragDrop），
    /// Java 这边再转发一套，两边同时响应就会让一次拖放走两遍：
    /// 先「正在识别 1 个文件」，再「认不出的格式」，最后才真导入 —— 三个提示。
    /// 统一由 Tauri 那套处理（它带页面判断，能区分纹理和资源）。
    onDragEnter: function (paths) { },

    onDragLeave: function () { },

    onDragDrop: function (paths) { },

    /// 拖放导入的汇总结果
    onDropResult: function (json) { handleDropResult(json); },

    /// 单个镜像测完：只更新那一格，不重排，避免列表来回跳。
    onMirrorProgress: function (json) {
      var r = null;
      try { r = JSON.parse(json); } catch (e) { return; }
      if (!r || !r.id) { return; }
      mirrorResults[r.id] = r;
      mirrorDone++;
      updateMirrorCell(r);
      updateMirrorCount();
      updateFoldSub();
    },

    /// 整轮测速结束：重排、记下最优、刷新提示。
    onMirrorStatus: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || d.busy) { return; }
      mirrorData = d;
      mirrorResults = {};
      (d.results || []).forEach(function (r) { mirrorResults[r.id] = r; });
      mirrorTesting = false;
      mirrorDone = (d.results || []).length;
      renderMirrorGrid();
      updateMirrorCount();
      updateFoldSub();
      updateUrlHint();
      var state = document.getElementById('mirror-state');
      if (state) { state.textContent = ''; }
      toast(tr('测速完成'), 'ok');
    },

    /// 压缩包导入完成（含部分失败）。结果留在弹窗里，用户可以逐条看。
    onArchiveImported: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d) { return; }

      if (d.delegated) {
        importBusy = false;
        closeModal('import-modal');
        toast(tf('已开始安装整合包：{0}', d.name || d.file || ''), 'ok');
        return;
      }

      renderImportResult(d);

      if (d.ok) {
        toast(d.kind === 'instance'
          ? tf('实例「{0}」已导入', d.name || '')
          : tr('导入完成'), 'ok');
        // 内容变了就把当前内容页刷一下（force：刚导入了整包）
        if (INST_KIND_NAMES[instTab]) { loadInstContent(instTab, true); }
      } else {
        toast((d.errors && d.errors[0]) || tr('导入失败'));
      }
    },

    /// 导出完成：把保存路径告诉用户。
    onExportDone: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || !d.ok) { return; }
      toast(tf('{0}已导出到 {1}', tr(d.what || ''), d.path || ''), 'ok');
    },

    /// 整合包更新状态。批量查是全量覆盖，手动检查是单条合并 ——
    /// 手动那条只带一个实例，直接覆盖会把别的实例的角标抹掉。
    onModpackUpdates: function (json) {
      var list = null;
      try { list = JSON.parse(json); } catch (e) { return; }
      if (!list || !list.length) { return; }
      var manual = false;
      list.forEach(function (u) { if (u && u.manual) { manual = true; } });
      if (!manual) { modpackUpdates = {}; }
      list.forEach(function (u) {
        if (!u || !u.instanceId) { return; }
        modpackUpdates[u.instanceId] = u;
        if (!u.manual) { return; }
        if (!u.ok) {
          var reason = u.reason === 'no-source'
            ? '这个实例没有记录安装来源（手动导入或从别处拷来的），没法自动检查更新'
            : (u.reason === 'unknown-version'
              ? '这个实例是本地导入的整合包，不知道当初装的是哪个版本，没法比对'
              : (u.reason || '查不到这个实例的更新信息'));
          toast(tr(reason), 'error');
        } else if (u.hasUpdate) {
          toast(tf('有新版本 {0}', u.latestVersion || ''));
        } else {
          toast(tr('已经是最新版本'));
        }
      });
      renderInstanceGrid();
      renderInstUpdateBar();
    },

    onState: function (json) {
      try { state = JSON.parse(json); } catch (e) { console.error('bad state', e); return; }
      // 动画偏好要在第一次 render 之前生效，否则首屏那次过渡还是全速
      applyAnimSpeed(state.animationSpeed || 'fast');
      document.body.classList.toggle('no-anim', !!state.animationDisabled);
      // 只在用户没手动选过主题时跟随 Java 侧（跟随系统/启动器设置）
      if (state.theme && !savedTheme()) { applyTheme(state.theme, false); }
      render();
      // 选中实例变了，启动器主题也要跟着换
      refreshInstanceThemeIfNeeded();
      // 更新状态单独拉：它要打平台接口，不能挡住首屏。
      // 后端有十分钟缓存，重复调不会一直发请求。
      refreshModpackUpdates(false);
    },
    /// 扫完旧启动器目录：有东西就开弹窗让用户勾选
    onLegacyScanned: function (json) {
      var btn = document.getElementById('set-migrate');
      if (btn) { btn.disabled = false; btn.textContent = tr('选个旧目录'); }
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.cancel) { return; }
      if (!data.ok) { toast(data.error || '这个目录不像启动器的数据目录', 'error'); return; }
      if (!data.accounts && !data.gameDirs && !data.appearance && !data.backgrounds) {
        toast('这里没有账号、皮肤或游戏目录', 'error');
        return;
      }
      legacyScan = data;
      renderLegacy();
      openModal('legacy-modal');
    },
    /// 迁移结果：搬了多少，然后重启。
    ///
    /// 必须重启：账号和游戏目录是启动时读进内存的，而且核心退出时会用内存里那份
    /// 回写文件 —— 不重启的话，导入的内容下次保存就被盖掉了。
    onLegacyImported: function (json) {
      var doBtn = document.getElementById('legacy-do');
      if (doBtn) { doBtn.disabled = false; doBtn.textContent = tr('导入'); }
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      if (!data.ok) { toast(tr('没搬成：') + (data.error || '未知错误'), 'error'); return; }
      closeModal('legacy-modal');

      var bits = [];
      if (data.accounts) { bits.push(data.accounts + tr(' 个账号')); }
      if (data.gameDirs) { bits.push(data.gameDirs + tr(' 个游戏目录')); }
      if (data.appearance) { bits.push(data.appearance + tr(' 张皮肤')); }
      if (data.backgrounds) { bits.push(data.backgrounds + tr(' 张背景图')); }
      var summary = (bits.length ? bits.join('、') + tr('搬过来了') : '选中的东西都搬过来了');

      var tauri = window.__TAURI__;
      if (tauri && tauri.core && tauri.core.invoke) {
        toast(summary + tr('，重启一下'));
        // 只停 250ms：让 toast 有机会画出来就够。
        // 停久了有风险 —— 这段时间里核心要是触发一次保存，会用内存里的旧账号
        // 把刚写进去的文件盖掉。
        setTimeout(function () {
          tauri.core.invoke('restart_app').catch(function () {
            toast(summary + tr('，关掉重开才生效'), 'error');
          });
        }, 250);
      } else {
        toast(summary + tr('，关掉重开才生效'));
      }
    },
    /// 导入已有游戏目录的结果（Java 侧目录选择框选完之后回调）
    onGameDirectoryImported: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      if (!data.ok) {
        toast(tr('导入失败：') + (data.error || '未知错误'), 'error');
        return;
      }
      if (data.versions > 0) {
        toast((data.added ? '已导入 ' : '已切换到 ') + (data.name || data.path)
          + ' · ' + data.versions + tr(' 个版本'));
        // 目录已经切成当前目录，回主页就能看到实例卡片
        go('home');
      } else {
        toast('这个目录里没找到可用的版本，确认选的是 .minecraft 目录', 'error');
      }
    },
    /// 检查更新的结果：有新版就展开更新卡片，没有就一句 toast
    onLauncherUpdate: function (json) {
      var check = document.getElementById('check-update');
      if (check) { check.disabled = false; check.textContent = tr('检查更新'); }
      var payload = null;
      try { payload = JSON.parse(json); } catch (e) { return; }
      if (!payload || !payload.ok) {
        setUpdateStatus('检查失败');
        toast(tr('检查更新失败：') + ((payload && payload.error) || '网络错误'), 'error');
        return;
      }
      var d = payload.data || {};
      updateState.info = d;
      updateState.ready = false;
      var card = document.getElementById('update-card');
      if (!d.hasUpdate) {
        if (card) { card.hidden = true; }
        toast(tr('已经是最新版本 ') + (d.current || ''));
        return;
      }
      var ver = document.getElementById('update-version');
      if (ver) { ver.textContent = tr('当前 ') + (d.current || '?') + tr(' → 最新 ') + (d.latest || '?'); }
      var notes = document.getElementById('update-notes');
      if (notes) { notes.textContent = d.notes || '这次更新没有附说明。'; }
      var now = document.getElementById('update-now');
      if (now) { now.disabled = false; now.textContent = tr('下载更新'); }
      setUpdateBar(null);
      setUpdateStatus('');
      if (card) { card.hidden = false; }
    },

    onLauncherUpdateProgress: function (percent) {
      setUpdateBar(percent);
      setUpdateStatus(tr('正在下载… ') + percent + '%');
    },

    onLauncherUpdateReady: function () {
      updateState.ready = true;
      var now = document.getElementById('update-now');
      if (now) { now.disabled = false; now.textContent = tr('重启并安装'); }
      setUpdateStatus('下载完成，点右边重启安装');
    },

    onNewsDetail: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderNewsDetail(data);
    },

    onNews: function (json) {
      try { news = JSON.parse(json); } catch (e) { news = { error: String(e) }; }
      renderNews();
    },
    onToast: function (text) {
      // Java 侧的 Controllers.showToast 会落到这里
      toast(text);
    },
    onAddonSearch: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== adType) { return; }
      // 过期响应（用户已经又点了别的类别 / 又翻了一页）直接丢弃
      if (data.reqId != null && String(data.reqId) !== String(adReqSeq)) { return; }
      // 成功的结果才缓存，报错（网络/限流）下次还要重试
      if (!data.error) { cachePut(adSearchCache, addonSearchKey(), data); }
      applyAddonSearch(data);
    },

    onAddonCategories: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.type) { return; }
      // 缓存按「类型|平台」分开：两家的分类表不是一套东西
      var key = data.type + '|' + (data.source || 'modrinth');
      // 报错不缓存，下次切回来还会重试（网络抖动时不该永久空着）
      if (!data.error) { adCatCache[key] = data.groups || []; }
      // 回来的是别的类型/平台的表就丢掉：连点切页时会有好几个请求在飞
      if (key !== adCatKey()) { return; }
      adCatGroups = adCatCache[key] || [];
      renderAddonCategories();
    },

    /// 实例被改名了（from / to 都是实例 id）。
    ///
    /// 实例 id 就是目录名，改名之后旧 id 立刻失效。前端如果还停在那个实例页上，
    /// 必须换成新 id 重进一次，否则页面会一直显示一个已经不存在的实例。
    /// 百宝箱下载进度（Java 侧每 200ms 推一次）
    onToolboxProgress: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      renderToolboxProgress(data);
    },

    /// 清理结果：删了多少个文件、释放了多少空间
    onCleanupResult: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      var out = document.getElementById('tb-clean-result');
      if (!out || !data) { return; }
      if (!data.count) {
        out.textContent = tr('没有可清理的内容');
      } else {
        out.textContent = tr('清掉 ') + data.count + tr(' 个文件，释放 ') + fmtBytes(data.freed);
      }
    },

    onInstanceRenamed: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.to) { return; }
      if (instId === data.from) {
        showInstancePage(data.to);
      }
    },

    onInstanceDetail: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.error) { return; }
      if (data.id && instId && data.id !== instId) { return; }
      instData = data;
      renderInstanceDetail(data);
    },

    onInstanceAddons: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderAddons(data);
    },

    /// 依赖检查点「安装」时，mod id 解析成 Modrinth 项目之后回到这里。
    /// 直接把模组页那套版本弹窗打开，选哪个版本、装到哪，行为和手动装模组完全一样。
    onAddonResolved: function (json) {
      var dep = pendingDep;
      pendingDep = null;
      if (dep && dep.btn) {
        dep.btn.disabled = false;
        dep.btn.textContent = tr('安装');
      }
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || !d.ok) {
        toast(tf('没找到「{0}」，去模组页搜一下', d && d.modId ? d.modId : ''), 'error');
        return;
      }
      adType = 'mod';
      if (instId) { adInstPicked['mod'] = instId; }
      openAddonVersions({ slug: d.slug, title: d.title || d.modId, icon: d.icon });
    },
    onLoginStage: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.flow !== 'microsoft') { return; }
      document.getElementById('lm-stage').textContent = data.stage || '';
    },

    /// 微软设备码：用户码 + 验证地址。
    /// 壳里没有 MicrosoftAccountLoginPane，事件没人订阅，所以由 Java 侧补了一次
    /// （WebBridge.hookMicrosoftDeviceCode），这里负责把它显示出来。
    onMicrosoftCode: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.flow !== 'microsoft') { return; }
      var box = document.getElementById('lm-code-box');
      var code = document.getElementById('lm-code');
      var url = document.getElementById('lm-url');
      var open = document.getElementById('lm-open');
      if (code) { code.textContent = data.code || '----'; }
      if (url && data.url) {
        url.textContent = data.url;
        url.setAttribute('href', data.url);
      }
      if (box) { box.hidden = false; }
      if (open) {
        open.hidden = false;
        open.onclick = function () {
          if (data.url) { call('openLink', data.url); }
        };
      }
      var stage = document.getElementById('lm-stage');
      if (stage) { stage.textContent = tr('在浏览器打开下面的地址，输入这个代码：'); }
    },

    onLoginResult: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      // 走到这里说明这次登录已经结束（不论成败），再点关闭就不该发取消指令了
      if (data.flow === 'microsoft') { msLoginActive = false; }
      if (data.ok) {
        hideModal('login-offline');
        hideModal('login-ms');
        hideModal('login-authlib');
        toast(tr('已登录：') + (data.message || ''));
        return;
      }
      // 失败：外置认证重新打开弹窗，让用户改完直接重试
      toast(data.flow === 'offline' ? (tr('离线登录失败：') + data.message)
        : data.flow === 'microsoft' ? (tr('微软登录失败：') + data.message)
          : (tr('外置认证失败：') + data.message), 'error');
      if (data.flow === 'microsoft') {
        document.getElementById('lm-stage').textContent = data.message || '登录失败';
      }
    },

    onAuthlibServers: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      var list = [];
      try { list = typeof data.servers === 'string' ? JSON.parse(data.servers) : (data.servers || []); } catch (e) { list = []; }
      renderAuthlibServers(list);
      var hint = document.getElementById('la-add-hint');
      if (data.ok) {
        if (hint) { hint.textContent = tr('名称等信息会自动从皮肤站读取'); }
        document.getElementById('la-url').value = '';
        document.getElementById('la-add').hidden = true;
      } else if (data.error && hint) {
        hint.textContent = data.error;
      }
    },

    onAppearance: function (json) {
      try {
        var data = JSON.parse(json);
        // Gson 默认不输出 null 字段，`pendingServerCape` 是 null 时整条就没了，
        // 前端读出来是 undefined，而下面各处判的是 `=== null`：
        // 结果「无披风」和「已装备」都不高亮，一个 current 都没有。这里补回 null。
        if (data && data.pendingServerCape === undefined) { data.pendingServerCape = null; }
        // 换账号了：上一个账号的服务器披风列表和图片全部作废。
        // 不清的话切到另一个号会先闪一排别人的披风，图还是错的那种。
        var uuid = (data && data.accountId) || '';
        if (uuid !== apAccountUuid) {
          apAccountUuid = uuid;
          serverCapes = null;
        }
        renderAppearance(data);
      } catch (e) { console.error(e); }
    },
    onInstanceInstallers: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !imInstanceId) { return; }
      // 标题上的版本号用 manifest 里真实的游戏版本，
      // 实例列表里的 gameVersion 字段偶尔是空的（比如手动放进 versions 目录的）
      if (data.gameVersion) {
        lmGame = data.gameVersion;
        document.getElementById('im-version').textContent = data.gameVersion;
      }
      imInstalled = {};
      (data.installed || []).forEach(function (it) {
        if (it && it.id) { imInstalled[it.id] = it.version || ''; }
      });
      renderInstallerCards();
    },
    onJavaList: function (json) {
      var list = null;
      try { list = JSON.parse(json); } catch (e) { return; }
      renderJavaList(list);
    },

    /// 可安装的 Java 列表（foojay）
    onJavaInstallable: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderJavaDownloadList(data);
    },

    onSettings: function (json) {
      try { renderSettings(JSON.parse(json)); } catch (e) { console.error('bad settings', e); }
    },
    onPreview: function (dataUrl) {
      // 壳模式下 3D 由前端 skinview3d 接管，后端那张 PNG 直接丢掉
      if (viewer) { return; }
      var img = document.getElementById('ap-preview');
      if (img && dataUrl) { img.src = dataUrl; }
    },
    onCapePreview: function (id, dataUrl, raw) {
      if (!serverCapes || !dataUrl) { return; }
      var hit = null;
      for (var i = 0; i < serverCapes.length; i++) {
        if (serverCapes[i].id === id) {
          serverCapes[i].preview = dataUrl;
          // 展开图给 3D 用：缩略图是拼好的正面剪影，贴不到模型上
          if (raw) { serverCapes[i].raw = raw; }
          hit = serverCapes[i];
          break;
        }
      }
      if (!hit) { return; }
      // 图到手了，重跑一次 3D 同步——正版账号当前装备的那件披风全靠这张图
      syncViewer();
      // 只换这一张卡的图，不重建整个网格，避免列表在眼前闪一下
      var cards = document.querySelectorAll('#asset-grid .asset-card');
      for (var k = 0; k < cards.length; k++) {
        if (cards[k].getAttribute('data-asset-id') === id) {
          var img = cards[k].querySelector('.asset-well img');
          if (img) { img.src = dataUrl; img.classList.remove('asset-placeholder'); }
          break;
        }
      }
    },
    onVersions: function (json) {
      try { dlVersions = JSON.parse(json); } catch (e) { console.error('bad versions', e); return; }
      dlLoadError = '';
      // 新清单到了就回第一页：刷新后还停在旧页码上，用户会以为列表没更新
      dlPage = 0;
      renderDownloadList();
    },
    /// 某个加载器在当前游戏版本下有没有可安装的版本。
    /// 打开安装弹窗时后端会为每个类型推一条，卡片按它决定能不能点。
    onInstallerSupport: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.type || data.game !== lmGame) { return; }
      onInstallerSupport(data.type, data.state || 'ok');
    },
    onLoaderVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      // 用户可能已经切到别的类型或别的版本，过期响应直接丢掉
      if (!data || data.game !== lmGame || data.type !== verTargetType) { return; }
      if (data.error) {
        // 明确失败：清空列表并让底部出现「重新拉取」。这里不能退化成空列表，
        // 否则界面上显示「这个游戏版本没有可用的 X 版本」，用户会以为真没有。
        lmVersions = null;
        lmVersionRows = [];
        verLoadError = fetchErrorMessage(data.error);
        renderVersionPicker();
        return;
      }
      verLoadError = '';
      lmVersionRows = normalizeVersionRows(data.versions);
      lmVersions = lmVersionRows.map(function (row) { return row.v; });
      // 不再在这里写 lmVersion：静默预选一个版本、用户直接点「安装」
      // 会把一个他从没确认过的版本装上。预选高亮交给 renderVersionPicker，
      // 真正落盘只发生在 commitVersionPick。
      renderVersionPicker();
    },
    /// 附属组件的版本清单到了。结构比加载器那条多一个 type，
    /// 复用同一个版本弹窗渲染。
    /// 版本清单到了。**两个弹窗共用这一个回调**，靠载荷形状分流：
    /// 下载页的「选择版本」带 `items`，实例页的附属组件（加载器 / 附属）带 `versions`。
    ///
    /// 以前这里写了两份同名的 `onAddonVersions`，对象字面量后定义的覆盖前面那份，
    /// 结果下载页点开版本列表永远停在「正在拉取版本…」—— 回调被另一个弹窗的分支吃掉了。
    onAddonVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }

      // 下载页：选版本 → 下载
      if (data.items && data.type === adType) {
        if (data.error) {
          var list = document.getElementById('adver-list');
          list.innerHTML = '';
          list.appendChild(el('div', 'adver-empty', friendlyError(data.error)));
          return;
        }
        var items = data.items;
        if (adTarget) { cachePut(adVersionCache, addonVersionKey(adTarget.slug), items); }
        setAdverVersions(items, data.total || items.length);
        return;
      }

      // 实例页：给加载器 / 附属组件挑版本
      if (data.type === verTargetType && verTargetIsAddon) {
        if (data.error) {
          lmVersions = null;
          lmVersionRows = [];
          verLoadError = fetchErrorMessage(data.error);
          renderVersionPicker();
          return;
        }
        verLoadError = '';
        lmVersionRows = normalizeVersionRows((data.versions || []).map(function (v) {
          return { v: v.version, date: v.date || 0 };
        }));
        lmVersions = lmVersionRows.map(function (row) { return row.v; });
        renderVersionPicker();
      }
    },
    /// 启动进度。壳模式下看不到 JavaFX 的启动对话框，靠这条通道把阶段画出来。
    /// 具体处理在 87b-launch-progress.js，这里只做转发，避免加载顺序问题。
    onLaunchProgress: function (json) {
      if (window.__launchProgress) { window.__launchProgress(json); }
    },

    /// 游戏进程退出。启动器如果因为「隐藏，游戏退出后再打开」被收起来了，这里恢复。
    onGameExit: function () {
      if (window.__launchShowWindow) { window.__launchShowWindow(); }
    },

    onInstallTitle: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.id || !data.title) { return; }
      if (!dlTasks[data.id]) {
        dlTasks[data.id] = { title: data.title, stage: '', percent: -1 };
      } else {
        dlTasks[data.id].title = data.title;
      }
      updateDownloadButton();
      if (dlPopoverOpen) { renderDownloadPopover(); }
    },

    /// 任务进度。所有下载 / 安装都走这一条，统一进右上角的任务列表。
    ///
    /// 以前还有一条「下载页顶部进度条」，两条通道各写各的，于是出现
    /// 「任务没进列表、只在页面顶上漂一行红字」这种割裂感。现在只有列表。
    onInstallStage: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }

      // 拉版本清单结束也走这个通道，但它不是一次下载。
      // 失败必须在这里处理：只 return 的话页面会永远停在「正在拉取版本清单…」，
      // 用户看不到任何原因，也没有重试入口。
      if (data.kind === 'versions') {
        // 不看 done：后端最后一轮失败时会把 done 置 true，但只要有 error 就说明
        // 这一轮没成，界面就该给出重试入口
        if (data.error) {
          dlLoadError = String(data.error);
          renderDownloadList();
        }
        return;
      }

      if (!data.id) {
        updateDownloadButton();
        return;
      }

      var id = data.id;
      var prev = dlTasks[id];

      if (data.done) {
        if (data.error) {
          // 失败：留在列表里让用户看清原因，带 ✕ 手动移除
          // 后端有时给的是已经带了「安装失败：」前缀的文案，有时是裸异常。
          // 裸异常（NullPointerException 之类）直接甩给用户没意义，前面补一句人话
          var msg = String(data.error);
          if (msg === 'cancelled' || msg === '已取消') {
            // 用户自己点的取消，不算失败
            msg = '已取消';
          } else if (!/^(安装|下载|创建)?失败/.test(msg.slice(0, 12))) {
            msg = tr('下载失败：') + msg;
          }
          dlTasks[id] = {
            title: (prev && prev.title) || id,
            stage: '',
            percent: -1,
            kind: prev && prev.kind,
            paused: false,
            error: msg
          };
          dlInstalling = null;
        } else {
          // 成功：先把进度推满，900ms 后移除——直接删会让人看不到条走完
          var doneTitle = (prev && prev.title) || id;
          if (prev) { prev.percent = 1; prev.stage = '已完成'; }
          dlInstalling = null;
          notifyDone(doneTitle);
          setTimeout(function () {
            delete dlTasks[id];
            renderDownloadPopover();
            updateDownloadButton();
          }, 900);
        }
      } else {
        // 先判断「是不是新任务」再动 prev：下面 next 和 prev 是同一个对象，
        // 改完 stage 再判断就永远是 false，列表也就永远不自动弹出
        var isNew = !prev || (!prev.stage && prev.percent < 0);
        var next = prev || { title: '', stage: '', percent: -1, filesDone: -1, filesTotal: -1 };
        // 进度条只许向前。后端已经把子任务的抽搐百分比聚合成一条单调进度，
        // 这里再兜一道：任何回退（重连、乱序到达）都丢掉，条永远不会倒着走。
        if (typeof data.percent === 'number' && data.percent >= 0) {
          var last = typeof next.percent === 'number' ? next.percent : -1;
          next.percent = data.percent > last ? data.percent : last;
        }
        // 大批量拉取的文件计数。total 为 -1/0 表示这一段没有总数，不显示分母。
        var fd = typeof data.filesDone === 'number' ? data.filesDone : -1;
        var ft = typeof data.filesTotal === 'number' ? data.filesTotal : -1;
        if (ft > 0) {
          next.filesDone = fd;
          next.filesTotal = ft;
        } else {
          next.filesDone = -1;
          next.filesTotal = -1;
        }
        if (data.stage) { next.stage = data.stage; }
        // kind 决定任务行给不给暂停按钮；paused 决定按钮画 ⏸ 还是 ▶
        if (data.kind) { next.kind = data.kind; }
        next.paused = !!data.paused;
        next.error = null;
        dlTasks[id] = next;
        dlInstalling = id;

        // 新任务：自动把列表弹出来，否则点完安装只有一个按钮在动，看不出发生了什么
        if (isNew && !dlPopoverOpen) { setDownloadPopover(true); }
      }

      updateDownloadButton();
      // 关着也刷新一遍：下次点开就是最新状态，不会先闪一帧旧的
      renderDownloadPopover();

      if (!data.done && dlVersions) {
        // 装到一半时把列表里那一行标成「安装中…」
        renderDownloadList();
      }
      if (data.done && !data.error && dlVersions) {
        (dlVersions.versions || []).forEach(function (v) {
          if (v.id === id) { v.installed = true; }
        });
        renderDownloadList();
      }
    },
    onInstallFinished: function (id) {
      dlInstalling = null;
      renderDownloadList();
      call('refresh');
    },

    /// 启动前检查的结果。有问题的实例才会走到这里 —— 没问题的后端直接启动。
    /// 前端不做二次判断，弹窗内容就是后端给的那两条列表。
    onLaunchCheck: function (json) {
      // 后端约定传 JSON 文本，但收到对象时也认（推送格式改过一次，别再踩）
      var d = null;
      try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
      if (d) { openLaunchCheck(d); }
    },

    /// 游戏退出。自动备份和时长统计都在后端做完了，这里只负责说一句
    /// 并刷新状态（首页的「上次启动」和时长变了）。
    onGameExited: function (json) {
      var d = null;
      try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
      if (!d) { return; }

      var n = (d.backups || []).length;
      var skipped = (d.skipped || []).length;
      if (d.backupError) {
        toast(tf('存档备份失败：{0}', d.backupError), 'error');
      } else if (d.crashed) {
        toast(n ? tf('游戏异常退出，已备份 {0} 个存档', n) : tr('游戏异常退出'), 'error');
      } else if (n) {
        toast(tf('已自动备份 {0} 个存档', n), 'ok');
      }
      if (skipped) {
        toast(tf('{0} 个存档超过大小限制，未备份', skipped), 'error');
      }
      call('refresh');
    },
    onServerCapes: function (json) {
      var fresh = null;
      try { fresh = JSON.parse(json || '[]'); } catch (e) { fresh = []; }
      if (!Array.isArray(fresh)) { fresh = []; }

      // 后端那份列表缓存只存 id / name / url / active，**不含 preview**。
      // 切标签、切账号回来时走的是缓存分支，只推这个列表、不重推图片，
      // 直接赋值的话整排卡片立刻变紫块（图是异步一张张到的，早丢了）。
      // 手里已有的图按 id 接回去，图还在就不用重下。
      var keep = {};
      (serverCapes || []).forEach(function (c) {
        if (c && c.preview) { keep[c.id] = c; }
      });
      fresh.forEach(function (c) {
        var old = keep[c.id];
        if (old) {
          c.preview = old.preview;
          if (old.raw) { c.raw = old.raw; }
        }
      });

      serverCapes = fresh;
      if (apData) { renderAppearance(apData); }
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
