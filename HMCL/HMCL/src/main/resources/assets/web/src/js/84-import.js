  // ---------------- 导入压缩包 ----------------
  //
  // 流程：选文件 → 后端预检（类型 / 目标 / 风险）→ 用户确认 → 后台导入 → 结果。
  // 预检的意义是「别让人点进一个必然失败的流程」：包里没有版本 json、
  // 是加密 zip、是改扩展名的 exe，都在这一步拦下并说清楚。

  var importPath = '';
  var importProbe = null;
  var importBusy = false;

  var IMPORT_KIND_NAMES = {
    instance: '实例', modpack: '整合包', world: '存档',
    resourcepack: '资源包', shader: '光影', datapack: '数据包', mod_bundle: '模组'
  };

  /// 这些类型必须有目标实例，否则不知道往哪儿放。
  function importNeedsInstance(kind) {
    return kind === 'resourcepack' || kind === 'shader'
      || kind === 'datapack' || kind === 'mod_bundle';
  }

  /// 一条带图标的提示块。kind: warn / error / ok。
  function importNote(kind, text) {
    var node = el('div', 'import-note ' + kind);
    var icons = {
      warn: '<path d="M12 9v4m0 4h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
      error: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3h.01"/>',
      ok: '<path d="m5 13 4 4L19 7"/>'
    };
    var ico = el('span');
    ico.innerHTML = '<svg viewBox="0 0 24 24">' + (icons[kind] || '') + '</svg>';
    node.appendChild(ico);
    node.appendChild(el('span', null, text));
    return node;
  }

  /// 多行文本节点，避免 innerHTML 拼用户数据（实例名里可能有尖括号）。
  function importLines(lines) {
    var node = el('div', 'import-target');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) { node.appendChild(document.createElement('br')); }
      node.appendChild(document.createTextNode(lines[i]));
    }
    return node;
  }

  function importSizeText(probe) {
    var parts = [];
    if (probe.bytes) { parts.push(fmtSize(probe.bytes)); }
    if (probe.entries) { parts.push(tf('{0} 个文件', probe.entries)); }
    if (probe.uncompressedBytes) { parts.push(tf('解压后约 {0}', fmtSize(probe.uncompressedBytes))); }
    return parts.join(' · ');
  }

  /// 目标文案：说清楚「装到哪」，而不是让用户猜。
  function importTargetLines(probe) {
    var kind = probe.kind || '';
    var inst = selectedInstance();
    var instName = inst ? (inst.name || inst.id) : '';
    if (kind === 'instance') {
      return [tf('将新建一个实例，名字是「{0}」', probe.name || '')];
    }
    if (kind === 'modpack') {
      return [tr('会按整合包安装，自动新建实例并下载所需内容')];
    }
    if (kind === 'world') {
      if (instName) {
        return [tf('将导入到「{0}」的存档列表', instName)];
      }
      return [tr('将导入到当前游戏目录的 saves')];
    }
    var sub = {
      resourcepack: 'resourcepacks', shader: 'shaderpacks',
      datapack: 'datapacks', mod_bundle: 'mods'
    }[kind];
    if (!sub) { return []; }
    if (!instName) {
      return [tf('需要先选一个实例，才能放进它的 {0}', sub)];
    }
    return [tf('将放入「{0}」的 {1}', instName, sub)];
  }

  function openImportDialog() {
    if (importBusy) { return; }
    apiCall('chooseImportArchive', []).then(function (path) {
      if (!path) { return; }
      importPath = String(path);
      importProbe = null;

      var box = document.getElementById('import-content');
      if (box) { box.innerHTML = ''; }
      var go = document.getElementById('import-go');
      if (go) {
        go.disabled = true;
        go.textContent = tr('导入');
        go.removeAttribute('data-done');
      }
      var hint = document.getElementById('import-hint');
      if (hint) { hint.textContent = tr('正在检查压缩包…'); }
      var cancel = document.getElementById('import-cancel');
      if (cancel) { cancel.style.display = ''; }
      openModal('import-modal');

      apiCall('inspectArchive', [importPath]).then(function (raw) {
        renderImportPreview(asJson(raw));
      });
    });
  }

  function renderImportPreview(probe) {
    importProbe = probe || null;
    var box = document.getElementById('import-content');
    var go = document.getElementById('import-go');
    var hint = document.getElementById('import-hint');
    if (!box) { return; }
    box.innerHTML = '';

    if (!probe) {
      box.appendChild(importNote('error', tr('识别失败：没有拿到结果，换个文件再试')));
      if (go) { go.disabled = true; }
      if (hint) { hint.textContent = ''; }
      return;
    }

    // 文件本身
    var fileRow = el('div', 'import-file');
    var ico = el('span', 'import-file-ico');
    ico.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>';
    fileRow.appendChild(ico);
    var main = el('div', 'import-file-main');
    main.appendChild(el('div', 'import-file-name', probe.file || importPath));
    main.appendChild(el('div', 'import-file-meta', importSizeText(probe)));
    fileRow.appendChild(main);
    box.appendChild(fileRow);

    // 类型
    var kind = probe.kind || 'unknown';
    var typeRow = el('div', 'import-type');
    typeRow.appendChild(el('span', 'import-badge', tr(IMPORT_KIND_NAMES[kind] || '未知')));
    if (probe.detail) { typeRow.appendChild(el('span', 'import-type-text', probe.detail)); }
    box.appendChild(typeRow);

    var lines = importTargetLines(probe);
    if (lines.length) { box.appendChild(importLines(lines)); }

    var errors = probe.errors || [];
    var warnings = probe.warnings || [];
    warnings.forEach(function (w) { box.appendChild(importNote('warn', w)); });
    errors.forEach(function (e) { box.appendChild(importNote('error', e)); });

    var missingInstance = importNeedsInstance(kind) && !selectedInstance();
    if (missingInstance) {
      box.appendChild(importNote('error', tr('先选一个实例，再导入这个文件')));
    }

    var blocked = errors.length > 0 || missingInstance || kind === 'unknown';
    if (go) {
      go.disabled = blocked;
      go.textContent = tr('导入');
      go.removeAttribute('data-done');
    }
    if (hint) {
      hint.textContent = blocked ? tr('这个文件现在导不进去') : tr('确认后开始解压，大包可能要一两分钟');
    }
  }

  function applyArchiveImport() {
    if (!importPath || importBusy) { return; }
    if (importProbe && (importProbe.errors || []).length) { return; }
    var inst = selectedInstance();
    importBusy = true;

    var go = document.getElementById('import-go');
    var hint = document.getElementById('import-hint');
    if (go) { go.disabled = true; go.textContent = tr('导入中…'); }
    if (hint) { hint.textContent = tr('正在解压，大包可能要一两分钟'); }

    apiCall('importArchive', [importPath, inst ? inst.id : '']).then(function (started) {
      // 后端返回 "started" 就等 onArchiveImported 回调；返回 null 说明请求没发出去
      if (!started) {
        importBusy = false;
        if (go) { go.disabled = false; go.textContent = tr('导入'); }
        if (hint) { hint.textContent = ''; }
        toast(tr('导入请求没有发出去，检查一下后端是否还在运行'));
      }
    });
  }

  function summarizeImport(d) {
    if (d.kind === 'instance') { return tf('实例「{0}」', d.name || ''); }
    if (d.kind === 'world') { return tf('{0} 个存档', (d.worlds || []).length); }
    if (d.kind === 'mod_bundle') { return tf('{0} 个模组', d.imported || 0); }
    return tf('{0} 个文件', d.imported || 0);
  }

  function renderImportResult(d) {
    var box = document.getElementById('import-content');
    var go = document.getElementById('import-go');
    var hint = document.getElementById('import-hint');
    if (!box) { return; }
    box.innerHTML = '';

    // 结果页也留一行文件名，回头截图反馈问题时能对上号
    if (d.file) {
      var head = el('div', 'import-file-meta', d.file);
      box.appendChild(head);
    }

    var errors = d.errors || [];
    var warnings = d.warnings || [];
    var items = d.items || [];

    if (d.ok) {
      box.appendChild(importNote('ok', tf('导入完成：{0}', summarizeImport(d))));
    } else {
      box.appendChild(importNote('error', errors[0] || tr('导入失败')));
      errors.slice(1).forEach(function (e) { box.appendChild(importNote('error', e)); });
    }
    warnings.forEach(function (w) { box.appendChild(importNote('warn', w)); });

    if (d.target) {
      box.appendChild(importLines([tf('位置：{0}', d.target)]));
    }

    if (items.length) {
      var list = el('div', 'import-list');
      items.slice(0, 40).forEach(function (it) {
        var row = el('div', 'import-list-item' + (it.ok ? '' : ' bad'));
        row.appendChild(el('span', 'nm', it.file || ''));
        row.appendChild(el('span', 'rs', it.reason || (it.ok ? tr('已导入') : tr('跳过'))));
        list.appendChild(row);
      });
      if (items.length > 40) {
        list.appendChild(el('div', 'muted small', tf('还有 {0} 条没列出来', items.length - 40)));
      }
      box.appendChild(list);
    }

    importBusy = false;
    importProbe = null;
    if (go) {
      go.disabled = false;
      go.textContent = tr('关闭');
      go.setAttribute('data-done', '1');
    }
    // 结果已经出来了，「取消」没有意义，留着反而让人以为还能撤销
    var cancel = document.getElementById('import-cancel');
    if (cancel) { cancel.style.display = 'none'; }
    if (hint) { hint.textContent = ''; }
  }

  function initImportDialog() {
    var btn = document.getElementById('btn-import-zip');
    if (btn) { btn.addEventListener('click', openImportDialog); }

    var close = document.getElementById('import-close');
    if (close) { close.addEventListener('click', function () { closeModal('import-modal'); }); }

    var cancel = document.getElementById('import-cancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        // 导入进行中不允许取消：解压到一半停掉会留下半成品
        if (importBusy) { return; }
        closeModal('import-modal');
      });
    }

    var go = document.getElementById('import-go');
    if (go) {
      go.addEventListener('click', function () {
        if (go.getAttribute('data-done') === '1') {
          go.removeAttribute('data-done');
          closeModal('import-modal');
          return;
        }
        applyArchiveImport();
      });
    }

    var modal = document.getElementById('import-modal');
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal && !importBusy) { closeModal('import-modal'); }
      });
    }
  }

  // ---------------- 拖拽导入 ----------------
  //
  // 路径来自壳侧的原生拖放事件（WebView2 拿不到 File 的绝对路径）。
  // 分类和分发都在后端做，这里只管遮罩和结果提示。

  /// 拖到窗口上时显示遮罩：写清楚「把什么装到哪」。
  ///
  /// @param paths 壳侧给的文件绝对路径；只取文件名，路径太长会把框撑开
  function showDropOverlay(paths) {
    var node = document.getElementById('drop-overlay');
    if (!node) { return; }
    var inst = selectedInstance();
    var title = document.getElementById('drop-overlay-title');
    var tip = document.getElementById('drop-overlay-tip');

    if (!inst) {
      if (title) { title.textContent = '还没有实例'; }
      if (tip) { tip.textContent = '先去「实例」里创建一个，再拖进来'; }
      node.classList.add('blocked');
      node.classList.add('on');
      return;
    }

    var names = (paths || []).map(function (p) {
      var s = String(p);
      var cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
      return cut >= 0 ? s.slice(cut + 1) : s;
    }).filter(function (x) { return !!x; });

    var what;
    if (names.length === 1) {
      what = names[0];
    } else if (names.length > 1) {
      what = tf('{0} 个文件', names.length);
    } else {
      what = tr('这些文件');
    }

    if (title) { title.textContent = tf('将 {0} 安装至 {1}', what, inst.name || inst.id); }
    if (tip) {
      // 标题里已经有实例名了，这行不再重复；多文件时列出前几个
      tip.textContent = names.length <= 1
        ? tr('松开鼠标开始安装')
        : names.slice(0, 3).join('、') + (names.length > 3 ? '…' : '');
    }
    node.classList.remove('blocked');
    node.classList.add('on');
  }

  function hideDropOverlay() {
    var node = document.getElementById('drop-overlay');
    if (node) { node.classList.remove('on'); }
  }

  function handleDropPaths(paths) {
    hideDropOverlay();
    if (!paths || !paths.length) { return; }
    var inst = selectedInstance();
    if (!inst) {
      toast(tr('还没有实例，先在「实例」里创建一个'));
      return;
    }
    // 分类在后端做（要读 zip 元数据），先给一句反馈别让人干等
    toast(tf('正在识别 {0} 个文件…', paths.length));
    call('dropImport', JSON.stringify(paths), inst.id);
  }

  var DROP_KIND_NAMES = {
    mod: '模组', resourcepack: '资源包', shader: '光影',
    world: '存档', modpack: '整合包', instance: '实例',
    datapack: '数据包', mod_bundle: '模组'
  };

  function handleDropResult(json) {
    var d = null;
    try { d = JSON.parse(json); } catch (e) { return; }
    if (!d) { return; }
    if (!d.ok) {
      toast(d.error || tr('导入失败'));
      return;
    }
    var parts = [];
    var imported = d.imported || {};
    Object.keys(imported).forEach(function (k) {
      parts.push((tr(DROP_KIND_NAMES[k] || k)) + ' ' + imported[k]);
    });
    if (parts.length) {
      toast(tf('已加入：{0}', parts.join('、')), 'ok');
    }
    var skipped = d.skipped || [];
    if (skipped.length) {
      var first = skipped[0];
      var more = skipped.length > 1 ? tf(' 等 {0} 个', skipped.length) : '';
      toast(tf('{0} 没认出来（{1}）{2}', first.file || '', first.reason || '', more));
    }
    if (!parts.length && !skipped.length) {
      toast(tr('没有可导入的文件'));
    }
    // 后端发现「原版实例 + 模组」组合时会给一句
    if (d.warning) { toast(tr(d.warning)); }
    // 内容列表可能变了，停在模组/资源包/光影页时刷一下（force：刚导入了东西，缓存必过期）
    if (INST_KIND_NAMES[instTab]) { loadInstContent(instTab, true); }
  }

