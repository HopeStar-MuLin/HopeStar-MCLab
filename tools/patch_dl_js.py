import io

p = 'E:/MCLab/HMCL/HMCL/src/main/resources/assets/web/app.js'
s = io.open(p, encoding='utf-8').read()

# ---------------------------------------------------------------- 1) 下载页逻辑

anchor = """    var hide = document.getElementById('dl-progress-hide');
    if (hide) {
      hide.addEventListener('click', function () { setDownloadProgress('', false); });
    }
  }"""

addition = anchor + """

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
  var adInstanceId = '';
  var adSearchTimer = null;

  var AD_INSTANCE_TYPES = { mod: 1, resourcepack: 1, shader: 1 };

  function currentInstance() {
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.selected) { return list[i]; }
    }
    return list[0] || null;
  }

  /// 模组必须跟实例的游戏版本对上，否则列出来的版本一个都装不了。
  /// 其余几类不强制，用户可能只是想先看看。
  function adGameVersion() {
    if (adType !== 'mod') { return ''; }
    var inst = currentInstance();
    return inst ? (inst.gameVersion || '') : '';
  }

  function adLoader() {
    if (adType !== 'mod') { return ''; }
    var inst = currentInstance();
    var loader = inst ? (inst.loader || '') : '';
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

    adType = tab;
    adPage = 0;
    adItems = [];
    adTotalPages = 0;
    updateAddonToolbar();
    requestAddonSearch();
  }

  function updateAddonToolbar() {
    var needsInstance = !!AD_INSTANCE_TYPES[adType];
    var inst = document.getElementById('ad-instance');
    inst.hidden = !needsInstance;
    if (needsInstance) {
      inst.innerHTML = '';
      var list = (state && state.instances) || [];
      if (!list.length) {
        inst.appendChild(el('option', null, '没有实例'));
      } else {
        list.forEach(function (it) {
          var o = el('option', null, it.name + (it.gameVersion ? '  ' + it.gameVersion : ''));
          o.value = it.id;
          if (adInstanceId && it.id === adInstanceId) { o.selected = true; }
          inst.appendChild(o);
        });
        if (!adInstanceId) {
          var cur = currentInstance();
          if (cur) { adInstanceId = cur.id; inst.value = cur.id; }
        }
      }
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

  function requestAddonSearch() {
    var grid = document.getElementById('ad-grid');
    grid.innerHTML = '';
    grid.appendChild(el('div', 'empty', '正在搜索…'));
    document.getElementById('ad-pager').hidden = true;
    call('addonSearch', adType, adGameVersion(), adQuery, String(adPage), adSort, adLoader());
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
        var img = document.createElement('img');
        img.className = 'ad-icon';
        img.src = it.iconUrl;
        img.loading = 'lazy';
        // 图标挂了就换成首字母占位，别留一个破图
        img.addEventListener('error', function () {
          img.replaceWith(adPlaceholderIcon(it.title));
        });
        card.appendChild(img);
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
        it.categories.forEach(function (c) { tags.appendChild(el('span', 'tag', c)); });
        body.appendChild(tags);
      }
      card.appendChild(body);

      card.addEventListener('click', function () { openAddonVersions(it); });
      grid.appendChild(card);
    });
  }

  function adPlaceholderIcon(title) {
    var d = el('div', 'ad-icon placeholder', (title || '?').trim().charAt(0).toUpperCase());
    return d;
  }

  function openAddonVersions(item) {
    adTarget = item;
    adVersionItems = [];
    var list = document.getElementById('adver-list');
    list.innerHTML = '';
    list.appendChild(el('div', 'lm-empty', '正在拉取版本…'));
    document.getElementById('adver-title').textContent = item.title || '选择版本';
    document.getElementById('adver-modal').classList.remove('hidden');
    call('addonVersions', adType, item.slug, adGameVersion(), adLoader());
  }

  function closeAddonVersions() {
    document.getElementById('adver-modal').classList.add('hidden');
    adTarget = null;
  }

  function renderAddonVersions() {
    var list = document.getElementById('adver-list');
    if (!list) { return; }
    list.innerHTML = '';

    if (!adVersionItems.length) {
      list.appendChild(el('div', 'lm-empty', '这个项目没有匹配的版本。试试换个游戏版本，或到网页上看看。'));
      return;
    }

    adVersionItems.slice(0, 80).forEach(function (v) {
      var row = el('div', 'lm-item');
      var left = el('div', 'ad-ver-left');
      left.appendChild(el('span', null, v.name || v.version || v.versionId));
      var sub = [];
      if (v.type && v.type !== 'release') { sub.push(v.type === 'beta' ? '测试版' : v.type); }
      if (v.loaders && v.loaders.length) { sub.push(v.loaders.join(' / ')); }
      if (v.date) { sub.push(String(v.date).slice(0, 10)); }
      if (sub.length) { left.appendChild(el('span', 'lm-sub', sub.join(' · '))); }
      row.appendChild(left);
      row.appendChild(el('span', 'lm-radio'));
      row.addEventListener('click', function () { pickAddonVersion(v); });
      list.appendChild(row);
    });

    if (adVersionItems.length > 80) {
      list.appendChild(el('div', 'lm-empty',
        '共 ' + adVersionItems.length + ' 个版本，只列出前 80 个。'));
    }
  }

  function pickAddonVersion(v) {
    var item = adTarget;
    if (!item) { return; }
    closeAddonVersions();

    if (adType === 'modpack') {
      call('installModpackRemote', item.slug, v.versionId, item.iconUrl || '', '');
      toast('开始下载整合包「' + item.title + '」');
      return;
    }

    var instId = AD_INSTANCE_TYPES[adType] ? adInstanceId : '';
    call('addonInstall', adType, item.slug, v.versionId, instId);
    toast('开始下载「' + item.title + ' ' + (v.version || v.versionId) + '」');
  }

  /// 本地导入：File 对象直接当 fetch 的 body 传上去，Java 侧流式落盘。
  /// 不走 base64 —— 几百 MB 的整合包转成字符串会把内存吃光。
  function importLocalAddon() {
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

    var url = 'http://127.0.0.1:' + port + '/api/upload/' + kind
      + '?token=' + encodeURIComponent(token)
      + '&name=' + encodeURIComponent(file.name)
      + '&instanceId=' + encodeURIComponent(adInstanceId || '');

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
  }"""

