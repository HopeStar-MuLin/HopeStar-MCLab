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

