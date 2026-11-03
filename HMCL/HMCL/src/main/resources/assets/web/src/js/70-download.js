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
