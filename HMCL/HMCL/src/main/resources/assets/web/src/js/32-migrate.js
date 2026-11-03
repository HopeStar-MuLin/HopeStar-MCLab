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
