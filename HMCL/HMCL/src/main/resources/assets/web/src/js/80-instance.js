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

