  // ---------------- 实例体检：崩溃分析 / 依赖检查 ----------------

  var instCrashInfo = null;
  var instScanInfo = null;

  /// 实例 id → 整合包更新信息（后端算好的，十分钟缓存）。
  /// 卡片上的「可更新」角标和实例页顶部的更新条都读它。
  var modpackUpdates = {};
  /// 用户点了「这次先不看」的实例，本次运行不再提示。
  var modpackUpdateIgnored = {};

  /// 拉一遍所有实例的整合包更新状态。
  /// 后端按实例缓存十分钟，所以翻页、切标签重复调也不会一直打网络。
  function refreshModpackUpdates(force) {
    // 后端要打平台接口，只能是异步的：发出去就不管了，
    // 结果从 onModpackUpdates 回来（不然会把界面卡住几秒）
    call('modpackUpdateList', force ? 'true' : 'false');
  }

  /// 实例页顶部的更新条。只在这个实例确实有新版、且用户没点过「先不看」时出现。
  function renderInstUpdateBar() {
    var bar = document.getElementById('inst-update-bar');
    if (!bar) { return; }
    var u = instId ? modpackUpdates[instId] : null;
    if (!u || !u.ok || !u.hasUpdate || modpackUpdateIgnored[instId]) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var title = document.getElementById('inst-update-title');
    var subEl = document.getElementById('inst-update-sub');
    if (title) {
      title.textContent = tf('整合包有新版本 {0}', u.latestVersion || '');
    }
    if (subEl) {
      var parts = [];
      if (u.currentVersion) { parts.push(tf('当前 {0}', u.currentVersion)); }
      if (u.latestDate) { parts.push(fmtTime(u.latestDate)); }
      if (u.latestSize > 0) { parts.push(fmtSize(u.latestSize)); }
      subEl.textContent = parts.join('   ·   ');
    }
  }

  /// 进实例时查一次最近的崩溃报告。有就顶上挂一条，没有就不占地方。
  function checkInstanceCrash() {
    var bar = document.getElementById('inst-crash-bar');
    if (!bar || !instId) { return; }
    bar.hidden = true;
    instCrashInfo = null;
    var wanted = instId;
    apiCall('crashReportAnalysis', [wanted]).then(function (raw) {
      if (wanted !== instId) { return; }   // 期间切了实例，丢弃
      var d = asJson(raw);
      if (!d || !d.ok || !d.found) { return; }
      instCrashInfo = d;
      var title = document.getElementById('inst-crash-title');
      var sub = document.getElementById('inst-crash-sub');
      if (title) { title.textContent = d.title ? (tr('上次崩溃：') + d.title) : '上次启动崩溃了'; }
      var parts = [];
      if (d.time) { parts.push(fmtTime(d.time)); }
      if (d.description) { parts.push(d.description.replace(/\s+/g, ' ').slice(0, 70)); }
      if (sub) { sub.textContent = parts.join(' · '); }
      bar.classList.add('crash');
      bar.hidden = false;
    });
  }

  /// 扫 mods：缺前置 / 重复安装。只在「模组」标签页用。
  function scanInstanceMods() {
    var bar = document.getElementById('inst-scan-bar');
    if (!bar || !instId) { return; }
    bar.hidden = true;
    instScanInfo = null;
    var wanted = instId;
    apiCall('instanceModScan', [wanted]).then(function (raw) {
      if (wanted !== instId || instTab !== 'mod') { return; }
      var d = asJson(raw);
      if (!d || !d.ok) { return; }
      var missing = d.missing || [];
      var dup = d.duplicates || [];
      instScanInfo = d;
      if (!missing.length && !dup.length) { return; }

      var bits = [];
      if (missing.length) {
        var hard = missing.filter(function (m) { return !m.optional; }).length;
        var soft = missing.length - hard;
        bits.push(tr('缺 ') + hard + tr(' 个前置') + (soft ? tr('、') + soft + tr(' 个可选') : ''));
      }
      if (dup.length) { bits.push(dup.length + tr(' 个模组重复安装')); }
      document.getElementById('inst-scan-title').textContent = tr('依赖检查：') + bits.join(' · ');

      var names = missing.slice(0, 4).map(function (m) { return m.needs; });
      if (dup.length) { names = names.concat(dup.slice(0, 2).map(function (x) { return x.id + ' ×' + x.files.length; })); }
      document.getElementById('inst-scan-sub').textContent = names.join('、') + (names.length > 6 ? ' …' : '');
      bar.hidden = false;
    });
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.remove('hidden'); }
  }

  function closeModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.add('hidden'); }
  }

  /// 崩溃分析弹窗：结论 → 动作 → 建议 → 可疑模组 → 原文摘要。
  ///
  /// 这里的按钮只做三件事：禁用可疑、禁用全部、恢复上次禁用。
  /// 禁用永远是改文件名（`.jar` → `.jar.disabled`），不删任何东西。
  function showCrashModal() {
    var d = instCrashInfo;
    var box = document.getElementById('crash-content');
    if (!box) { return; }
    box.innerHTML = '';
    if (!d) { return; }
    var modalTitle = document.getElementById('crash-modal-title');
    if (modalTitle) { modalTitle.textContent = tr('崩溃分析'); }

    var head = el('div', 'crash-headline');
    head.appendChild(el('h4', null, d.title || '崩溃原因未归类'));
    head.appendChild(el('p', null, d.detail || ''));
    box.appendChild(head);

    var meta = [];
    if (d.source === 'log') { meta.push(tr('来自启动日志')); }
    if (d.file) { meta.push(d.file); }
    if (d.time) { meta.push(fmtTime(d.time)); }
    if (d.size) { meta.push(fmtSize(d.size)); }
    if (meta.length) {
      box.appendChild(el('div', 'ib-sub', meta.join(' · ')));
    }

    box.appendChild(buildCrashActions(d));

    if (d.hints && d.hints.length) {
      var sec = el('div', 'crash-sec');
      sec.appendChild(el('h5', null, '怎么办'));
      var ul = el('ul', 'crash-hints');
      d.hints.forEach(function (h) { ul.appendChild(el('li', null, h)); });
      sec.appendChild(ul);
      box.appendChild(sec);
    }

    var suspects = (d.suspects || []).filter(function (s) { return s && (s.file || s.id); });
    if (suspects.length) {
      box.appendChild(renderCrashSuspects(suspects,
        tf('可疑模组（{0}）', suspects.length), 'susp'));
    } else if ((d.recent || []).length) {
      // 一点线索都没有的时候，最近动过的模组就是最快的二分法起点
      var tip = el('div', 'crash-sec');
      tip.appendChild(el('h5', null, '最近变动过的模组'));
      tip.appendChild(el('div', 'ib-sub',
        '崩溃报告里没有点名任何模组。下面这些是崩溃前 24 小时内装进来或改过的，先从这里试。'));
      box.appendChild(tip);
      box.appendChild(renderCrashSuspects(d.recent, '', 'recent'));
    }

    if (d.excerpt) {
      var sec3 = el('div', 'crash-sec');
      sec3.appendChild(el('h5', null, d.source === 'log' ? '日志末尾' : '报告原文（前 80 行）'));
      var pre = el('pre', 'crash-raw');
      pre.textContent = d.excerpt;
      sec3.appendChild(pre);
      box.appendChild(sec3);
    }

    openModal('crash-modal');
  }

  /// 弹窗顶部那排按钮。全部禁用要连点两次，避免手一抖把几十个模组全关了。
  function buildCrashActions(d) {
    var active = (d.suspects || []).filter(function (s) {
      return s && s.file && !s.disabled;
    });
    var all = d.enabledFiles || [];
    var q = d.quarantine;

    var wrap = el('div', 'crash-actions');

    var one = el('button', 'btn primary small',
      active.length ? tf('一键禁用可疑模组（{0}）', active.length) : '没有可禁用的可疑模组');
    one.disabled = !active.length;
    one.addEventListener('click', function () {
      doCrashDisable(active.map(function (s) { return s.file; }), one);
    });
    wrap.appendChild(one);

    if (all.length) {
      var allBtn = el('button', 'btn ghost small crash-danger', tf('禁用全部模组（{0}）', all.length));
      var armed = false;
      var timer = null;
      allBtn.addEventListener('click', function () {
        if (!armed) {
          armed = true;
          allBtn.classList.add('armed');
          allBtn.textContent = tf('再点一次，禁用全部 {0} 个', all.length);
          timer = setTimeout(function () {
            armed = false;
            allBtn.classList.remove('armed');
            allBtn.textContent = tf('禁用全部模组（{0}）', all.length);
          }, 4000);
          return;
        }
        armed = false;
        if (timer) { clearTimeout(timer); }
        doCrashDisable('*', allBtn);
      });
      wrap.appendChild(allBtn);
    }

    if (q && q.count) {
      var back = el('button', 'btn ghost small', tf('恢复上次禁用（{0}）', q.count));
      back.addEventListener('click', function () {
        back.disabled = true;
        back.textContent = tr('正在恢复…');
        apiCall('crashRestoreMods', [instId]).then(function (raw) {
          var r = asJson(raw);
          if (!r || !r.ok) {
            toast((r && r.error) || tr('恢复失败'), 'err');
            back.disabled = false;
            back.textContent = tf('恢复上次禁用（{0}）', q.count);
            return;
          }
          toast(tf('已恢复 {0} 个模组', r.restored), 'ok');
          refreshAfterCrashAction();
        });
      });
      wrap.appendChild(back);
    }

    wrap.appendChild(el('div', 'crash-tip',
      '禁用只是把 jar 改名成 .disabled，文件不删；随时可以在模组页启用回来，或用「恢复上次禁用」一次性还原。'));

    return wrap;
  }

  /// 一批（或全部）模组改成禁用状态，成功后重新拉一遍分析结果并重绘。
  function doCrashDisable(files, btn) {
    if (!instId || !files || !files.length) { return; }
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = tr('正在禁用…');
    var payload = files === '*' ? '*' : JSON.stringify(files);
    apiCall('crashDisableMods', [instId, payload]).then(function (raw) {
      var r = asJson(raw);
      if (!r || !r.ok) {
        toast((r && r.error) || tr('禁用失败'), 'err');
        btn.disabled = false;
        btn.textContent = old;
        return;
      }
      toast(tf('已禁用 {0} 个模组，重启游戏生效', r.disabled), 'ok');
      refreshAfterCrashAction();
    });
  }

  /// 禁用/恢复之后：模组页要刷新，崩溃分析要重算（可疑列表的 disabled 状态变了）。
  function refreshAfterCrashAction() {
    if (instTab === 'mod' && typeof loadInstContent === 'function') {
      // 刚改了禁用状态，缓存里的 enabled 标记已经不对了
      loadInstContent('mod', true);
    }
    if (typeof scanInstanceMods === 'function') { scanInstanceMods(); }
    if (!instId) { return; }
    var wanted = instId;
    apiCall('crashReportAnalysis', [wanted]).then(function (raw) {
      if (wanted !== instId) { return; }
      var d = asJson(raw);
      if (d && d.ok) { instCrashInfo = d; }
      showCrashModal();
    });
  }

  /// 可疑模组卡片列表。
  function renderCrashSuspects(list, title, kind) {
    var sec = el('div', 'crash-sec');
    if (title) { sec.appendChild(el('h5', null, title)); }
    var wrap = el('div', 'crash-mods');

    list.forEach(function (s) {
      var card = el('div', 'cmc' + (s.disabled ? ' off' : '') + (kind === 'recent' ? ' recent' : ''));

      var top = el('div', 'cmc-top');
      top.appendChild(el('span', 'cmc-name', s.name || s.id || s.file));
      if (s.version) { top.appendChild(el('span', 'cmc-ver', s.version)); }
      if (kind !== 'recent') {
        var conf = s.confidence === 'high' ? '高置信'
          : s.confidence === 'medium' ? '较可能' : '待确认';
        top.appendChild(el('span', 'cmc-badge ' + (s.confidence || 'low'), conf));
      }
      if (s.loaderConflict) { top.appendChild(el('span', 'cmc-badge bad', '加载器不匹配')); }
      if (s.disabled) { top.appendChild(el('span', 'cmc-badge muted', '已禁用')); }
      card.appendChild(top);

      var fileLine = s.file || '';
      if (s.hits > 0) { fileLine += (fileLine ? '   ·   ' : '') + tf('堆栈命中 {0} 次', s.hits); }
      if (fileLine) { card.appendChild(el('div', 'cmc-file', fileLine)); }

      if (s.evidence && s.evidence.length) {
        var ul = el('ul', 'cmc-ev');
        s.evidence.forEach(function (x) { ul.appendChild(el('li', null, x)); });
        card.appendChild(ul);
      }
      if (s.advice) { card.appendChild(el('div', 'cmc-advice', s.advice)); }

      if (!s.disabled && s.file) {
        var acts = el('div', 'cmc-acts');
        var dis = el('button', 'btn ghost small', '禁用');
        dis.addEventListener('click', function () { doCrashDisable([s.file], dis); });
        acts.appendChild(dis);

        var find = el('button', 'btn ghost small', '查找兼容版本');
        find.addEventListener('click', function () { findCompatibleVersion(s); });
        acts.appendChild(find);
        card.appendChild(acts);
      }
      wrap.appendChild(card);
    });

    sec.appendChild(wrap);
    return sec;
  }

  /// 从崩溃弹窗跳到下载页：按模组名搜索，版本与加载器用当前实例筛。
  function findCompatibleVersion(s) {
    var q = (s.name && s.name !== s.file) ? s.name : (s.id || String(s.file || '').replace(/\.jar$/, ''));
    closeModal('crash-modal');
    go('download');
    switchDownloadTab('mod');
    adQuery = q;
    var box = document.getElementById('ad-search');
    if (box) { box.value = q; }
    if (instId) {
      adInstPicked['mod'] = instId;
      adInstanceTouched = true;
      var sel = document.getElementById('ad-instance');
      if (sel) { sel.value = instId; }
    }
    requestAddonSearch();
    toast(tf('按「{0}」搜索，已按当前实例的版本与加载器筛选', q), 'ok');
  }

  /// 依赖检查里点「安装」时的中转站：mod id -> Modrinth 项目 -> 版本弹窗。
  ///
  /// mod id 是 jar 里写的（`fabric.mod.json` 的 id），Modrinth 要的是 slug，
  /// 两者大多数时候一样、但不是同一个东西，所以得先问一次后端。
  var pendingDep = null;

  function currentInstance() {
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === instId) { return list[i]; }
    }
    return null;
  }

  function resolveDependency(modId, btn) {
    var inst = currentInstance();
    pendingDep = { modId: modId, btn: btn };
    if (btn) {
      btn.disabled = true;
      btn.textContent = tr('查找中…');
    }
    call('resolveAddonSlug', modId,
      (inst && inst.gameVersion) || '', (inst && inst.loader) || '');
  }

  /// 依赖检查详情：缺什么、谁需要、重复的是哪几个文件。
  function showScanModal() {
    var d = instScanInfo;
    var box = document.getElementById('crash-content');
    if (!box || !d) { return; }
    box.innerHTML = '';
    var modalTitle = document.getElementById('crash-modal-title');
    if (modalTitle) { modalTitle.textContent = tr('依赖检查'); }

    var head = el('div', 'crash-headline');
    head.appendChild(el('h4', null, '依赖检查'));
    var total = (d.mods || []).length;
    head.appendChild(el('p', null,
      tr('扫了 ') + total + tr(' 个模组：缺 ') + (d.missing || []).length + tr(' 个前置，')
      + (d.duplicates || []).length + tr(' 个模组重复安装。')));

    // 装完依赖回来点一下就能看到还缺什么 —— 依赖套依赖的那层就是这么发现的
    var tools = el('div', 'scan-tools');
    var again = el('button', 'btn ghost small', '重新检查');
    again.addEventListener('click', function () {
      closeModal('crash-modal');
      scanInstanceMods();
    });
    tools.appendChild(again);
    head.appendChild(tools);
    box.appendChild(head);

    if ((d.missing || []).length) {
      var sec = el('div', 'crash-sec');
      sec.appendChild(el('h5', null, '缺少的前置'));
      var list = el('div', 'scan-list');
      d.missing.forEach(function (m) {
        // 必选缺了起不来，标红；可选只是少个功能，标黄
        var row = el('div', 'scan-row' + (m.optional ? ' optional' : ''));
        row.appendChild(el('span', 'need', m.needs));
        if (m.optional) { row.appendChild(el('span', 'opt-tag', '可选')); }
        row.appendChild(el('span', null, tf('被「{0}」需要', m.mod) + (m.range ? ('（' + m.range + '）') : '')));
        // 缺哪个装哪个：按 mod id 找 Modrinth 项目，找到就开和模组页一样的版本弹窗
        var btn = el('button', 'btn ghost small', '安装');
        btn.addEventListener('click', function () { resolveDependency(m.needs, btn); });
        row.appendChild(btn);
        // 给个出口：有些「缺失」本来就补不上（作者写死了旧 id、整合包刻意裁掉的软依赖），
        // 没有忽略的话横幅会一直挂着，用户只能当没看见
        var skip = el('button', 'btn ghost small', '忽略');
        skip.title = '不再提示这个前置';
        skip.addEventListener('click', function () {
          skip.disabled = true;
          apiCall('ignoreModDependency', [instId, m.needs]).then(function () {
            if (instScanInfo && instScanInfo.missing) {
              var i = instScanInfo.missing.indexOf(m);
              if (i >= 0) { instScanInfo.missing.splice(i, 1); }
            }
            row.remove();
            scanInstanceMods();
            toast(tf('已忽略「{0}」', m.needs));
          });
        });
        row.appendChild(skip);
        list.appendChild(row);
      });
      sec.appendChild(list);
      box.appendChild(sec);
    }

    if ((d.duplicates || []).length) {
      var sec2 = el('div', 'crash-sec');
      sec2.appendChild(el('h5', null, '重复安装'));
      var list2 = el('div', 'scan-list');
      d.duplicates.forEach(function (x) {
        var row = el('div', 'scan-row');
        row.appendChild(el('span', 'need', x.id));
        row.appendChild(el('span', null, (x.files || []).join('  /  ')));
        list2.appendChild(row);
      });
      sec2.appendChild(list2);
      box.appendChild(sec2);
    }

    if ((d.unreadable || []).length) {
      var sec3 = el('div', 'crash-sec');
      sec3.appendChild(el('h5', null, '读不出元数据的 jar'));
      sec3.appendChild(el('div', 'ib-sub', d.unreadable.join('、')));
      box.appendChild(sec3);
    }

    openModal('crash-modal');
  }

  /// 内容列表的「变更签名」。只比文件名 + 大小 + 修改时间，
  /// 后台刷回来的数据没变就不重画 —— 重画会把滚动位置和图标都掀掉。
  function instContentSig(data) {
    var items = (data && data.items) || [];
    return items.map(function (it) {
      return (it.fileName || '') + ':' + (it.size || '') + ':' + (it.modified || '');
    }).join('|');
  }

  function loadInstContent(kind, force) {
    var box = document.getElementById('inst-content-list');
    if (!box || !instId) { return; }
    // 换了分类，之前勾的那批文件名就没意义了
    instSelected = {};

    var key = instId + '|' + kind;
    var memo = force ? null : instContentCache[key];

    if (memo) {
      // 缓存直接铺，不出现「正在读取…」
      renderInstContent(kind, memo);
    } else {
      // 没有缓存就清空，但不再插「正在读取…」：本地接口几十毫秒就回来，
      // 中间那一大块加载提示会让人看到「加载中 → 列表」两次重排。
      // 留空白比留上一页的列表安全，比加载块安静。
      box.innerHTML = '';
    }

    apiCall('instanceAddons', [instId, kind]).then(function (raw) {
      // 期间用户可能已经切了标签
      if (instTab !== kind) { return; }
      var data = asJson(raw);
      if (!data || data.error) {
        if (!memo) { renderInstContent(kind, data); }
        return;
      }
      var sig = instContentSig(data);
      var old = instContentCache[key];
      instContentCache[key] = data;
      // 数据和缓存一模一样就什么都不做，别白重排一次列表
      if (memo && old && instContentSig(old) === sig) { return; }
      renderInstContent(kind, data);
    });
  }

  /// 实例内容行左边那张图标。
  ///
  /// 图是从本地文件里现挖的（模组 jar 的 `icon.png`、资源包的 `pack.png`、
  /// 存档的 `icon.png`），走的还是下载页那套本地 HTTP 端点，只是换了个取图来源。
  /// 取不到就换首字母色块 —— 硬塞一个通用图标比没有更容易误导。
  function instItemIcon(item, kind) {
    var box = el('div', 'inst-item-icon');
    var url = apiEndpoint('/addonIcon', {
      instance: instId,
      kind: kind,
      file: item.fileName,
      // 版本号用修改时间：换了同名文件，浏览器缓存自然失效
      v: item.modified || ''
    });
    if (!url) {
      box.appendChild(instIconLetter(item.name));
      return box;
    }

    // 和后端图标一样必须走 fetch + blob：WebView2 对指向 127.0.0.1 的
    // <img> 会做 Private Network Access 检查，同一个地址 fetch 能拿到 200，
    // <img src> 会 0ms 直接 error（见 buildAddonIcon 的注释）。
    var key = 'addon:' + kind + ':' + item.fileName + ':' + (item.modified || '');
    var img = document.createElement('img');
    img.className = 'inst-icon-img loading' + (kind === 'screenshot' ? ' cover' : '');
    img.alt = '';

    var cached = iconBlobCache[key];
    if (cached) {
      img.src = cached;
      img.classList.remove('loading');
      box.appendChild(img);
      return box;
    }

    box.appendChild(img);
    fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.blob();
    }).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      rememberIconBlob(key, objectUrl);
      img.src = objectUrl;
      img.classList.remove('loading');
    }).catch(function () {
      // 取不到就换首字母，别留一块空白
      if (img.parentNode) { img.replaceWith(instIconLetter(item.name)); }
    });

    return box;
  }

  /// 没有图标时的首字母色块。色相由名字算，同一个模组每次都是同一个颜色。
  function instIconLetter(name) {
    var text = (name || '?').trim() || '?';
    var hue = 0;
    for (var i = 0; i < text.length; i++) {
      hue = (hue * 31 + text.charCodeAt(i)) % 360;
    }
    var box = el('span', 'inst-icon-letter', text.charAt(0).toUpperCase());
    box.style.background = 'hsl(' + hue + ', 62%, 93%)';
    box.style.color = 'hsl(' + hue + ', 48%, 40%)';
    return box;
  }

  /// 按搜索词过滤。显示名和文件名都参与匹配 ——
  /// 用户经常记得的是 jar 名（sodium-fabric-0.8.13.jar）而不是模组显示名。
  function filterInstItems(items) {
    var q = String(instQuery || '').trim().toLowerCase();
    if (!q) { return items; }
    return items.filter(function (it) {
      var name = String(it.name || '').toLowerCase();
      var file = String(it.fileName || '').toLowerCase();
      return name.indexOf(q) >= 0 || file.indexOf(q) >= 0;
    });
  }

  /// 排序。默认按名称，其余三种按「最可能有用的顺序」排：
  /// 大小和时间都是倒序（先看占地方的、先看新装的），状态是把启用的排前面。
  function sortInstItems(items) {
    var list = items.slice();
    if (instSort === 'size') {
      list.sort(function (a, b) { return (b.size || 0) - (a.size || 0); });
    } else if (instSort === 'time') {
      list.sort(function (a, b) { return (b.modified || 0) - (a.modified || 0); });
    } else if (instSort === 'state') {
      list.sort(function (a, b) {
        if (!!a.disabled !== !!b.disabled) { return a.disabled ? 1 : -1; }
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans');
      });
    } else {
      list.sort(function (a, b) {
        return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans');
      });
    }
    return list;
  }

  /// 工具条的显隐与计数。
  function syncInstTools(total) {
    var contentKind = instTab === 'mod' || instTab === 'resourcepack' || instTab === 'shader';
    var tools = document.getElementById('inst-content-tools');
    if (tools) { tools.hidden = !contentKind || total === 0; }
    var batchBar = document.getElementById('inst-batch-bar');
    if (batchBar) { batchBar.hidden = !contentKind || !instBatch; }
    updateInstCount();
  }

  function updateInstCount() {
    var count = document.getElementById('inst-content-count');
    if (count) {
      var total = instItemsCache.length;
      var shown = filterInstItems(instItemsCache).length;
      count.textContent = shown === total
        ? tf('共 {0} 项', total)
        : tf('筛出 {0} / {1}', shown, total);
    }
    var bcount = document.getElementById('inst-batch-count');
    if (bcount) {
      bcount.textContent = tf('已选 {0}', Object.keys(instSelected).length);
    }
  }

  /// 进出批量模式。勾选状态每次都清空 —— 换了一批操作对象还留着上一批的勾，
  /// 很容易误删。
  function setInstBatch(on) {
    instBatch = !!on;
    instSelected = {};
    var btn = document.getElementById('inst-content-batch');
    if (btn) {
      // 批量条里已经有「退出批量」，顶上这个按钮再挂一份就是两个一样的入口
      btn.hidden = instBatch;
      btn.textContent = tr('批量');
      btn.title = '批量启用 / 禁用 / 删除';
    }
    syncInstTools(instItemsCache.length);
    if (instItemsCache.length) {
      renderInstContent(instContentKind, { items: instItemsCache });
    }
  }

  /// 批量启用 / 禁用按钮。一次请求处理一批 —— 逐个调用会把
  /// HTTP 往返和列表重推放大几十倍。
  function bindBatchAction(id, enabled) {
    var btn = document.getElementById(id);
    if (!btn) { return; }
    btn.addEventListener('click', function () {
      var files = Object.keys(instSelected);
      if (!files.length) {
        toast('先在列表里勾几项', 'error');
        return;
      }
      apiCall('addonBatchEnabled', [instId, instContentKind, JSON.stringify(files), enabled])
        .then(function () {
          instSelected = {};
          refreshInstContent(instContentKind);
        });
    });
  }

  function renderInstContent(kind, data) {
    var box = document.getElementById('inst-content-list');
    if (!box) { return; }
    box.innerHTML = '';

    if (!data || data.error) {
      instItemsCache = [];
      syncInstTools(0);
      box.appendChild(el('div', 'inst-empty', (data && data.error) || '读取失败'));
      return;
    }
    // 目录不存在是常态（新实例没有 shaderpacks），当成空列表
    var items = data.items || [];
    instItemsCache = items;
    syncInstTools(items.length);
    if (!items.length) {
      box.appendChild(el('div', 'inst-empty', INST_EMPTY[kind] || '这里还没有内容'));
      return;
    }

    var shown = sortInstItems(filterInstItems(items));
    if (!shown.length) {
      box.appendChild(el('div', 'inst-empty', tf('没有匹配「{0}」的内容', instQuery)));
      return;
    }

    var isWorld = kind === 'world';
    // 只有「游戏会按扩展名决定加不加载」的三类才值得给开关。
    // 存档是目录，改名成 .disabled 没有意义；蓝图和截图根本不参与加载，加了也是误导。
    var canToggle = kind === 'mod' || kind === 'resourcepack' || kind === 'shader';
    shown.forEach(function (item) {
      // 加载器对不上的模组整行标红：装进去肯定跑不起来，
      // 不该让用户在一堆正常模组里靠猜
      var row = el('div', 'inst-item'
        + (item.disabled ? ' off' : '')
        + (item.conflict ? ' conflict' : ''));

      if (instBatch && canToggle) {
        // 批量模式下整行就是勾选框：点一下选中，再点取消。
        // 和平时「点一下禁用」是同一个手势，不需要再记一套操作。
        row.classList.add('selectable');
        if (instSelected[item.fileName]) { row.classList.add('selected'); }
        row.appendChild(el('span', 'inst-check', '✓'));
        row.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('button')) { return; }
          if (instSelected[item.fileName]) {
            delete instSelected[item.fileName];
          } else {
            instSelected[item.fileName] = true;
          }
          row.classList.toggle('selected');
          updateInstCount();
        });
      } else if (canToggle) {
        // 整行就是开关（PCL 那种）：点一下置灰、再点一下恢复。
        // 不再单独放勾选框 —— 一个 12px 的方块当开关，点击目标太小。
        row.classList.add('toggleable');
        row.title = item.disabled ? '点击启用' : '点击禁用';
        row.addEventListener('click', function (e) {
          // 行里还有删除按钮，别把它的点击也吃掉
          if (e.target && e.target.closest && e.target.closest('button')) { return; }
          apiCall('setAddonEnabled', [instId, kind, item.fileName, item.disabled])
            .then(function () { refreshInstContent(kind); });
        });
      }

      // 左边那张图标：模组是 jar 里的 icon.png，资源包是 pack.png，
      // 存档是游戏自己截的 icon.png。认不出就换成首字母色块
      row.appendChild(instItemIcon(item, kind));

      var main = el('div', 'inst-item-main');
      var line = el('div', 'inst-item-title', item.name);
      if (item.conflict) {
        line.appendChild(el('span', 'inst-tag bad', (item.loader || '').toUpperCase()));
      }
      main.appendChild(line);
      var sub = [];
      // 存档只能报 level.dat 的大小，加个单位说明，免得被当成整个存档的体积
      sub.push(isWorld ? (fmtSize(item.size || 0) + ' level.dat') : fmtSize(item.size || 0));
      // 冲突的模组要说清楚是跟谁对不上，光红一条用户不知道怎么办
      if (item.conflict) {
        sub.push(tf('这是 {0} 模组，和当前实例的加载器不匹配', (item.loader || '').toUpperCase()));
      }
      main.appendChild(el('div', 'inst-item-sub', sub.join(' · ')));
      row.appendChild(main);

      // 管理动作全进右键菜单。行里原来挂着一个 ✕，紧挨着可点击的整行，
      // 想点开关却点到删除的事故太多了。
      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        openAddonMenu(e.clientX, e.clientY, item, kind);
      });

      box.appendChild(row);
    });
  }

  /// 内容列表的右键菜单：模组多一项「查看详情」。
  ///
  /// 存档/截图也走这里 —— 它们同样需要「打开所在文件夹」和「删除」，
  /// 只是没有 jar 元数据可看。
  function openAddonMenu(x, y, item, kind) {
    var items = [];
    if (kind === 'mod') {
      items.push({ label: '查看模组详情', run: function () { showAddonDetails(item, kind); } });
    }
    items.push({ label: '打开所在文件夹', run: function () {
      call('showAddonInExplorer', instId, kind, item.fileName);
    } });
    items.push({ label: '删除', danger: true, run: function () {
      askConfirm(tf('删除「{0}」？', item.name)).then(function (yes) {
        if (!yes) { return; }
        apiCall('removeAddon', [instId, kind, item.fileName]).then(function () {
          refreshInstContent(kind);
        });
      });
    } });
    showCtx(x, y, items);
  }

  /// 模组详情。数据每次都从 jar 现读 —— 用户可能刚把文件换掉，
  /// 拿列表里那份缓存信息会对不上。
  function showAddonDetails(item, kind) {
    apiCall('addonDetails', [instId, kind, item.fileName]).then(function (raw) {
      var d = asJson(raw);
      var body = document.getElementById('crash-content');
      if (!body) { return; }
      body.innerHTML = '';
      var title = document.getElementById('crash-modal-title');
      if (title) { title.textContent = tr('模组详情'); }

      if (!d || d.error) {
        body.appendChild(el('div', 'empty', (d && d.error) || '读不出来'));
        openModal('crash-modal');
        return;
      }

      var meta = d.meta || {};
      // 不用 crash-headline：那个带粉底，是崩溃分析专用。模组详情要中性。
      var head = el('div', 'addon-head');
      // 图标和列表里同一张：点了哪个模组，弹窗里一眼能对上
      head.appendChild(instItemIcon({
        fileName: d.fileName,
        name: item.name,
        modified: d.modified || 0
      }, kind));
      head.appendChild(el('h4', null, meta.name || item.name));
      if (d.loader) {
        head.appendChild(el('span', 'inst-tag' + (d.conflict ? ' bad' : ''), d.loader.toUpperCase()));
      }
      body.appendChild(head);

      var kv = el('div', 'addon-kv');
      function row(k, v) {
        if (v == null || v === '') { return; }
        var line = el('div', 'addon-kv-row');
        line.appendChild(el('span', 'k', k));
        line.appendChild(el('span', 'v', String(v)));
        kv.appendChild(line);
      }
      row('模组 ID', meta.id);
      row('版本', meta.version);
      row('文件名', d.fileName);
      row('大小', fmtSize(d.size || 0));
      if (d.modified) { row('修改时间', fmtTime(d.modified)); }
      if (d.conflict) {
        row('加载器', d.loader.toUpperCase() + tr('（和当前实例不匹配）'));
      }
      row('路径', d.path);
      body.appendChild(kv);

      var deps = meta.depends || [];
      if (deps.length) {
        var sec = el('div', 'crash-sec');
        sec.appendChild(el('h5', null, tr('依赖')));
        var list = el('div', 'scan-list');
        deps.forEach(function (dep) {
          var line = el('div', 'scan-row');
          // 不用 .need：那是依赖检查里标「缺哪个」的红字，
          // 详情弹窗只是展示，标红会让人以为这个依赖没装
          line.appendChild(el('span', 'dep-id', dep.id));
          line.appendChild(el('span', 'dep-range', dep.range || '*'));
          list.appendChild(line);
        });
        sec.appendChild(list);
        body.appendChild(sec);
      }

      openModal('crash-modal');
    });
  }

  /// 删 / 禁用之后：重载当前列表，同时刷新标签上的计数
  function refreshInstContent(kind) {
    // 装完东西缓存一定过期，走 force 绕过
    if (instTab === kind) { loadInstContent(kind, true); }
    loadInstanceDetail();
  }


