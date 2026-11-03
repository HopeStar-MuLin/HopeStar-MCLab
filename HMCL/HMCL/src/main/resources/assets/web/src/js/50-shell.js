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
    // 滞后阈值：往窄收在 NARROW 就切，往宽回要多 40px 才切回去。
    // 没有这段的话，窗口宽度拖在阈值附近时 rail 收了又开、开了又收，
    // 每次切换都是一整页布局重排，肉眼可见地抽搐。
    var now = narrow ? window.innerWidth < NARROW + 40 : window.innerWidth < NARROW;
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

