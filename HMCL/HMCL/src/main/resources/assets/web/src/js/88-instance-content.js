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
    bindGraphicsSettings();
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

  /// 图形 API 与渲染器。
  ///
  /// 渲染器不是固定的两个选项：不同显卡、不同驱动能用的渲染器不一样，
  /// 而且 OpenGL 和 Vulkan 各有一套。所以选项由后端枚举（graphicsOptions），
  /// 这里只负责：切 API 时重新填渲染器列表、把值写到对应的设置项。
  function bindGraphicsSettings() {
    var apiSel = document.getElementById('inst-gfx-api');
    var renSel = document.getElementById('inst-renderer');
    if (!apiSel || !renSel) { return; }

    var options = { apis: [], renderers: {} };
    var currentRenderer = '';

    function fillApi() {
      var keep = apiSel.value;
      apiSel.innerHTML = '';
      (options.apis || []).forEach(function (a) {
        var o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.label || a.id;
        apiSel.appendChild(o);
      });
      apiSel.value = keep;
    }

    // 当前 API 决定渲染器写哪个字段：OpenGL 用 openGLRenderer，Vulkan 用 vulkanRenderer
    function rendererKey() {
      var api = apiSel.value;
      if (api === 'VULKAN') { return 'vulkanRenderer'; }
      if (api === 'OPENGL') { return 'openGLRenderer'; }
      // 跟随游戏版本时按刚才算出来的默认 API 决定
      return (options.defaultApi === 'VULKAN') ? 'vulkanRenderer' : 'openGLRenderer';
    }

    function fillRenderers(keep) {
      var api = apiSel.value === 'VULKAN' ? 'VULKAN'
        : apiSel.value === 'OPENGL' ? 'OPENGL'
        : (options.defaultApi || 'OPENGL');
      var list = (options.renderers || {})[api] || [];
      renSel.innerHTML = '';
      var auto = document.createElement('option');
      auto.value = '';
      auto.textContent = '自动';
      renSel.appendChild(auto);
      list.forEach(function (r) {
        var o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.label || r.id;
        renSel.appendChild(o);
      });
      var wanted = keep != null ? keep : currentRenderer;
      renSel.value = list.some(function (r) { return r.id === wanted; }) ? wanted : '';
    }

    function reload() {
      if (!instId) { return; }
      apiCall('graphicsOptions', [instId]).then(function (raw) {
        var d = asJson(raw);
        if (!d || !d.ok) { return; }
        options = d;
        fillApi();
        fillRenderers();
      });
    }

    apiSel.addEventListener('change', function () {
      if (!instId) { return; }
      call('instanceSetting', instId, 'graphicsBackend', apiSel.value);
      // 换了 API，渲染器列表整套都不一样，得重新填并清掉旧值
      currentRenderer = '';
      fillRenderers('');
      call('instanceSetting', instId, rendererKey(), '');
    });

    renSel.addEventListener('change', function () {
      if (!instId) { return; }
      currentRenderer = renSel.value;
      call('instanceSetting', instId, rendererKey(), renSel.value);
    });

    // 实例详情数据回来后填当前值
    var d = (instData && instData.game) || {};
    apiSel.value = d.graphicsBackend || '';
    currentRenderer = (d.graphicsBackend === 'VULKAN'
      ? d.vulkanRenderer : d.openGLRenderer)
      || d.openGLRenderer || d.vulkanRenderer || '';
    reload();
    fillRenderers(currentRenderer);
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

