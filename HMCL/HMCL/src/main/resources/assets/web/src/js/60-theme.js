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

  /// 毛玻璃强度：改的是 CSS 变量 --glass-blur，顶栏/侧栏/页头都吃它。
  /// 0 表示不模糊（只剩半透明底色），40 是上限 —— 再大就糊成一片色块了。
  function applyGlassBlur(px) {
    var v = Number(px);
    if (!Number.isFinite(v)) { v = 18; }
    v = Math.max(0, Math.min(40, Math.round(v)));

    document.documentElement.style.setProperty('--glass-blur', v + 'px');

    var range = document.getElementById('glass-blur-range');
    if (range && document.activeElement !== range) { range.value = String(v); }
    setText('glass-blur-text', v + 'px');
    APPEARANCE.glassBlur = v;
  }

  /// 应用背景。
  ///
  /// 判断依据是 `bgCurrentId` 而不是 dataUrl —— 「恢复默认背景」和「透出桌面」
  /// 两种情况下 dataUrl 都是空串，只看 URL 会把默认背景也当成透图，
  /// 结果默认图被关掉、页面直接透明。
  /// 是否允许实例用自己主题覆盖启动器外观。
  ///
  /// 这个开关是全局的：关掉之后任何实例的配色/背景都不再生效，
  /// 启动器统一用设置页里选的那套。存的是字符串 "true"/"false"。
  var allowInstanceTheme = true;

  function applyAllowInstanceTheme(raw, fromBackend) {
    allowInstanceTheme = raw !== 'false';
    var box = document.getElementById('allow-instance-theme');
    if (box && !fromBackend) {
      box.checked = allowInstanceTheme;
    } else if (box && fromBackend) {
      box.checked = allowInstanceTheme;
    }
    // 关掉时立刻把已经铺上去的实例配色撤掉，不然要等到下次切页才生效
    if (typeof refreshInstanceTheme === 'function') {
      refreshInstanceTheme();
    }
  }

  (function bindAllowInstanceTheme() {
    var box = document.getElementById('allow-instance-theme');
    if (!box) { return; }
    box.addEventListener('change', function () {
      var value = box.checked ? 'true' : 'false';
      call('setAppearancePref', 'allowInstanceTheme', value);
      applyAllowInstanceTheme(value, true);
      toast(box.checked ? tr('实例主题已启用') : tr('实例主题已关闭'));
    });
  })();

  function applyBackground(dataUrl) {
    var root = document.documentElement;
    if (bgCurrentId === DESKTOP_BG_ID) {
      root.style.removeProperty('--bg-image');
      // 窗口本身是透明的（壳里开了 transparent），这里只需标记桌面模式，
      // 让 CSS 把遮罩压淡 —— 还按 68% 压着的话，Wallpaper Engine 的
      // 动态效果会被糊成一片灰，透图就没意义了。
      document.body.setAttribute('data-bg', 'desktop');
      return;
    }

    document.body.removeAttribute('data-bg');
    if (dataUrl) {
      root.style.setProperty('--bg-image', 'url("' + dataUrl + '")');
    } else {
      // 恢复默认：清掉自定义图，交给 CSS 里的默认背景
      root.style.removeProperty('--bg-image');
    }
  }

  // ---------------- 背景图库 ----------------
  //
  // 背景图存在外观库里（和皮肤、披风同一套「导入 → 库存 → 切换」），
  // 导入的图会被复制到 <数据目录>/appearance/backgrounds/，原文件之后随便删。

  /// 库里有哪些图：`[{ id, name, thumb }]`，`thumb` 是后端缩好的 320×180。
  /// 「透出桌面」的保留 ID，与后端 ThemeApi.DESKTOP_BACKGROUND_ID 对齐。
  var DESKTOP_BG_ID = 'desktop';

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
    if (name) {
      // 「透出桌面」不来自图库，item 永远是 null —— 不单独判一下，
      // 它会被当成「默认背景」，用户切了透图却看到名字没变。
      if (bgCurrentId === DESKTOP_BG_ID) {
        name.textContent = tr('透出桌面');
      } else {
        name.textContent = item ? item.name : tr('默认背景');
      }
    }
  }

  /// 一页最多几张：3 列 × 2 行，和实例截图页的密度对齐。
  var BG_PAGE_SIZE = 6;
  var bgPage = 0;

  function bgPageCount() {
    return Math.max(1, Math.ceil(bgItems.length / BG_PAGE_SIZE));
  }

  /// 「默认背景」「透出桌面」这类不来自图库的预设项。
  ///
  /// 三者（预设、图片）在网格里必须长得一样：同样的 16:9 预览区 + 底部名字条。
  /// 之前透图那张用 flex 撑高，和图片卡片的 16:9 差一截，排在一起高度参差。
  function buildPresetCard(id, name, options) {
    var opts = options || {};
    var on = bgCurrentId === id;
    var card = el('button', 'bg-item' + (on ? ' on' : ''));
    card.type = 'button';
    card.title = opts.title || name;

    if (opts.image) {
      // 默认背景直接拿那张图当预览，和用户导入的图片卡片完全一致
      var img = document.createElement('img');
      img.src = opts.image;
      img.alt = name;
      card.appendChild(img);
    } else {
      var iconBox = el('div', 'bg-preset-icon');
      iconBox.textContent = opts.icon || '·';
      card.appendChild(iconBox);
    }

    var bar = el('div', 'bg-bar');
    bar.appendChild(el('span', 'bg-name', name));
    card.appendChild(bar);

    card.addEventListener('click', function () {
      if (on) { closeBgMenu(); return; }
      prefCall('setBackground', [id]).then(function (raw) {
        // 空 id 走的是「恢复默认」，后端回的是默认图，不再是空串
        var url = typeof raw === 'string' ? raw : '';
        bgCurrentId = id;
        applyBackground(url);
        renderBgCurrent();
        renderBgGrid();
        closeBgMenu();
      });
    });
    return card;
  }

  /// 默认背景的预览图。走和页面同一份资源，换主题时会跟着变。
  var DEFAULT_BG_PREVIEW = 'img/background.png';

  /// 图库网格：一页 6 张，超出翻页。  /// 图库网格：一页 6 张，超出翻页。选中态跟着 bgCurrentId 走。
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

    // 前两格是固定的预设项，不参与分页 —— 它们永远可用，
    // 不该因为图库翻页或者图库为空就找不到
    grid.appendChild(buildPresetCard('', '默认背景', {
      image: DEFAULT_BG_PREVIEW,
      title: '使用启动器自带的背景图'
    }));
    grid.appendChild(buildPresetCard(DESKTOP_BG_ID, '透出桌面', {
      icon: '🖥',
      title: '透出桌面（跟随系统壁纸）'
    }));

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
    applyAllowInstanceTheme(d && d.allowInstanceTheme ? String(d.allowInstanceTheme) : 'true', true);
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

    var blur = document.getElementById('glass-blur-range');
    if (blur) {
      blur.addEventListener('input', function () { applyGlassBlur(Number(this.value)); });
      blur.addEventListener('change', function (e) {
        if (!e.isTrusted) { return; }
        saveAppearance('glassBlur', APPEARANCE.glassBlur);
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
      var blurv = Number(d.glassBlur);
      applyGlassBlur(Number.isFinite(blurv) && blurv >= 0 ? blurv : 18);
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


