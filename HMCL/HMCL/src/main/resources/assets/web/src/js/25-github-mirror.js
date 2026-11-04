  // ---------------- GitHub 镜像加速 ----------------
  //
  // 默认收起、默认不测速：镜像站都是公益服务，一口气测一百多个会占带宽，
  // 平时不下载 GitHub 文件的人完全用不上。展开后点「测速」才真正跑，
  // 测出来可用的节点才能选；没测过一律直连。

  var mirrorData = null;     // { mirrors, results, best, testedAt }
  var mirrorResults = {};    // id -> result，测速过程中逐条填充
  var mirrorTesting = false;
  var mirrorDone = 0;

  function mirrorTotal() {
    return (mirrorData && mirrorData.mirrors || []).length;
  }

  function mirrorLatClass(ms) {
    if (ms < 400) { return 'fast'; }
    if (ms < 900) { return 'mid'; }
    return 'slow';
  }

  function mirrorById(id) {
    var list = (mirrorData && mirrorData.mirrors) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  /// 造一个格子。`state` 决定它能不能点、显示什么。
  function mirrorCell(meta) {
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'mirror-cell';
    cell.setAttribute('data-id', meta.id);
    cell.appendChild(el('span', 'mc-name', meta.name));

    var r = mirrorResults[meta.id];
    if (r) {
      if (r.ok) {
        cell.classList.add('ready', mirrorLatClass(r.ttfb));
        cell.appendChild(el('span', 'mc-lat', Math.round(r.ttfb) + ' ms'));
      } else {
        cell.classList.add('bad');
        cell.appendChild(el('span', 'mc-lat', r.error || tr('不可用')));
      }
    } else {
      cell.appendChild(el('span', 'mc-lat', mirrorTesting ? '…' : tr('未测')));
    }

    if (mirrorData && mirrorData.best === meta.id) {
      cell.classList.add('on');
    }
    return cell;
  }

  /// 重建整个网格。只在「加载 / 测速结束」时调用；测速过程中走单格更新，
  /// 免得每回来一个结果就重排一次，列表一直在跳。
  function renderMirrorGrid() {
    var grid = document.getElementById('mirror-grid');
    if (!grid) { return; }
    var list = ((mirrorData && mirrorData.mirrors) || []).slice();

    // 有结果的按延迟升序排前面，不可用的沉底，没测的排中间
    list.sort(function (a, b) {
      var ra = mirrorResults[a.id];
      var rb = mirrorResults[b.id];
      var va = ra ? (ra.ok ? ra.ttfb : 1e9) : 5e8;
      var vb = rb ? (rb.ok ? rb.ttfb : 1e9) : 5e8;
      return va - vb;
    });

    grid.innerHTML = '';
    list.forEach(function (m) { grid.appendChild(mirrorCell(m)); });
  }

  /// 只更新一格：测速过程中每回来一个结果调一次。
  function updateMirrorCell(result) {
    var grid = document.getElementById('mirror-grid');
    if (!grid) { return; }
    var cell = grid.querySelector('[data-id="' + result.id + '"]');
    if (!cell) { return; }

    var meta = mirrorById(result.id);
    if (!meta) { return; }

    cell.className = 'mirror-cell';
    cell.innerHTML = '';
    cell.appendChild(el('span', 'mc-name', meta.name));
    if (result.ok) {
      cell.classList.add('ready', mirrorLatClass(result.ttfb));
      cell.appendChild(el('span', 'mc-lat', Math.round(result.ttfb) + ' ms'));
    } else {
      cell.classList.add('bad');
      cell.appendChild(el('span', 'mc-lat', result.error || tr('不可用')));
    }
    if (mirrorData && mirrorData.best === result.id) {
      cell.classList.add('on');
    }
  }

  function updateMirrorCount() {
    var node = document.getElementById('mirror-count');
    if (!node) { return; }
    var total = mirrorTotal();
    if (mirrorTesting) {
      node.textContent = tf('已测 {0} / {1}', mirrorDone, total);
    } else if ((mirrorData && mirrorData.results || []).length) {
      node.textContent = tf('{0} 个节点', total);
    } else {
      node.textContent = tf('{0} 个节点待测速', total);
    }
  }

  function updateFoldSub() {
    var sub = document.getElementById('mirror-fold-sub');
    if (!sub) { return; }
    if (mirrorTesting) {
      sub.textContent = tf('测速中 {0} / {1}', mirrorDone, mirrorTotal());
      return;
    }
    var best = mirrorData && mirrorData.best;
    var meta = best ? mirrorById(best) : null;
    var tested = ((mirrorData && mirrorData.results) || []).length > 0;
    // 测过速又主动选回直连，也要显示「当前镜像：直连 GitHub」，
    // 不能一句「未测速」把用户刚才的操作抹掉
    sub.textContent = (best && meta && (best !== 'direct' || tested))
      ? tf('当前镜像：{0}', meta.name)
      : tr('未测速，直连下载');
  }

  /// 下载地址下面的那行提示：告诉用户这个链接会走哪条路。
  function updateUrlHint() {
    var input = document.getElementById('tb-url');
    var hint = document.getElementById('tb-url-hint');
    if (!input || !hint) { return; }
    var url = input.value.trim();

    if (!url) {
      hint.textContent = '';
      hint.className = 'url-hint';
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      hint.textContent = tr('地址要以 http:// 或 https:// 开头');
      hint.className = 'url-hint';
      return;
    }
    if (!/github(usercontent)?\.com/i.test(url)) {
      hint.textContent = tr('普通链接 · 直连下载');
      hint.className = 'url-hint';
      return;
    }

    var best = mirrorData && mirrorData.best;
    var meta = (best && best !== 'direct') ? mirrorById(best) : null;
    if (meta) {
      hint.textContent = tf('GitHub 文件 · 经 {0} 加速', meta.name);
      hint.className = 'url-hint ok';
    } else {
      hint.textContent = tr('GitHub 文件 · 直连下载（展开下方可测速选镜像）');
      hint.className = 'url-hint';
    }
  }

  function toggleMirrorFold() {
    var fold = document.getElementById('mirror-fold');
    var body = document.getElementById('mirror-fold-body');
    if (!fold || !body) { return; }
    var open = body.hidden;
    body.hidden = !open;
    fold.classList.toggle('open', open);
    if (open) { updateMirrorCount(); }
  }

  function loadMirrorStatus() {
    if (mirrorTesting) { return; }
    apiCall('mirrorStatus', []).then(function (raw) {
      var d = asJson(raw);
      if (!d) { return; }
      mirrorData = d;
      mirrorResults = {};
      (d.results || []).forEach(function (r) { mirrorResults[r.id] = r; });
      renderMirrorGrid();
      updateMirrorCount();
      updateFoldSub();
      updateUrlHint();
    });
  }

  /// 选镜像。只有测出结果的可用节点能选，没测过的一律不让点。
  function pickMirror(id) {
    // 直连永远可选：镜像全挂的时候得让人切回来
    if (id !== 'direct') {
      var r = mirrorResults[id];
      if (!r || !r.ok) { return; }
    }
    if (mirrorData && mirrorData.best === id) { return; }
    apiCall('mirrorPick', [id]).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.ok) { return; }
      if (!mirrorData) { mirrorData = {}; }
      mirrorData.best = d.best;
      renderMirrorGrid();
      updateFoldSub();
      updateUrlHint();
      toast(tf('已切换到 {0}', d.name || d.best), 'ok');
    });
  }

  function startMirrorTest() {
    if (mirrorTesting) { return; }
    mirrorTesting = true;
    mirrorDone = 0;
    var state = document.getElementById('mirror-state');
    if (state) { state.textContent = tr('测速中，每个站最多等 6 秒…'); }
    renderMirrorGrid();
    updateMirrorCount();
    updateFoldSub();

    apiCall('mirrorTest', []).then(function (started) {
      if (started) { return; }
      mirrorTesting = false;
      if (state) { state.textContent = tr('测速请求没发出去'); }
      updateMirrorCount();
      updateFoldSub();
    });
  }

  function startDownload() {
    if (tbState.running) { return; }
    var url = document.getElementById('tb-url').value.trim();
    if (!url) { toast(tr('先填个下载地址')); return; }
    if (!/^https?:\/\//i.test(url)) { toast(tr('地址要以 http:// 或 https:// 开头')); return; }

    var dir = document.getElementById('tb-dir').value.trim();
    var name = document.getElementById('tb-name').value.trim();
    var threads = Number(document.getElementById('tb-threads').value) || 8;

    var isGithub = /github(usercontent)?\.com/i.test(url);
    var best = mirrorData && mirrorData.best;
    var useMirror = isGithub && best && best !== 'direct';

    tbState.running = true;
    renderToolboxProgress({ done: 0, total: 0 });
    if (useMirror) {
      call('toolboxDownloadMirrored', url, dir, name, threads, best);
    } else {
      call('toolboxDownload', url, dir, name, threads);
    }
  }

  function initMirrorPanel() {
    var toggle = document.getElementById('mirror-fold-toggle');
    if (toggle) { toggle.addEventListener('click', toggleMirrorFold); }

    var test = document.getElementById('mirror-test');
    if (test) { test.addEventListener('click', startMirrorTest); }

    var grid = document.getElementById('mirror-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var cell = e.target.closest('.mirror-cell');
        if (cell) { pickMirror(cell.getAttribute('data-id')); }
      });
    }

    var url = document.getElementById('tb-url');
    if (url) {
      url.addEventListener('input', updateUrlHint);
      // 粘贴要等浏览器把值填进去，下一帧再判断
      url.addEventListener('paste', function () { setTimeout(updateUrlHint, 0); });
    }

    loadMirrorStatus();
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