assert anchor in s
s = s.replace(anchor, addition, 1)

# ---------------------------------------------------------------- 2) 事件绑定

bind_anchor = """    var hide = document.getElementById('dl-progress-hide');
    if (hide) {
      hide.addEventListener('click', function () { setDownloadProgress('', false); });
    }
  }

  // ---------------- 下载页：内容分类 ----------------"""

bind_add = """    var hide = document.getElementById('dl-progress-hide');
    if (hide) {
      hide.addEventListener('click', function () { setDownloadProgress('', false); });
    }

    // ---- 内容分类的交互 ----
    var tabs = document.getElementById('dl-tabs');
    if (tabs) {
      tabs.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-dltab]');
        if (b) { switchDownloadTab(b.getAttribute('data-dltab')); }
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
        adInstanceId = this.value;
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

    var adverClose = document.getElementById('adver-close');
    if (adverClose) { adverClose.addEventListener('click', closeAddonVersions); }
    var adverCancel = document.getElementById('adver-cancel');
    if (adverCancel) { adverCancel.addEventListener('click', closeAddonVersions); }
  }

  // ---------------- 下载页：内容分类 ----------------"""

assert bind_anchor in s
s = s.replace(bind_anchor, bind_add, 1)

# ---------------------------------------------------------------- 3) 回调

cb_anchor = "    onAppearance: function (json) {"

cb_add = """    onAddonSearch: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== adType) { return; }

      adItems = data.items || [];
      adPage = data.page || 0;
      adTotalPages = data.totalPages || 0;

      if (data.error) {
        var grid = document.getElementById('ad-grid');
        grid.innerHTML = '';
        grid.appendChild(el('div', 'empty', data.error));
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
    },

    onAddonVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== adType) { return; }

      var list = document.getElementById('adver-list');
      if (data.error) {
        list.innerHTML = '';
        list.appendChild(el('div', 'lm-empty', data.error));
        return;
      }
      adVersionItems = data.items || [];
      renderAddonVersions();
    },

    onAppearance: function (json) {"""

assert cb_anchor in s
s = s.replace(cb_anchor, cb_add, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('js ok')
