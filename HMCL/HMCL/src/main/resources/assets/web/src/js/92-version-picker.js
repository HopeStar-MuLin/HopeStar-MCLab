  // ---------------- 版本选择（大弹窗） ----------------
  //
  // 之前的做法是「服务端按实例版本 + 加载器筛，回来几条就列几条」，用户既看不到
  // 这个资源还支持哪些版本，也没法挑。现在只让服务端按加载器筛（那是硬兼容门槛），
  // 游戏版本不筛，全部拉回来在前端分类：
  //   · 和实例完全匹配的排最前，打「推荐」
  //   · 顶部给「游戏版本 / 加载器 / 只看正式版」三个筛选
  //   · 每行写清加载器、支持的游戏版本、版本类型、更新时间、文件名和大小
  // HMCL 也是这么做的（分出当前实例可用的那些，再让人挑）。

  /// 版本缓存只按加载器区分：游戏版本现在是前端筛的，换版本不该重新拉一遍。
  function addonVersionKey(slug) {
    return [adType, slug, adLoader()].join('|');
  }

  function openAddonVersions(item) {
    adTarget = item;
    adVersionItems = [];
    adVersionTotal = 0;

    // 默认只按加载器筛（那是硬兼容门槛，跨加载器的文件装了也跑不了）。
    // 游戏版本不筛：这里要承担「这个资源支持哪些版本」的展示职责，
    // 一上来就按实例版本收窄，用户看到的常常只有一条，甚至零条。
    // 和实例完全匹配的靠排序和「推荐」徽章顶到最前面。
    adVerGv = '';
    adVerLoader = (adLoader() || '').toLowerCase();
    adVerReleaseOnly = false;

    document.getElementById('adver-title').textContent = item.title || '选择版本';
    // 副标题里点一句当前实例是什么，用户才明白「推荐」是按什么算出来的
    var subParts = [];
    if (item.author) { subParts.push(tr('作者 ') + item.author); }
    var instInfo = adInstance();
    if (instInfo) {
      var tag = instInfo.gameVersion || '';
      if (instInfo.loader && instInfo.loader !== '原版') {
        tag += (tag ? ' · ' : '') + instInfo.loader;
      }
      if (tag) { subParts.push(tr('当前实例 ') + tag); }
    }
    document.getElementById('adver-sub').textContent = subParts.join('   ·   ');
    document.getElementById('adver-modal').classList.remove('hidden');
    renderAdverFilters();
    renderAdverList();

    var cached = cacheGet(adVersionCache, addonVersionKey(item.slug));
    if (cached) {
      setAdverVersions(cached, 0);
      return;
    }
    // 游戏版本传空：要在弹窗里按版本分类，就不能让服务端先筛掉
    call('addonVersions', adType, item.slug, '', adLoader());
  }

  function closeAddonVersions() {
    document.getElementById('adver-modal').classList.add('hidden');
    adTarget = null;
    adVersionItems = [];
  }

  /// 收到版本数据：先存起来，再重建筛选条和列表。
  function setAdverVersions(items, total) {
    adVersionItems = items || [];
    adVersionTotal = total || adVersionItems.length;

    // 筛选默认值可能不在数据里（实例的版本这个资源根本不支持），那就退回「全部」
    var gvs = adverGameVersions();
    if (adVerGv && gvs.indexOf(adVerGv) < 0) {
      adVerGv = '';
    }
    var loaders = adverLoaders();
    if (adVerLoader && loaders.indexOf(adVerLoader) < 0) {
      adVerLoader = '';
    }

    renderAdverFilters();
    renderAdverList();
  }

  /// 数据里出现过的游戏版本，新的在前。Modrinth 给的是字符串，
  /// 直接字典序会把 1.9 排到 1.10 后面，所以要按数值段比。
  function adverGameVersions() {
    var seen = {};
    var out = [];
    adVersionItems.forEach(function (v) {
      (v.gameVersions || []).forEach(function (g) {
        if (g && !seen[g]) { seen[g] = 1; out.push(g); }
      });
    });
    // 实例的版本即使没出现在列表里也放进去，用户才好切回「当前实例」
    var instGv = adGameVersion();
    if (instGv && !seen[instGv]) { out.unshift(instGv); seen[instGv] = 1; }
    out.sort(function (a, b) { return compareGameVersion(b, a); });
    return out;
  }

  function adverLoaders() {
    var seen = {};
    var out = [];
    adVersionItems.forEach(function (v) {
      (v.loaders || []).forEach(function (l) {
        if (l && !seen[l]) { seen[l] = 1; out.push(l); }
      });
    });
    out.sort();
    return out;
  }

  /// 1.21.10 > 1.21.4 > 1.9：按数值比，不是字符串比
  function compareGameVersion(a, b) {
    var pa = String(a || '').split(/[.\-+]/);
    var pb = String(b || '').split(/[.\-+]/);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = parseInt(pa[i], 10);
      var y = parseInt(pb[i], 10);
      if (isNaN(x) && isNaN(y)) { continue; }
      if (isNaN(x)) { return -1; }
      if (isNaN(y)) { return 1; }
      if (x !== y) { return x - y; }
    }
    return 0;
  }

  function renderAdverFilters() {
    var gvSel = document.getElementById('adver-gv');
    var ldSel = document.getElementById('adver-loader');
    if (!gvSel || !ldSel) { return; }

    var instGv = adGameVersion();
    gvSel.innerHTML = '';
    var allGv = el('option', null, '全部版本');
    allGv.value = '';
    gvSel.appendChild(allGv);
    adverGameVersions().forEach(function (g) {
      var o = el('option', null, g + (g === instGv ? '（当前实例）' : ''));
      o.value = g;
      gvSel.appendChild(o);
    });
    gvSel.value = adVerGv;

    ldSel.innerHTML = '';
    var allLd = el('option', null, '全部加载器');
    allLd.value = '';
    ldSel.appendChild(allLd);
    adverLoaders().forEach(function (l) {
      var o = el('option', null, loaderLabel(l));
      o.value = l;
      ldSel.appendChild(o);
    });
    ldSel.value = adVerLoader;

    document.getElementById('adver-release-only').checked = adVerReleaseOnly;

    var count = document.getElementById('adver-count');
    if (!adVersionItems.length) {
      count.textContent = '';
    } else {
      var shown = filterAdverVersions().length;
      count.textContent = shown === adVersionTotal
        ? (tr('共 ') + adVersionTotal + tr(' 个版本'))
        : (shown + ' / ' + adVersionTotal + tr(' 个版本'));
    }
  }

  /// 加载器 slug → 显示名。Modrinth 里全小写。
  function loaderLabel(slug) {
    var map = {
      fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt',
      liteloader: 'LiteLoader', 'legacy-fabric': 'Legacy Fabric',
      iris: 'Iris', optifine: 'OptiFine', datapack: '数据包', minecraft: '原版',
      canvas: 'Canvas', rift: 'Rift', modloader: 'ModLoader'
    };
    return map[slug] || slug;
  }

  var ADVER_TYPE_LABEL = { release: '正式版', beta: '测试版', alpha: '快照版' };

  /// 当前筛选 + 排序后的版本。
  ///
  /// 排序：「和实例匹配」优先，其次正式版，再按发布时间新→旧。
  /// 用户点进来第一条就是能直接用的那个，不用自己找。
  function filterAdverVersions() {
    var instGv = adGameVersion();
    var instLoader = (adLoader() || '').toLowerCase();

    var list = adVersionItems.filter(function (v) {
      if (adVerReleaseOnly && (v.type || 'release') !== 'release') { return false; }
      if (adVerLoader && (v.loaders || []).indexOf(adVerLoader) < 0) { return false; }
      if (adVerGv && (v.gameVersions || []).indexOf(adVerGv) < 0) { return false; }
      return true;
    });

    function score(v) {
      var s = 0;
      if (instGv && (v.gameVersions || []).indexOf(instGv) >= 0) { s += 4; }
      if (instLoader && (v.loaders || []).indexOf(instLoader) >= 0) { s += 2; }
      if ((v.type || 'release') === 'release') { s += 1; }
      return s;
    }

    list.sort(function (a, b) {
      var d = score(b) - score(a);
      if (d) { return d; }
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    return list;
  }

  /// 这个版本算不算「推荐」：同时命中实例的游戏版本和加载器
  function isRecommended(v) {
    var instGv = adGameVersion();
    var instLoader = (adLoader() || '').toLowerCase();
    if (!instGv && !instLoader) { return false; }
    var gvOk = !instGv || (v.gameVersions || []).indexOf(instGv) >= 0;
    var ldOk = !instLoader || (v.loaders || []).indexOf(instLoader) >= 0;
    return gvOk && ldOk;
  }

  function renderAdverList() {
    var list = document.getElementById('adver-list');
    if (!list) { return; }
    list.innerHTML = '';

    if (!adTarget) { return; }

    if (!adVersionItems.length) {
      list.appendChild(loadingRow('正在拉取版本…'));
      return;
    }

    var rows = filterAdverVersions();
    if (!rows.length) {
      list.appendChild(el('div', 'adver-empty',
        '当前筛选下没有版本。把上面的游戏版本或加载器改成「全部」再试试。'));
      return;
    }

    var shown = rows.slice(0, 200);
    shown.forEach(function (v) {
      list.appendChild(buildAdverRow(v));
    });
    if (rows.length > shown.length) {
      list.appendChild(el('div', 'adver-empty',
        tr('还有 ') + (rows.length - shown.length) + tr(' 个更早的版本，用上面的筛选缩小范围。')));
    }
  }

  function buildAdverRow(v) {
    var row = el('div', 'adver-row' + (isRecommended(v) ? ' recommended' : ''));

    var info = el('div', 'adver-info');

    var line1 = el('div', 'adver-line1');
    line1.appendChild(el('span', 'adver-name', v.name || v.version || v.versionId));
    if (v.version && v.name && v.version !== v.name) {
      line1.appendChild(el('span', 'adver-ver', v.version));
    }
    var type = v.type || 'release';
    line1.appendChild(el('span', 'adver-type ' + type, ADVER_TYPE_LABEL[type] || type));
    if (isRecommended(v)) { line1.appendChild(el('span', 'adver-rec', '推荐')); }
    info.appendChild(line1);

    // 加载器 + 支持的游戏版本。游戏版本多的时候只列前几个
    var line2 = el('div', 'adver-line2');
    (v.loaders || []).forEach(function (l) {
      line2.appendChild(el('span', 'tag loader', loaderLabel(l)));
    });
    var gvs = v.gameVersions || [];
    gvs.slice(0, 6).forEach(function (g) {
      line2.appendChild(el('span', 'tag', g));
    });
    if (gvs.length > 6) {
      line2.appendChild(el('span', 'tag more', '+' + (gvs.length - 6) + tr(' 个版本')));
    }
    if (line2.childNodes.length) { info.appendChild(line2); }

    var line3 = el('div', 'adver-line3');
    if (v.date) { line3.appendChild(el('span', null, tr('更新于 ') + String(v.date).slice(0, 10))); }
    if (v.size > 0) { line3.appendChild(el('span', null, fmtSize(v.size))); }
    if (v.filename) { line3.appendChild(el('span', null, v.filename)); }
    if (v.downloads > 0) { line3.appendChild(el('span', null, fmtCount(v.downloads) + tr(' 次下载'))); }
    info.appendChild(line3);

    row.appendChild(info);

    var act = el('div', 'adver-actions');
    var btn = el('button', 'btn primary small', '下载');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      openDownloadConfirm(adTarget, v);
    });
    act.appendChild(btn);
    row.appendChild(act);

    return row;
  }

