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

