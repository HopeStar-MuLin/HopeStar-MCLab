  // ---------------- 世界（存档） ----------------

  /// 快速游玩的存档下拉：值必须是 saves 下的**目录名**（传给游戏的是这个），
  /// 显示名用存档里的 LevelName，两者不一样时两个都写出来。
  ///
  /// 这个下拉每次实例设置重渲染都会被刷一遍（改设置 → 后端保存 → 回推状态 → 再渲染）。
  /// 原来是先 `innerHTML = ''` 再等接口填：中间有一帧是空的，看起来就是一直闪；
  /// 末尾还无条件 dispatch 一个 change，又触发一次写设置，自己喂自己。
  /// 现在先在内存里把选项算好，跟当前内容一致就一个节点都不碰；只有「选中的存档
  /// 已经不在了」才写回设置（否则日常渲染不产生任何写入）。
  var quickSavesCache = { inst: null, sig: '' };

  function loadQuickPlaySaves(current) {
    var sel = document.getElementById('inst-quick-sp');
    if (!sel || !instId) { return; }
    var want = instId;
    if (quickSavesCache.inst !== want) {
      // 换实例：先清掉上一个实例的存档，别张冠李戴
      sel.innerHTML = '';
      quickSavesCache.inst = want;
      quickSavesCache.sig = '';
    }

    apiCall('instanceWorlds', [want]).then(function (raw) {
      var s = document.getElementById('inst-quick-sp');
      if (!s || !instId || instId !== want) { return; }
      var data = asJson(raw);
      var worlds = (data && data.worlds) || [];
      var items = [];
      var missing = false;
      if (!worlds.length) {
        items.push({ v: '', t: (data && data.error) ? '读取失败' : '还没有存档', disabled: true, selected: true });
      } else {
        worlds.forEach(function (w) {
          items.push({
            v: w.file,
            t: (w.name && w.name !== w.file) ? (w.name + '  (' + w.file + ')') : w.file,
            selected: w.file === current
          });
        });
        // 存着的存档可能已经被删了：补一项，否则下拉会默默变成第一项
        if (current && !worlds.some(function (w) { return w.file === current; })) {
          items.push({ v: current, t: current + tr('  (已不存在)'), selected: true });
          missing = true;
        }
      }

      var sig = want + '|' + current + '|' + JSON.stringify(items);
      if (sig === quickSavesCache.sig) { return; }  // 内容没变：不重画，也就不会闪
      quickSavesCache.sig = sig;

      var frag = document.createDocumentFragment();
      items.forEach(function (it) {
        var opt = el('option', null, it.t);
        opt.value = it.v;
        if (it.disabled) { opt.disabled = true; }
        if (it.selected) { opt.selected = true; }
        frag.appendChild(opt);
      });
      s.innerHTML = '';
      s.appendChild(frag);

      // 只有回退到「已不存在」这一项时才需要写回：其余情况一次都不写
      if (missing) { s.dispatchEvent(new Event('change', { bubbles: true })); }
    });
  }

  function loadInstWorlds() {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    var key = instId + '|world';
    var memo = instContentCache[key];
    if (memo) {
      renderInstWorlds(memo);
    } else {
      // 清空但不插「正在读取存档…」：本地目录列举很快，
      // 那块提示只会让人看到「加载中 → 列表」两次重排
      box.innerHTML = '';
    }
    apiCall('instanceWorlds', [instId]).then(function (raw) {
      if (instTab !== 'world') { return; }
      var data = asJson(raw);
      if (data && !data.error) {
        instContentCache[key] = data;
        // 存档没变就别重排：重排会把滚动位置和存档图标全掀掉
        if (memo && JSON.stringify(memo) === JSON.stringify(data)) { return; }
      }
      renderInstWorlds(data);
    });
  }

  function renderInstWorlds(data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';
    if (!data || data.error) {
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    var worlds = data.worlds || [];
    if (!worlds.length) {
      box.appendChild(el('div', 'inst-empty',
        '还没有存档。去「下载 → 世界」下载，或者把已有的存档目录拷进 saves。'));
      return;
    }

    worlds.forEach(function (w) {
      var row = el('div', 'world-item');

      var icon = document.createElement('img');
      icon.className = 'world-icon';
      if (w.icon) { icon.src = w.icon; } else { icon.classList.add('none'); }
      row.appendChild(icon);

      var main = el('div', 'world-main');
      main.appendChild(el('div', 'world-title', w.name || w.file));
      var sub = [];
      if (w.version) { sub.push(w.version); }
      sub.push(w.lastPlayed ? (tr('最后游玩 ') + fmtTime(w.lastPlayed)) : '还没进过');
      if (w.backups) { sub.push(w.backups + tr(' 个备份')); }
      if (w.locked) { sub.push('运行中'); }
      main.appendChild(el('div', 'world-sub', sub.join(' · ')));
      row.appendChild(main);

      var acts = el('div', 'world-acts');
      function act(label, title, handler) {
        var button = el('button', 'btn ghost small', label);
        if (title) { button.title = title; }
        button.addEventListener('click', function (e) {
          e.stopPropagation();
          handler(button);
        });
        acts.appendChild(button);
      }

      act('打开目录', '在资源管理器里打开这个存档', function () {
        apiCall('worldAction', [instId, 'open', w.file, '']).then(function (raw) {
          var r = asJson(raw);
          if (r && r.error) { toast(r.error, 'error'); }
        });
      });
      act('备份', tr('打包到 backups/') + w.file + '/', function (button) {
        button.disabled = true;
        apiCall('worldAction', [instId, 'backup', w.file, '']).then(function (raw) {
          var r = asJson(raw);
          button.disabled = false;
          if (r && r.error) { toast(r.error, 'error'); }
          else { toast(tr('已备份：') + ((r && r.file) || ''), 'ok'); }
          loadInstWorlds();
        });
      });
      act('导出…', '打包成 zip 存到你自己选的位置，可以发给别人', function () {
        exportWorldZip(w);
      });
      act('重命名', '同时改目录名和存档内显示名', function () {
        askName('新的存档名', w.name || w.file).then(function (name) {
          if (!name) { return; }
          apiCall('worldAction', [instId, 'rename', w.file, name]).then(function (raw) {
            var r = asJson(raw);
            if (r && r.error) { toast(r.error, 'error'); } else { toast('已重命名', 'ok'); }
            loadInstWorlds();
          });
        });
      });
      act('删除', '移到系统回收站', function () {
        askConfirm(tf('把存档「{0}」移到回收站？', w.name || w.file)).then(function (yes) {
          if (!yes) { return; }
          apiCall('worldAction', [instId, 'delete', w.file, '']).then(function (raw) {
            var r = asJson(raw);
            if (r && r.error) { toast(r.error, 'error'); } else { toast('已移到回收站', 'ok'); }
            loadInstWorlds();
          });
        });
      });

      row.appendChild(acts);
      box.appendChild(row);
    });
  }

  // ---------------- 截图 ----------------

  function loadInstScreenshots() {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    var key = instId + '|screenshot';
    var memo = instContentCache[key];
    if (memo) {
      renderInstScreenshots(memo);
    } else {
      // 同上：截图是本地目录列举，不值得为它先画一遍加载块
      box.innerHTML = '';
    }
    apiCall('instanceScreenshots', [instId]).then(function (raw) {
      if (instTab !== 'screenshot') { return; }
      var data = asJson(raw);
      if (data && !data.error) {
        instContentCache[key] = data;
        // 截图没增没删就不重排，重排会让每张图重新解码一次
        if (memo && JSON.stringify(memo) === JSON.stringify(data)) { return; }
      }
      renderInstScreenshots(data);
    });
  }

  function screenshotAction(action, file, arg, done) {
    apiCall('screenshotAction', [instId, action, file, arg || '']).then(function (raw) {
      var r = asJson(raw);
      if (r && r.error) { toast(r.error, 'error'); }
      else if (done) { done(r); }
    });
  }

  function renderInstScreenshots(data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';
    if (!data || data.error) {
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    var items = data.items || [];
    if (!items.length) {
      box.appendChild(el('div', 'inst-empty', '还没有截图。游戏里按 F2 就会存到这里。'));
      return;
    }

    var grid = el('div', 'shot-grid');
    items.forEach(function (shot) {
      var card = el('div', 'shot-card');
      card.title = shot.file + tr('\n双击用系统默认程序打开，右键更多操作');

      var img = document.createElement('img');
      img.className = 'shot-thumb';
      img.loading = 'lazy';
      if (shot.thumb) { img.src = shot.thumb; } else { img.classList.add('none'); }
      card.appendChild(img);

      var bar = el('div', 'shot-bar');
      bar.appendChild(el('div', 'shot-name', shot.file));
      bar.appendChild(el('div', 'shot-meta', fmtSize(shot.size || 0) + ' · ' + fmtTime(shot.time)));
      card.appendChild(bar);

      card.addEventListener('dblclick', function () {
        screenshotAction('open', shot.file);
      });
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: '复制图片',
            action: function () {
              screenshotAction('copy', shot.file, '', function () { toast('已复制到剪贴板', 'ok'); });
            }
          },
          {
            label: '重命名',
            action: function () {
              askName('新的文件名', shot.file).then(function (name) {
                if (!name) { return; }
                screenshotAction('rename', shot.file, name, function () {
                  toast('已重命名', 'ok');
                  loadInstScreenshots();
                });
              });
            }
          },
          {
            label: '删除',
            danger: true,
            action: function () {
              askConfirm(tf('删除截图「{0}」？（移到回收站）', shot.file)).then(function (yes) {
                if (!yes) { return; }
                screenshotAction('delete', shot.file, '', function () {
                  toast('已移到回收站', 'ok');
                  loadInstScreenshots();
                });
              });
            }
          }
        ]);
      });

      grid.appendChild(card);
    });
    box.appendChild(grid);
  }

