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

  function apiCall(method, args) {
    var q = new URLSearchParams(location.search);
    var port = q.get('port');
    var token = q.get('token') || '';
    if (!port) { return Promise.resolve(null); }
    return fetch('http://127.0.0.1:' + port + '/api/' + method + '?token=' + encodeURIComponent(token), {
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
    if (n >= 10000) { return (n / 10000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + ' 万'; }
    return String(n);
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

  function render() {
    if (!state) { return; }
    renderAccountChip();
    renderHero();
    renderInstanceGrid();
    renderAccountPage();
    renderInstanceTable();
    renderSettingsBasics();
  }

  /// 设置页里跟 state 有关的那几行（其余走 getSettings）
  function renderSettingsBasics() {
    var env = document.getElementById('set-env');
    if (env) { env.textContent = state ? (state.env || '') : ''; }

    var count = document.getElementById('set-instance-count');
    if (count) { count.textContent = ((state && state.instances) || []).length + ' 个'; }

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
    put('about-version', launcherLabel);
    put('set-game-dir', s.gameDirectory);
    applyDownloadSettings(s);

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
    setCheck('set-offline-account', L.enableOfflineAccount);
    setValue('set-log-lines', L.logLines > 0 ? L.logLines : '');
    setValue('set-log-retention', L.logRetention);

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
    setCheck('set-not-check-game', G.notCheckGame);
    setCheck('set-allow-agent', G.allowAutoAgent);
    setCheck('set-disable-auto-options', G.disableAutoGameOptions);

    fillSelect('set-quick-play', [
      { value: 'none', label: '停留在主菜单' },
      { value: 'singleplayer', label: '进入指定存档' },
      { value: 'multiplayer', label: '直接连接服务器' }
    ], G.quickPlay || 'none');
    setValue('set-quick-sp', G.quickPlaySingleplayer);
    setValue('set-quick-mp', G.quickPlayMultiplayer);
    syncQuickPlayRows(G.quickPlay || 'none');

    renderSettingsBasics();
  }

  /// 快速游玩：选了哪种才显示对应的输入框
  function syncQuickPlayRows(mode) {
    toggleRow('row-quick-sp', mode === 'singleplayer');
    toggleRow('row-quick-mp', mode === 'multiplayer');
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
        warn.textContent = '分配了物理内存的 ' + Math.round((gameGb / totalGb) * 100)
          + '%，系统可能因为内存不足而卡顿，也可能启动失败。';
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
      if (stage) { stage.textContent = '下载失败：' + d.error; }
      if (pct) { pct.textContent = ''; }
      tbState.running = false;
      return;
    }

    fill.style.background = '';
    var percent = d.total > 0 ? Math.min(100, (d.done / d.total) * 100) : 0;
    fill.style.width = Math.max(d.done > 0 ? 2 : 0, percent) + '%';

    if (stage) {
      if (d.finished) {
        stage.textContent = '已保存 ' + (d.fileName || '文件') + '（' + fmtBytes(d.done || d.total) + '）';
      } else if (d.total > 0) {
        stage.textContent = fmtBytes(d.done) + ' / ' + fmtBytes(d.total);
      } else {
        stage.textContent = fmtBytes(d.done) + ' 已下载';
      }
    }
    if (pct) {
      pct.textContent = d.total > 0 ? Math.round(percent) + '%' : '';
    }
    if (d.finished) { tbState.running = false; }
  }

  function initToolbox() {
    var start = document.getElementById('tb-start');
    if (start) {
      start.addEventListener('click', function () {
        if (tbState.running) { return; }
        var url = document.getElementById('tb-url').value.trim();
        if (!url) { toast('先填个下载地址', 'error'); return; }
        if (!/^https?:\/\//i.test(url)) { toast('地址要以 http:// 或 https:// 开头', 'error'); return; }
        var dir = document.getElementById('tb-dir').value.trim();
        var name = document.getElementById('tb-name').value.trim();
        var threads = Number(document.getElementById('tb-threads').value) || 8;

        tbState.running = true;
        renderToolboxProgress({ done: 0, total: 0 });
        call('toolboxDownload', url, dir, name, threads);
      });
    }

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
        if (out) { out.textContent = '正在清理…'; }
        call('cleanupJunk');
      });
    }
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
    bindSetting('set-offline-account', 'setLauncherSetting', 'enableOfflineAccount');
    bindSetting('set-log-lines', 'setLauncherSetting', 'logLines');

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
    bindSetting('set-quick-play', 'setGameSetting', 'quickPlay');
    bindSetting('set-quick-sp', 'setGameSetting', 'quickPlaySingleplayer');
    bindSetting('set-quick-mp', 'setGameSetting', 'quickPlayMultiplayer');
    bindSetting('set-addon-source', 'setLauncherSetting', 'defaultAddonSource');

    var quickPlay = document.getElementById('set-quick-play');
    if (quickPlay) {
      quickPlay.addEventListener('change', function () { syncQuickPlayRows(this.value); });
    }

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
    bindSetting('set-not-check-game', 'setGameSetting', 'notCheckGame');
    bindSetting('set-allow-agent', 'setGameSetting', 'allowAutoAgent');
    bindSetting('set-disable-auto-options', 'setGameSetting', 'disableAutoGameOptions');

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
      name.textContent = '当前无已安装实例版本';
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
    meta.appendChild(el('span', null, '上次启动 ' + fmtTime(inst.lastLaunch)));
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

      // 和实例列表里的「管理」同一去处：进这个实例的设置页。
      // 以前这里直接开安装弹窗，一个 ⚙ 点出「安装新游戏」很容易误触，也跟列表不一致。
      var manage = el('button', 'icon-edit icon-manage', '⚙');
      manage.title = '管理';
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
      pager.title = '点击切换到第 ' + (homeInstPage + 2 > pages ? 1 : homeInstPage + 2) + ' 页';
      pager.appendChild(el('span', 'pg-count', (homeInstPage + 1) + ' / ' + pages));
      pager.appendChild(el('strong', null,
        homeInstPage + 1 >= pages ? '回到第一页' : '下一页'));
      pager.appendChild(el('span', 'pg-hint', '共 ' + all.length + ' 个实例'));
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

  function openLogin(kind) {
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
      document.getElementById('lm-stage').textContent = '正在申请登录代码…';
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
    document.getElementById('la-add-hint').textContent = '名称等信息会自动从皮肤站读取';
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
    if (name.length > 16) { return '不能超过 16 个字符'; }
    if (!PROFILE_NAME_RE.test(name)) { return '只能用英文字母、数字和下划线'; }
    return '';
  }

  function syncOfflineHint() {
    var input = document.getElementById('lo-name');
    var hint = document.getElementById('lo-hint');
    var ok = document.getElementById('lo-ok');
    if (!input) { return; }
    var err = offlineNameError(input.value.trim());
    if (hint) {
      hint.textContent = err ? ('用户名' + err) : '';
      hint.hidden = !err;
    }
    if (ok) {
      ok.disabled = !!err || !input.value.trim();
    }
  }

  function submitOffline() {
    var name = document.getElementById('lo-name').value.trim();
    var err = offlineNameError(name);
    if (err) { toast('用户名' + err, 'error'); return; }
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
    hint.textContent = '正在读取皮肤站信息…';
    apiCall('addAuthlibServer', [url]).then(function () {
      // 结果由 onAuthlibServers 推回来，这里只兜住失败时把提示还原
      setTimeout(function () {
        if (hint.textContent === '正在读取皮肤站信息…') {
          hint.textContent = '名称等信息会自动从皮肤站读取';
        }
      }, 8000);
    });
  }

  function initLoginModals() {
    // 三张登录卡片
    var cards = document.querySelectorAll('[data-login]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function () {
        openLogin(this.getAttribute('data-login'));
      });
    }

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
      // 右键：改名 / 复制账号 ID / 删除。正版与外置认证不给改名——
      // 它们的名字由服务器决定，本地改了下次拉 profile 又变回去。
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openAccountMenu(e.clientX, e.clientY, a);
      });
      list.appendChild(row);
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
          askName('修改「' + acc.name + '」的昵称', acc.name).then(function (value) {
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
        askConfirm('删除账号「' + acc.name + '」？').then(function (yes) {
          if (yes) { call('removeAccount', acc.uuid); }
        });
      }
    });

    showContextMenu(x, y, items);
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
      var nameCell = el('span', 'col-name', inst.name);
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
      row.title = '打开「' + inst.name + '」的管理页面';
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
      box.appendChild(el('div', 'empty', '动态加载失败：' + news.error));
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
    if (title) { title.textContent = meta.title; }
    if (desc) { desc.textContent = meta.desc; }
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
    }
  }

  function go(page) {
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

    // 外观页的待机摆动靠 Java 侧定期重绘，离开页面要停掉
    call('setPreviewActive', page === 'appearance');

    if (page === 'download') {
      showDownload();
    } else if (page === 'appearance') {
      showAppearance();
    } else {
      if (call('hidePreview') === null) { /* 老版本桥没有这个方法时忽略 */ }
    }
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
    if (btn) { btn.title = open ? '收起侧栏' : '展开侧栏'; }
    if (label) { label.textContent = open ? '收起侧栏' : '展开侧栏'; }
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
    if (btn) { btn.title = (!now && railOpen()) ? '收起侧栏' : '展开侧栏'; }
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


  // ---------------- 外观：主题色 / 背景图 ----------------
  //
  // 借用 QQ-Bot 的配色模型：主色 + soft 两档，亮色/暗色各存一套。
  // 同一个色相在深底上必须提亮，否则按钮文字和背景糊在一起。
  // 背景图那边也一样：格式按文件头判断（后端做），SVG 一律拒绝。

  /// 默认值就是第一个预设（靛蓝）
  var APPEARANCE = { hue: 228, lum: 62, shade: 68 };

  function hsl(h, s, l) {
    return 'hsl(' + h + ' ' + s + '% ' + l + '%)';
  }

  /// 把主题色铺到 CSS 变量上，顺带更新色相环上的小圆点
  function applyAccent(hue, lum) {
    var root = document.documentElement;
    root.style.setProperty('--a1', hsl(hue, 86, lum));
    // 暗色提亮 12 个百分点封顶 82：再亮就发白，按钮上的白字会看不清
    root.style.setProperty('--a2', hsl(hue, 84, Math.min(82, lum + 12)));
    root.style.setProperty('--as1', hsl(hue, 78, 96));
    root.style.setProperty('--as2', hsl(hue, 30, 18));

    // 色相环上的白点：0° 在正上方，conic-gradient 的 from 90deg 也以正上方为起点
    var dot = document.getElementById('hue-dot');
    if (dot) {
      var rad = (hue - 90) * Math.PI / 180;
      var r = 48;
      dot.style.transform = 'translate(' + (Math.cos(rad) * r).toFixed(1) + 'px,'
        + (Math.sin(rad) * r).toFixed(1) + 'px)';
    }
    var core = document.getElementById('hue-core');
    if (core) { core.style.background = hsl(hue, 86, lum); }

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
    var thumb = document.getElementById('bg-thumb');
    var img = document.getElementById('bg-thumb-img');
    if (thumb && img) {
      thumb.hidden = !dataUrl;
      if (dataUrl) { img.src = dataUrl; }
    }
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
        applyAccent(hue, lum);
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
        applyAccent(Math.round(deg) % 360, APPEARANCE.lum);
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
        applyAccent(APPEARANCE.hue, Number(this.value));
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
        apiCall('chooseBackground', []).then(function (raw) {
          var dataUrl = typeof raw === 'string' ? raw : '';
          if (!dataUrl) { return; }
          applyBackground(dataUrl);
        });
      });
    }
    var clear = document.getElementById('bg-clear');
    if (clear) {
      clear.addEventListener('click', function () {
        call('clearBackground');
        applyBackground('');
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
      var shadev = Number(d.bgShade);
      applyAccent(
        Number.isFinite(hue) ? hue : 228,
        Number.isFinite(lumv) && lumv > 0 ? lumv : 62
      );
      applyShade(Number.isFinite(shadev) && shadev > 0 ? shadev : 68);
      if (d.background) { applyBackground(String(d.background)); }
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
  var dlFilter = 'release';   // release | all | snapshot | old
  var dlQuery = '';
  var dlInstalling = null;
  // 正在跑的任务：id -> {percent, stage}。percent 为 -1 表示这一步没有量化进度
  var dlTasks = {};

  // 清单有 900+ 条：全渲染会明显拖慢滚动（节点多一倍，滚动时布局与绘制都翻倍）。
  // 150 条足够覆盖「最新几个正式版」，更早的用搜索。
  var DL_MAX_ROWS = 150;

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

  function renderDownloadList() {
    var box = document.getElementById('dl-list');
    if (!box) { return; }
    box.innerHTML = '';

    if (!dlVersions) {
      var verLoad = el('div', 'empty');
      verLoad.appendChild(loadingRow('正在从 Mojang 拉取版本清单…'));
      box.appendChild(verLoad);
      return;
    }

    var q = dlQuery.trim().toLowerCase();
    var rows = (dlVersions.versions || []).filter(function (v) {
      if (!matchFilter(v.type)) { return false; }
      return !q || String(v.id).toLowerCase().indexOf(q) >= 0;
    });

    var count = document.getElementById('dl-count');
    if (count) {
      count.textContent = rows.length + ' 个版本' + (rows.length > DL_MAX_ROWS
        ? '（显示前 ' + DL_MAX_ROWS + ' 个）' : '');
    }

    if (!rows.length) {
      box.appendChild(el('div', 'empty', q ? '没有匹配「' + dlQuery + '」的版本。' : '这个分类下没有版本。'));
      return;
    }

    var head = el('div', 'dl-row head');
    ['版本', '类型', '发布日期', ''].forEach(function (t) { head.appendChild(el('span', null, t)); });
    box.appendChild(head);

    rows.slice(0, DL_MAX_ROWS).forEach(function (v) {
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
  }

  // ---------------- 安装选项弹窗（原版 / 加载器） ----------------

  var lmGame = null;      // 要装的游戏版本
  var lmType = '';        // '' = 原版，其余是 patchId
  var lmVersion = null;   // 选中的加载器版本
  var lmVersions = null;  // 当前类型的版本数组，null = 还没拉

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
        redo.title = '重新安装';
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
        sub = support === 'unsupported' ? ('不支持 ' + lmGame) : '检查可用版本…';
        blocked = true;
      } else if (item.addon) {
        var need = ADDON_NEEDS[item.id];
        if (lmType !== need) {
          // 主加载器没选对：已经选了别的就报不兼容，什么都没选就说缺什么
          sub = lmType ? ('与 ' + installerLabel(lmType) + ' 不兼容') : ('需要 ' + installerLabel(need));
          blocked = true;
        } else {
          var addonClash = clashWith(item.id, activeIds);
          if (addonClash) { sub = '与 ' + installerLabel(addonClash) + ' 不兼容'; blocked = true; }
          // 不选也会装（Cleanroom 这两个是必需品），写成「默认最新」比「可选」准确
          else { sub = '默认最新'; }
        }
      } else {
        var clash = clashWith(item.id, activeIds);
        if (clash) { sub = '与 ' + installerLabel(clash) + ' 不兼容'; blocked = true; }
        else { sub = '未选择'; }
      }

      if (blocked) { card.classList.add('disabled'); }
      if (support === 'pending' && !blocked) { card.classList.add('disabled'); }
      card.appendChild(el('div', 'im-sub', sub));

      if (picked) {
        // 已选中的卡片：右上角给「✕ 取消选择」和「重选」。
        // 版本小窗的「取消」只关窗不改状态，想退回未选状态得点这里的 ✕
        // （HMCL 也是这个逻辑：取消选版本 = 放弃本次更换，不等于卸载）。
        var clear = el('button', 'im-again im-clear', '✕');
        clear.title = '取消选择';
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
      toast('Cleanroom 只支持 ' + def.onlyGame, 'error');
      return;
    }
    // 卡片置灰只是界面层，这里再挡一道：不支持的游戏版本不进版本弹窗
    // 附属组件（Fabric API / Fugue / Scalar）不走加载器支持清单，它们自己查
    var support = (def && def.addon) ? 'ok' : imSupport[type];
    if (support === 'unsupported') {
      toast(installerLabel(type) + ' 没有 ' + lmGame + ' 的版本', 'error');
      return;
    }
    if (support === 'unavailable') {
      toast(installerLabel(type) + ' 的版本清单不可用', 'error');
      return;
    }

    // 只记「这次在给谁选」，不动 lmType——用户点取消时其他卡片应该还是原样
    verTargetType = type;
    verTargetIsAddon = !!(def && def.addon);
    lmVersions = null;
    verPick = null;
    verShown = [];

    document.getElementById('ver-title').textContent = '选择 ' + installerLabel(type) + ' 版本';
    // 标题只说「选什么」，这里补一句「给哪个游戏版本选、选完怎么生效」
    document.getElementById('ver-sub').textContent =
      'Minecraft ' + lmGame + ' · 选中后点「确定」生效';

    var list = document.getElementById('ver-list');
    list.innerHTML = '';
    list.appendChild(el('div', 'lm-empty', '正在拉取版本列表…'));

    setVerPick(null);
    document.getElementById('ver-modal').classList.remove('hidden');

    if (verTargetIsAddon) {
      call('requestAddonVersions', type, lmGame);
    } else {
      call('requestLoaderVersions', lmGame, type);
    }
  }

  function closeVersionPicker() {
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
        tag.textContent = '还没选版本';
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

  function renderVersionPicker(errorText) {
    var list = document.getElementById('ver-list');
    if (!list) { return; }
    list.innerHTML = '';
    verShown = [];

    if (errorText) {
      list.appendChild(el('div', 'lm-empty', errorText));
      setVerPick(null);
      return;
    }

    if (!lmVersions || !lmVersions.length) {
      list.appendChild(el('div', 'lm-empty',
        '这个游戏版本没有可用的 ' + installerLabel(verTargetType) + ' 版本。'));
      setVerPick(null);
      return;
    }

    verShown = lmVersions.slice(0, LM_MAX);

    verShown.forEach(function (v) {
      var row = el('div', 'lm-item');
      row.setAttribute('data-ver', v);
      row.appendChild(el('span', null, v));
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

    if (lmVersions.length > verShown.length) {
      list.appendChild(el('div', 'lm-empty',
        '还有 ' + (lmVersions.length - verShown.length) + ' 个更早的版本未显示。'));
    }

    // 预选：正在装的这个类型已经有版本就用它（进来改版本时不会丢上下文），
    // 否则选最新一个——但「预选」只是高亮，仍然要用户亲自点确定
    var preset = (lmType === verTargetType && lmVersion && lmVersions.indexOf(lmVersion) >= 0)
      ? lmVersion
      : lmVersions[0];
    setVerPick(preset);
    highlightVerPick();
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

    // 键盘：Enter 确定、Esc 取消、上下切版本。
    // 挂 document 上是因为弹窗本身不接收焦点；先判可见，别的页面敲回车不受影响。
    document.addEventListener('keydown', function (e) {
      var vm = document.getElementById('ver-modal');
      if (!vm || vm.classList.contains('hidden')) { return; }
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
      text.textContent = '下载';
      btn.title = '下载任务';
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
      text.textContent = '下载中';
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
        // 已经结束了，取消按钮没有意义，只留「移除这条」
        if (row.cancel) { row.cancel.hidden = true; }
        row.row.classList.add('failed');
        row.pct.textContent = '';
        row.pct.hidden = true;
        row.bar.hidden = true;
        row.foot.textContent = t.error;
        row.foot.classList.add('dlt-err');
        // 失败的任务不自动消失：用户得能看到到底为什么失败
        if (!row.close) {
          var close = el('button', 'dlt-close', '✕');
          close.title = '移除这条任务';
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

      // 运行中给一个 ✕：下载/安装中途不想要了可以直接停掉。
      // 后端 executor.cancel() 会把任务停掉并推一条 done=cancelled。
      if (!row.cancel) {
        var cancelBtn = el('button', 'dlt-close dlt-cancel', '✕');
        cancelBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          cancelBtn.disabled = true;
          cancelBtn.title = '正在取消…';
          call('cancelDownload', id);
        });
        row.row.querySelector('.dlt-head').appendChild(cancelBtn);
        row.cancel = cancelBtn;
      }
      row.cancel.hidden = false;
      if (!row.cancel.disabled) { row.cancel.title = '取消这个任务'; }

      var hasPct = t.percent >= 0;
      row.pct.hidden = false;
      row.bar.hidden = false;
      row.pct.textContent = hasPct ? Math.round(t.percent * 100) + '%' : '';
      row.bar.classList.toggle('indeterminate', !hasPct);
      row.fill.style.width = (hasPct ? Math.max(3, Math.round(t.percent * 100)) : 100) + '%';
      row.foot.textContent = t.stage || '';
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

  function showInstancePage(id) {
    if (!id) { return; }
    instId = id;
    instData = null;
    instContentKind = 'mod';

    // 头部先用列表里已有的数据填一遍，别等接口回来才显示（会闪一下空白）
    var cached = ((state && state.instances) || []).filter(function (x) { return x.id === id; })[0];
    renderInstanceHero(cached);
    clearInstanceDetail();

    setInstTab('settings');
    go('instance');
    loadInstanceDetail();
    // 崩溃报告和详情并行查：这条只影响顶部提示条，不挡内容渲染
    checkInstanceCrash();
  }

  function loadInstanceDetail() {
    if (!instId) { return; }
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
    var installers = document.getElementById('itab-installers');
    var content = document.getElementById('itab-content');

    // 先把内容区填上骨架再显示：原来顺序是「先显示空的、再填 loading」，
    // 中间那一帧就是截图里那块白闪。切标签时也不该整页重渲染，
    // 所以这里只在可见性上做文章。
    if (isContent) {
      var box = document.getElementById('inst-content-list');
      if (box) {
        box.innerHTML = '';
        box.appendChild(loadingRow('正在读取…'));
      }
      var title = document.getElementById('inst-content-title');
      if (title) { title.textContent = INST_KIND_NAMES[tab]; }
    }

    if (settings) { settings.hidden = tab !== 'settings'; }
    if (installers) { installers.hidden = tab !== 'installers'; }
    if (content) { content.hidden = !isContent; }

    if (tab === 'installers') {
      loadInstInstallers();
    } else if (tab === 'mod') {
      // 和下面的 isContent 分支做同样的事，额外跑一次依赖检查
      instContentKind = tab;
      var modTitle = document.getElementById('inst-content-title');
      if (modTitle) { modTitle.textContent = INST_KIND_NAMES[tab]; }
      loadInstContent(tab);
      scanInstanceMods();
    } else if (tab === 'world') {
      loadInstWorlds();
    } else if (tab === 'screenshot') {
      loadInstScreenshots();
    } else if (isContent) {
      instContentKind = tab;
      loadInstContent(tab);
      // 这里原来还会 loadInstanceDetail() 顺带刷计数，但那是整页重渲染
      // （hero 图标、设置项全换一遍），正是切标签闪烁的来源。计数留给
      // 下次进页面时刷，标签切换只换内容。
    }
  }

  function loadInstInstallers() {
    var box = document.getElementById('inst-installer-list');
    if (!box || !instId) { return; }
    box.innerHTML = '';
    box.appendChild(loadingRow('正在读取已安装的加载器…'));

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
          items.push({ v: current, t: current + '  (已不存在)', selected: true });
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
    box.innerHTML = '';
    box.appendChild(loadingRow('正在读取存档…'));
    apiCall('instanceWorlds', [instId]).then(function (raw) {
      if (instTab !== 'world') { return; }
      renderInstWorlds(asJson(raw));
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
      sub.push(w.lastPlayed ? ('最后游玩 ' + fmtTime(w.lastPlayed)) : '还没进过');
      if (w.backups) { sub.push(w.backups + ' 个备份'); }
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
      act('备份', '打包到 backups/' + w.file + '/', function (button) {
        button.disabled = true;
        apiCall('worldAction', [instId, 'backup', w.file, '']).then(function (raw) {
          var r = asJson(raw);
          button.disabled = false;
          if (r && r.error) { toast(r.error, 'error'); }
          else { toast('已备份：' + ((r && r.file) || ''), 'ok'); }
          loadInstWorlds();
        });
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
        askConfirm('把存档「' + (w.name || w.file) + '」移到回收站？').then(function (yes) {
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
    box.innerHTML = '';
    box.appendChild(loadingRow('正在读取截图…'));
    apiCall('instanceScreenshots', [instId]).then(function (raw) {
      if (instTab !== 'screenshot') { return; }
      renderInstScreenshots(asJson(raw));
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
      card.title = shot.file + '\n双击用系统默认程序打开，右键更多操作';

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
              askConfirm('删除截图「' + shot.file + '」？（移到回收站）').then(function (yes) {
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

  // ---------------- 实例体检：崩溃分析 / 依赖检查 ----------------

  var instCrashInfo = null;
  var instScanInfo = null;

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
      if (title) { title.textContent = d.title ? ('上次崩溃：' + d.title) : '上次启动崩溃了'; }
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
      if (missing.length) { bits.push('缺 ' + missing.length + ' 个前置'); }
      if (dup.length) { bits.push(dup.length + ' 个模组重复安装'); }
      document.getElementById('inst-scan-title').textContent = '依赖检查：' + bits.join(' · ');

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

  /// 崩溃分析弹窗：结论 → 建议 → 可疑模组 → 原文摘要。
  function showCrashModal() {
    var d = instCrashInfo;
    var box = document.getElementById('crash-content');
    if (!box) { return; }
    box.innerHTML = '';
    if (!d) { return; }
    var modalTitle = document.getElementById('crash-modal-title');
    if (modalTitle) { modalTitle.textContent = '崩溃分析'; }

    var head = el('div', 'crash-headline');
    head.appendChild(el('h4', null, d.title || '崩溃原因未归类'));
    head.appendChild(el('p', null, d.detail || ''));
    box.appendChild(head);

    var meta = [];
    if (d.file) { meta.push(d.file); }
    if (d.time) { meta.push(fmtTime(d.time)); }
    if (d.size) { meta.push(fmtSize(d.size)); }
    if (meta.length) {
      box.appendChild(el('div', 'ib-sub', meta.join(' · ')));
    }

    if (d.hints && d.hints.length) {
      var sec = el('div', 'crash-sec');
      sec.appendChild(el('h5', null, '怎么办'));
      var ul = el('ul', 'crash-hints');
      d.hints.forEach(function (h) { ul.appendChild(el('li', null, h)); });
      sec.appendChild(ul);
      box.appendChild(sec);
    }

    if (d.suspects && d.suspects.length) {
      var sec2 = el('div', 'crash-sec');
      sec2.appendChild(el('h5', null, '可疑模组'));
      var list = el('div', 'crash-mods');
      d.suspects.forEach(function (s) {
        var row = el('div', 'crash-mod');
        row.appendChild(el('span', null, s.file || '（找不到对应 jar）'));
        row.appendChild(el('span', 'pkg', s.package));
        row.appendChild(el('span', 'hits', s.hits + ' 次'));
        list.appendChild(row);
      });
      sec2.appendChild(list);
      box.appendChild(sec2);
    }

    if (d.excerpt) {
      var sec3 = el('div', 'crash-sec');
      sec3.appendChild(el('h5', null, '报告原文（前 60 行）'));
      var pre = el('pre', 'crash-raw');
      pre.textContent = d.excerpt;
      sec3.appendChild(pre);
      box.appendChild(sec3);
    }

    openModal('crash-modal');
  }

  /// 依赖检查详情：缺什么、谁需要、重复的是哪几个文件。
  function showScanModal() {
    var d = instScanInfo;
    var box = document.getElementById('crash-content');
    if (!box || !d) { return; }
    box.innerHTML = '';
    var modalTitle = document.getElementById('crash-modal-title');
    if (modalTitle) { modalTitle.textContent = '依赖检查'; }

    var head = el('div', 'crash-headline');
    head.appendChild(el('h4', null, '依赖检查'));
    var total = (d.mods || []).length;
    head.appendChild(el('p', null,
      '扫了 ' + total + ' 个模组：缺 ' + (d.missing || []).length + ' 个前置，'
      + (d.duplicates || []).length + ' 个模组重复安装。'));
    box.appendChild(head);

    if ((d.missing || []).length) {
      var sec = el('div', 'crash-sec');
      sec.appendChild(el('h5', null, '缺少的前置'));
      var list = el('div', 'scan-list');
      d.missing.forEach(function (m) {
        var row = el('div', 'scan-row');
        row.appendChild(el('span', 'need', m.needs));
        row.appendChild(el('span', null, '被「' + m.mod + '」需要' + (m.range ? ('（' + m.range + '）') : '')));
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

  function loadInstContent(kind) {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    box.innerHTML = '';
    box.appendChild(loadingRow('正在读取…'));

    apiCall('instanceAddons', [instId, kind]).then(function (raw) {
      // 期间用户可能已经切了标签
      if (instTab !== kind) { return; }
      renderInstContent(kind, asJson(raw));
    });
  }

  function renderInstContent(kind, data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';

    if (!data || data.error) {
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    // 目录不存在是常态（新实例没有 shaderpacks），当成空列表
    var items = data.items || [];
    if (!items.length) {
      box.appendChild(el('div', 'inst-empty', INST_EMPTY[kind] || '这里还没有内容'));
      return;
    }

    var isWorld = kind === 'world';
    // 只有「游戏会按扩展名决定加不加载」的三类才值得给开关。
    // 存档是目录，改名成 .disabled 没有意义；蓝图和截图根本不参与加载，加了也是误导。
    var canToggle = kind === 'mod' || kind === 'resourcepack' || kind === 'shader';
    items.forEach(function (item) {
      var row = el('div', 'inst-item' + (item.disabled ? ' off' : ''));

      if (canToggle) {
        var toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'set-check';
        toggle.checked = !item.disabled;
        toggle.title = item.disabled ? '点击启用' : '点击禁用';
        toggle.addEventListener('change', function () {
          apiCall('setAddonEnabled', [instId, kind, item.fileName, this.checked])
            .then(function () { refreshInstContent(kind); });
        });
        row.appendChild(toggle);
      }

      var main = el('div', 'inst-item-main');
      var line = el('div', 'inst-item-title', item.name);
      main.appendChild(line);
      var sub = [];
      // 存档只能报 level.dat 的大小，加个单位说明，免得被当成整个存档的体积
      sub.push(isWorld ? (fmtSize(item.size || 0) + ' level.dat') : fmtSize(item.size || 0));
      main.appendChild(el('div', 'inst-item-sub', sub.join(' · ')));
      row.appendChild(main);

      var acts = el('div', 'inst-item-acts');
      var remove = el('button', 'icon-btn', '✕');
      remove.title = '删除';
      remove.addEventListener('click', function () {
        askConfirm('删除「' + item.name + '」？').then(function (yes) {
          if (!yes) { return; }
          apiCall('removeAddon', [instId, kind, item.fileName]).then(function () {
            refreshInstContent(kind);
          });
        });
      });
      acts.appendChild(remove);
      row.appendChild(acts);

      box.appendChild(row);
    });
  }

  /// 删 / 禁用之后：重载当前列表，同时刷新标签上的计数
  function refreshInstContent(kind) {
    if (instTab === kind) { loadInstContent(kind); }
    loadInstanceDetail();
  }


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
        label: '测试启动',
        action: function () { call('launchTest', instId); }
      },
      {
        label: '重命名…',
        action: function () {
          askName('把「' + name + '」改成', name).then(function (value) {
            if (value && value.trim() && value.trim() !== name) {
              call('instanceRename', instId, value.trim());
            }
          });
        }
      },
      {
        label: '复制实例…',
        action: function () {
          askName('复制出来的实例叫什么名字', name + '-副本').then(function (value) {
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
          askConfirm('删除「' + name + '」？这个操作不可撤销，实例目录会被整个删掉。').then(function (yes) {
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
        renderDownloadList();
      });
    }

    var search = document.getElementById('dl-search');
    if (search) {
      search.addEventListener('input', function () {
        dlQuery = this.value || '';
        renderDownloadList();
      });
    }

    var refresh = document.getElementById('dl-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        dlVersions = null;
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

    enhanceSelect(document.getElementById('ad-sort'));
    enhanceSelect(document.getElementById('ad-instance'));

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
        adInstanceId = this.value;
        adInstanceTouched = true;   // 用户自己选过就别再自动改了
        adPage = 0;
        requestAddonSearch();
      });
    }

    var adImport = document.getElementById('ad-import');
    if (adImport) {
      adImport.addEventListener('click', importLocalAddon);
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
      dlcBrowse.addEventListener('click', function () {
        chooseSaveDirectory(document.getElementById('dlc-hint'));
      });
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
  var adInstanceId = '';
  /// 用户手动改过「实例」下拉没有。手动改过就不再自动跟当前实例，
  /// 否则选「暂未选择实例」会在下一次状态推送时被撤销。
  var adInstanceTouched = false;
  var adSearchTimer = null;
  // 搜索请求序号。连点类别芯片会同时发出多个请求，回来的顺序不保证；
  // 只有 seq 等于当前值的响应才算数，其余直接丢。
  var adReqSeq = 0;

  // 类别标签。数据来自 Modrinth 的 /v2/tag/category，接口给什么就显示什么，
  // 不在前端写死列表——它加新类别（adventure / quests 都是后加的）时不用改代码。
  var adCatGroups = [];   // 当前类型的 [{key, items:[{slug}]}]
  var adCatCache = {};    // type -> groups，切走再切回来不重新拉
  var adCatAsked = {};    // type -> true，一个类型只请求一次
  var adCatSel = {};      // slug -> true。多选：组内 OR、组间 AND（Modrinth facets 语义）

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

  /// 类别芯片上的文字。没翻译过的 slug 折成「Kitchen Sink」这种标题式，
  /// 比原样打印 `kitchen-sink` 好看，也不用为了一个新类别去改代码。
  function adCatLabel(slug) {
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
    if (!adInstanceId) { return null; }
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === adInstanceId) { return list[i]; }
    }
    return null;
  }

  /// 筛选用的游戏版本。模组 / 资源包 / 光影都吃实例的版本；
  /// 没选实例就返回空，表示不筛。
  function adGameVersion() {
    var inst = adInstance();
    return inst ? (inst.gameVersion || '') : '';
  }

  function adLoader() {
    // 世界是整包 zip，没有加载器概念。CurseForge 的 world 搜索也不吃这个参数，
    // 真发过去反而会让「推荐」判据永远不成立。
    if (adType === 'world') { return ''; }
    var inst = adInstance();
    if (!inst) { return ''; }
    var loader = inst.loader || '';
    // 中文标签（原版 / 未知）不是 Modrinth 的 loader 名，当成不筛
    if (!loader || loader === '原版' || loader === '未知') { return ''; }
    return loader;
  }

  function switchDownloadTab(tab) {
    dlTab = tab;
    var btns = document.querySelectorAll('#dl-tabs button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-dltab') === tab);
    }
    document.getElementById('dl-pane-game').hidden = tab !== 'game';
    document.getElementById('dl-pane-addon').hidden = tab === 'game';

    if (tab === 'game') { return; }

    var prevType = adType;
    adType = tab;
    adPage = 0;
    adItems = [];
    adTotalPages = 0;
    // 类别是按资源类型分的（模组一套、资源包三组、光影三组），换 tab 必须清空，
    // 否则 `adventure` 这种模组类别会被带到资源包查询里，facets 一筛就是零结果
    adCatSel = {};
    // 换分类顺手清掉搜索词：模组里搜的「sodium」带到整合包/光影里必然零结果，
    // 用户只看到「没有搜到内容」，第一反应是下载源挂了。同一个 tab 重复点不清，
    // 免得手抖点一下就得重打一遍。
    if (tab !== prevType && adQuery) {
      adQuery = '';
      var searchBox = document.getElementById('ad-search');
      if (searchBox) { searchBox.value = ''; }
    }
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
        if (it.id === adInstanceId) { o.selected = true; }
        inst.appendChild(o);
      });

      // 有实例就默认挑当前那个：模组要跟版本和加载器对上才有意义，
      // 默认让它筛着，用户想看全量再手动切「暂未选择实例」。
      //
      // 只在用户没动过下拉时自动挑。否则用户选了「暂未选择实例」，
      // 下一次状态推送重建工具栏时又会被拽回当前实例，等于选不了。
      if (!adInstanceTouched && !adInstanceId && list.length) {
        var cur = currentInstance();
        if (cur) { adInstanceId = cur.id; inst.value = cur.id; }
      }
      if (!list.length) {
        adInstanceId = '';
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

    document.getElementById('ad-search').placeholder =
      adType === 'modpack' ? '搜索整合包…'
        : adType === 'mod' ? '搜索模组…'
          : adType === 'resourcepack' ? '搜索资源包…'
            : adType === 'shader' ? '搜索光影…' : '搜索世界…';
  }

  function addonSearchKey() {
    return [adType, adGameVersion(), adQuery, adPage, adSort, adLoader(), adCategory()].join('|');
  }

  // ---------------- 下载页：类别标签 ----------------

  /// 当前选中的类别，逗号分隔。后端直接拼进 facets 的 categories 组。
  function adCategory() {
    return Object.keys(adCatSel).join(',');
  }

  function requestAddonCategories() {
    var cached = adCatCache[adType];
    if (cached) {
      adCatGroups = cached;
      renderAddonCategories();
      return;
    }
    // 还没拿到就先隐藏整块，别让工具栏下面空出一截
    adCatGroups = [];
    renderAddonCategories();
    if (adCatAsked[adType]) { return; }
    adCatAsked[adType] = true;
    call('addonCategories', adType);
  }

  function renderAddonCategories() {
    var box = document.getElementById('ad-cats');
    if (!box) { return; }
    box.innerHTML = '';

    if (!adCatGroups.length) { box.hidden = true; return; }
    box.hidden = false;

    var cleared = Object.keys(adCatSel).length === 0;
    var first = true;

    adCatGroups.forEach(function (g) {
      var items = (g && g.items) || [];
      if (!items.length) { return; }

      var row = el('div', 'ad-cat-row');
      row.appendChild(el('span', 'ad-cat-group', AD_CAT_GROUP[g.key] || g.key));

      var chips = el('div', 'ad-cat-chips');

      // 「全部」只出现一次，放在第一组开头，点它清空所有勾选
      if (first) {
        first = false;
        var all = el('button', 'ad-chip' + (cleared ? ' on' : ''), '全部');
        all.type = 'button';
        all.addEventListener('click', function () {
          if (!Object.keys(adCatSel).length) { return; }
          adCatSel = {};
          renderAddonCategories();
          adPage = 0;
          requestAddonSearch();
        });
        chips.appendChild(all);
      }

      items.forEach(function (it) {
        var slug = it.slug;
        if (!slug) { return; }
        // 接口若同时给了显示名（CurseForge 的分类只有英文名），优先用它。
        // Modrinth 那套 slug 有现成中文词表，走 adCatLabel 兜底。
        var chip = el('button', 'ad-chip' + (adCatSel[slug] ? ' on' : ''), it.name || adCatLabel(slug));
        chip.type = 'button';
        chip.title = it.name || slug;
        chip.addEventListener('click', function () {
          if (adCatSel[slug]) { delete adCatSel[slug]; } else { adCatSel[slug] = true; }
          renderAddonCategories();
          adPage = 0;
          requestAddonSearch();
        });
        chips.appendChild(chip);
      });

      row.appendChild(chips);
      box.appendChild(row);
    });
  }

  function requestAddonSearch() {
    var grid = document.getElementById('ad-grid');

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
      adLoader(), adCategory(), String(adReqSeq));
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
      grid.appendChild(el('div', 'empty', friendlyError(data.error)));
      document.getElementById('ad-count').textContent = '';
      document.getElementById('ad-pager').hidden = true;
      return;
    }

    document.getElementById('ad-count').textContent =
      adTotalPages > 0 ? ('共 ' + adTotalPages + ' 页') : '';
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

  function renderAddonGrid() {
    var grid = document.getElementById('ad-grid');
    grid.innerHTML = '';

    if (!adItems.length) {
      grid.appendChild(el('div', 'empty', '没有搜到内容'));
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
      var meta = it.author ? ('作者 ' + it.author) : '';
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
    var q = new URLSearchParams(location.search);
    var port = q.get('port');
    if (!port) { return null; }
    var url = 'http://127.0.0.1:' + port + path;
    var parts = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null) { parts.push(k + '=' + encodeURIComponent(params[k])); }
      });
    }
    parts.push('token=' + encodeURIComponent(q.get('token') || ''));
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
    if (item.author) { subParts.push('作者 ' + item.author); }
    var instInfo = adInstance();
    if (instInfo) {
      var tag = instInfo.gameVersion || '';
      if (instInfo.loader && instInfo.loader !== '原版') {
        tag += (tag ? ' · ' : '') + instInfo.loader;
      }
      if (tag) { subParts.push('当前实例 ' + tag); }
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
        ? ('共 ' + adVersionTotal + ' 个版本')
        : (shown + ' / ' + adVersionTotal + ' 个版本');
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
        '还有 ' + (rows.length - shown.length) + ' 个更早的版本，用上面的筛选缩小范围。'));
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
      line2.appendChild(el('span', 'tag more', '+' + (gvs.length - 6) + ' 个版本'));
    }
    if (line2.childNodes.length) { info.appendChild(line2); }

    var line3 = el('div', 'adver-line3');
    if (v.date) { line3.appendChild(el('span', null, '更新于 ' + String(v.date).slice(0, 10))); }
    if (v.size > 0) { line3.appendChild(el('span', null, fmtSize(v.size))); }
    if (v.filename) { line3.appendChild(el('span', null, v.filename)); }
    if (v.downloads > 0) { line3.appendChild(el('span', null, fmtCount(v.downloads) + ' 次下载')); }
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
      var instId = AD_INSTANCE_TYPES[adType] ? adInstanceId : '';
      var hint = document.getElementById('dlc-hint');
      var dirInput = document.getElementById('dlc-dir');
      var browse = document.getElementById('dlc-browse');

      if (instId) {
        // 有实例：位置固定，不让改（改了就不是「装进实例」了）
        dirInput.value = '……';
        browse.hidden = true;
        hint.textContent = adType === 'mod' ? '会直接放进这个实例的 mods 文件夹'
          : adType === 'shader' ? '会直接放进这个实例的 shaderpacks 文件夹'
            : isWorld ? '会解压到这个实例的 saves 文件夹，启动游戏就能看到存档'
              : '会直接放进这个实例的资源包文件夹';
        apiCall('addonTargetDirectory', [adType, instId]).then(function (dir) {
          if (dlcItem === item && typeof dir === 'string' && dir) { dirInput.value = dir; }
        });
      } else {
        // 没实例：位置留空让用户自己挑。
        // 不在这里自动弹选择框——一进来就跳一个系统窗口太打扰，
        // 而且用户可能想先改文件名。点「浏览…」或「开始下载」时再弹。
        browse.hidden = false;
        dirInput.value = '';
        hint.textContent = '还没选实例，点「浏览…」挑一个保存位置';
      }
    }

    document.getElementById('dlc-modal').classList.remove('hidden');
    setTimeout(function () {
      var f = isPack ? document.getElementById('dlc-name2') : document.getElementById('dlc-name');
      if (f) { f.focus(); }
    }, 50);
  }

  function closeDownloadConfirm() {
    document.getElementById('dlc-modal').classList.add('hidden');
    dlcItem = null;
    dlcVersion = null;
  }

  /// 打开系统目录选择框填进输入框。hintEl 传提示那一行，取消时给一句说明。
  function chooseSaveDirectory(hintEl) {
    if (!new URLSearchParams(location.search).get('port')) {
      if (hintEl) { hintEl.textContent = '壳模式下才能弹目录选择框'; }
      return;
    }
    apiCall('chooseDirectory', ['选择保存位置']).then(function (value) {
      var dir = value ? String(value) : '';
      if (dir) {
        document.getElementById('dlc-dir').value = dir;
        if (hintEl) { hintEl.textContent = ''; }
      } else if (hintEl) {
        hintEl.textContent = '没选位置，点「浏览…」挑一个，或者先选个实例';
      }
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
      toast('开始下载整合包「' + item.title + '」');
      return;
    }

    var dir = document.getElementById('dlc-dir').value.trim();
    var fileName = document.getElementById('dlc-name').value.trim();
    var instId = AD_INSTANCE_TYPES[adType] ? adInstanceId : '';

    if (!dir) {
      // 没选位置就别开始：默认落到游戏根目录会让人找不到下到哪儿去了
      var hint = document.getElementById('dlc-hint');
      hint.textContent = '先挑一个保存位置';
      chooseSaveDirectory(hint);
      return;
    }

    closeDownloadConfirm();
    closeAddonVersions();
    // 有实例时 directory 传空，让后端按实例目录算（这条路上用户改不了位置）
    call('addonInstall', adType, item.slug, v.versionId, instId, fileName, instId ? '' : dir);
    toast('开始下载「' + item.title + ' ' + (v.version || v.versionId) + '」');
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
    var q = new URLSearchParams(location.search);
    var port = q.get('port');
    var token = q.get('token') || '';
    if (!port) {
      toast('本地导入只在壳模式可用', 'error');
      return;
    }

    var url = apiEndpoint('/api/upload/' + kind, {
      name: file.name,
      instanceId: adInstanceId || ''
    });

    toast('正在上传 ' + file.name + '（' + Math.round(file.size / 1048576) + ' MB）…');

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { toast('上传失败：' + ((j && j.error) || '未知错误'), 'error'); }
      })
      .catch(function (e) { toast('上传失败：' + e, 'error'); });
  }

  // ---------------- 外观页 ----------------

  var apData = null;
  var apTab = 'skin';
  var serverCapes = null;
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

      function opaque(x0) {
        var d = ctx.getImageData(x0, y, fw, fh).data;
        var n = 0;
        for (var i = 3; i < d.length; i += 4) {
          if (d[i] > 8) { n++; }
        }
        return n;
      }

      var fx = Math.round(24 * w / 64);
      var bx = Math.round(36 * w / 64);
      var front = opaque(fx);
      var back = opaque(bx);
      var total = fw * fh;

      // 差得明显才补，两面本来就画满的（自制贴图）不用动
      if (back > front * 2 && back > total * 0.05) {
        ctx.clearRect(fx, y, fw, fh);
        ctx.drawImage(out, bx, y, fw, fh, fx, y, fw, fh);
      } else if (front > back * 2 && front > total * 0.05) {
        ctx.clearRect(bx, y, fw, fh);
        ctx.drawImage(out, fx, y, fw, fh, bx, y, fw, fh);
      }

      // 翅膀是有厚度的板：侧面（2 宽）和顶/底（2 高）这两圈在原版贴图里
      // 是空的，从侧面看就是一条透明边，等于看穿了两层皮。这里拿正面的
      // 边缘像素逐行/逐列铺过去 —— 颜色跟着上下渐变走，看着就是一块实心板。
      var dw = Math.max(1, Math.round(2 * w / 64));
      var dh = Math.max(1, Math.round(2 * h / 32));
      var img = ctx.getImageData(0, 0, w, h);
      var data = img.data;
      var copyPixel = function (sx, sy, dx, dy) {
        var si = (sy * w + sx) * 4;
        var di = (dy * w + dx) * 4;
        data[di] = data[si];
        data[di + 1] = data[si + 1];
        data[di + 2] = data[si + 2];
        data[di + 3] = data[si + 3];
      };
      var yy, xx, i, j;
      for (yy = 0; yy < fh; yy++) {
        for (i = 0; i < dw; i++) {
          // 右外侧 = 正面左边缘，左外侧 = 正面右边缘（UV 布局就是这么排的）
          copyPixel(fx, y + yy, fx - dw + i, y + yy);
          copyPixel(fx + fw - 1, y + yy, fx + fw + i, y + yy);
        }
      }
      for (xx = 0; xx < fw; xx++) {
        for (j = 0; j < dh; j++) {
          // 顶面 = 正面第一行，底面 = 正面最后一行
          copyPixel(fx + xx, y, fx + xx, j);
          copyPixel(fx + xx, y + fh - 1, fx + fw + xx, j);
        }
      }
      ctx.putImageData(img, 0, 0);
      return out;
    } catch (e) {
      // 跨域画布读不了像素就原样返回，最多是背面好看、正面透
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

  /// 两个按钮只有「披风页 + 真的戴着披风」时才出现：没披风就没有贴图，
  /// 切鞘翅只会得到两只白板翅膀。
  ///
  /// `hasArt` 表示这件披风的贴图里画了鞘翅图案（合并图）。为真时在「鞘翅」
  /// 按钮上点一个小圆点 —— 不然用户看不出这件披风切过去是不是原版图案。
  function renderBackSeg(hasCape, hasArt) {
    var seg = document.getElementById('back-seg');
    if (!seg) { return; }
    var show = !!hasCape && wantsFrontend3d() && apTab === 'cape';
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
    // 摘掉披风时把「看鞘翅」的选择也归位：没有披风就谈不上鞘翅，
    // 留着状态下次戴披风会直接跳到鞘翅，和用户的预期不符
    if (!capeSrc) { backEquipment = 'cape'; }
    if (!capeSrc && apData.kind === 'microsoft') {
      var pending = apData.pendingServerCape;
      var list = serverCapes || [];
      if (pending === '') {
        capeSrc = null;                       // 用户明确摘掉了
      } else if (pending) {
        for (var ci = 0; ci < list.length; ci++) {
          if (list[ci].id === pending) { capeSrc = list[ci].raw || null; break; }
        }
      } else {
        // 没动过：用账号当前装备的那件。纹理还没到就先留空，
        // onCapePreview / onAppearance 到货后会再同步一次
        for (var cj = 0; cj < list.length; cj++) {
          if (list[cj].active && list[cj].raw) { capeSrc = list[cj].raw; break; }
        }
        if (!capeSrc) { capeSrc = apData.accountCapeRaw || null; }
      }
    }

    // 只有贴图或模型真的变了才重新加载。
    // skinview3d 的 loadSkin 每调一次都会重新建纹理，切宽体/纤体这种只改参数的操作
    // 再走一遍就会让 3D 区域闪白一下。
    var skinChanged = (skinSrc !== viewerSkinSrc) || (model !== viewerSkinModel);

    if (skinChanged && skinSrc) {
      viewerSkinSrc = skinSrc;
      viewerSkinModel = model;
      try { v.loadSkin(skinSrc, { model: model }); } catch (e) { console.error('[3d] loadSkin', e); }
    }

    if (capeSrc !== viewerCapeSrc) {
      viewerCapeSrc = capeSrc;
      var capeLoaded = null;
      try { capeLoaded = v.loadCape(capeSrc); } catch (e) { console.error('[3d] loadCape', e); }
      // 传字符串时 loadCape 返回 Promise（内部 new Image 异步解码）。
      // 必须等它真的画进 capeCanvas 再量鞘翅区和套纹理，否则量到的是上一张
      // 披风的内容 —— 表现就是「换了披风，小圆点和翅膀要再切一次页才更新」。
      Promise.resolve(capeLoaded).then(function () {
        if (v !== viewer) { return; }
        applyBackEquipment(v, !!capeSrc);
        renderBackSeg(!!capeSrc, !!capeSrc && capeHasElytraArt(v));
      });
    } else {
      applyBackEquipment(v, !!capeSrc);
      renderBackSeg(!!capeSrc, !!capeSrc && capeHasElytraArt(v));
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
      hint.textContent = '先在账号页登录一个账号。';
    } else if (kind === 'authlib') {
      hint.textContent = '外置认证账号的外观由平台管理，这里只做预览，请前往对应平台修改。';
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
      headCount.textContent = n > 0 ? n + ' 项' : '';
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
          onSelect: function () { call('selectSkin', ''); }
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
          // 内置皮肤（原版 Steve / Alex）不给重命名和删除入口
          onContext: (readOnly || s.builtin) ? null : [
            { label: '重命名', run: function () {
                askName('重命名皮肤', s.name).then(function (name) {
                  if (name) { call('renameSkin', s.id, name); }
                });
              } },
            { label: '删除', danger: true, run: function () { call('removeSkin', s.id); } }
          ]
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
          onSelect: function () { call('selectServerCape', ''); }
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
              onSelect: function () { call('selectServerCape', c.id); }
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
          current: true
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
            onContext: readOnly ? null : [
              { label: '重命名', run: function () {
                  askName('重命名披风', c.name).then(function (name) {
                    if (name) { call('renameCape', c.id, name); }
                  });
                } },
              { label: '删除', danger: true, run: function () { call('removeCape', c.id); } }
            ]
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

  function setActiveAnchor(id) {
    var nav = document.getElementById('settings-nav');
    if (!nav) { return; }
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
    var line = body.getBoundingClientRect().top + 90;
    var current = settingsAnchors[0];
    for (var i = 0; i < settingsAnchors.length; i++) {
      var sec = document.getElementById(settingsAnchors[i]);
      if (sec && sec.getBoundingClientRect().top <= line) { current = settingsAnchors[i]; }
    }
    setActiveAnchor(current);
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

  /// 「下载与网络」那一组：两个源下拉 + 线程数。
  function initDownloadSettings() {
    enhanceSelect(document.getElementById('set-version-source'));
    enhanceSelect(document.getElementById('set-file-source'));

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

  // ---------------- Java 回调入口 ----------------

  window.__hmcl = {
    onState: function (json) {
      try { state = JSON.parse(json); } catch (e) { console.error('bad state', e); return; }
      // 只在用户没手动选过主题时跟随 Java 侧（跟随系统/启动器设置）
      if (state.theme && !savedTheme()) { applyTheme(state.theme, false); }
      render();
    },
    /// 导入已有游戏目录的结果（Java 侧目录选择框选完之后回调）
    onGameDirectoryImported: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      if (!data.ok) {
        toast('导入失败：' + (data.error || '未知错误'), 'error');
        return;
      }
      if (data.versions > 0) {
        toast((data.added ? '已导入 ' : '已切换到 ') + (data.name || data.path)
          + ' · ' + data.versions + ' 个版本');
        // 目录已经切成当前目录，回主页就能看到实例卡片
        go('home');
      } else {
        toast('这个目录里没找到可用的版本，确认选的是 .minecraft 目录', 'error');
      }
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
      // 报错不缓存，下次切回来还会重试（网络抖动时不该永久空着）
      if (!data.error) { adCatCache[data.type] = data.groups || []; }
      if (data.type !== adType) { return; }
      adCatGroups = adCatCache[data.type] || [];
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
        out.textContent = '没有可清理的内容';
      } else {
        out.textContent = '清掉 ' + data.count + ' 个文件，释放 ' + fmtBytes(data.freed);
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

    onAddonVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== adType) { return; }

      if (data.error) {
        var list = document.getElementById('adver-list');
        list.innerHTML = '';
        list.appendChild(el('div', 'adver-empty', friendlyError(data.error)));
        return;
      }
      var items = data.items || [];
      if (adTarget) { cachePut(adVersionCache, addonVersionKey(adTarget.slug), items); }
      setAdverVersions(items, data.total || items.length);
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
      if (stage) { stage.textContent = '在浏览器打开下面的地址，输入这个代码：'; }
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
        toast('已登录：' + (data.message || ''));
        return;
      }
      // 失败：外置认证重新打开弹窗，让用户改完直接重试
      toast(data.flow === 'offline' ? ('离线登录失败：' + data.message)
        : data.flow === 'microsoft' ? ('微软登录失败：' + data.message)
          : ('外置认证失败：' + data.message), 'error');
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
        if (hint) { hint.textContent = '名称等信息会自动从皮肤站读取'; }
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
        lmVersions = [];
        renderVersionPicker('加载器版本拉取失败：' + data.error);
        return;
      }
      lmVersions = data.versions || [];
      // 不再在这里写 lmVersion：静默预选一个版本、用户直接点「安装」
      // 会把一个他从没确认过的版本装上。预选高亮交给 renderVersionPicker，
      // 真正落盘只发生在 commitVersionPick。
      renderVersionPicker();
    },
    /// 附属组件的版本清单到了。结构比加载器那条多一个 type，
    /// 复用同一个版本弹窗渲染。
    onAddonVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== verTargetType || !verTargetIsAddon) { return; }
      if (data.error) {
        lmVersions = [];
        renderVersionPicker('附属版本拉取失败：' + data.error);
        return;
      }
      lmVersions = (data.versions || []).map(function (v) { return v.version; });
      renderVersionPicker();
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

      // 拉版本清单结束也走这个通道，但它不是一次下载
      if (data.kind === 'versions') { return; }

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
            msg = '下载失败：' + msg;
          }
          dlTasks[id] = {
            title: (prev && prev.title) || id,
            stage: '',
            percent: -1,
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
    onServerCapes: function (json) {
      try { serverCapes = JSON.parse(json || '[]'); } catch (e) { serverCapes = []; }
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
