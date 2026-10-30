import io

p = 'E:/MCLab/HMCL/HMCL/src/main/resources/assets/web/app.js'
s = io.open(p, encoding='utf-8').read()

# ---------------------------------------------------------------- 1. 分类中文名 + 自绘下拉 + 缓存

anchor = """  var AD_INSTANCE_TYPES = { mod: 1, resourcepack: 1, shader: 1, world: 1 };"""

addition = anchor + """

  /// Modrinth 的分类 slug → 中文。抄的是 HMCL 的 I18N_zh_Hans.properties
  /// 里 `modrinth.category.*` 那批键，不自己翻——不然同一个 "decoration"
  /// 在启动器和网页上会显示成两个词。
  var MODRINTH_CATEGORY = {
    adventure: '冒险', atmosphere: '大气效果', audio: '音频', babric: 'Babric',
    blocks: '方块', bloom: '泛光', 'bta-babric': 'BTA (Babric)', bukkit: 'Bukkit',
    bungeecord: 'BungeeCord', canvas: 'Canvas', cartoon: '卡通', challenging: '挑战',
    'colored-lighting': '彩色光照', combat: '战斗', 'core-shaders': '核心着色器',
    cursed: '邪门', datapack: '数据包', decoration: '装饰', economy: '经济',
    entities: '实体', environment: '环境', equipment: '装备', fabric: 'Fabric',
    fantasy: '奇幻', folia: 'Folia', foliage: '植被', fonts: '字体', food: '食物',
    forge: 'Forge', 'game-mechanics': '机制', gui: 'GUI', high: '高', iris: 'Iris',
    items: '物品', 'java-agent': 'Java Agent', 'kitchen-sink': '水槽',
    'legacy-fabric': 'Legacy Fabric', library: '库', lightweight: '轻量',
    liteloader: 'LiteLoader', locale: '本地化', low: '低', magic: '魔法',
    management: '管理', medium: '中', minecraft: 'Minecraft', minigame: '小游戏',
    misc: '其他', mobs: '生物', modded: '模组适配', models: '模型',
    modloader: "Risugami's ModLoader", multiplayer: '多人', neoforge: 'NeoForge',
    nilloader: 'NilLoader', optifine: 'OptiFine', optimization: '优化',
    ornithe: 'Ornithe', paper: 'Paper', 'path-tracing': '路径追踪', pbr: 'PBR',
    potato: '土豆', purpur: 'Purpur', quests: '任务', quilt: 'Quilt',
    realistic: '写实风格', reflections: '反射', rift: 'Rift', screenshot: '仅供截图',
    'semi-realistic': '半写实风格', shadows: '阴影', simplistic: '极简风格',
    social: '社交', spigot: 'Spigot', sponge: 'Sponge', storage: '存储',
    technology: '科技', themed: '主题风格', transportation: '交通', tweaks: '优化',
    utility: '实用', vanilla: '原版着色器', 'vanilla-like': '原版风格',
    velocity: 'Velocity', waterfall: 'Waterfall', worldgen: '地形',
    '8x-': '8x 或更低', '32x': '32x', '48x': '48x', '64x': '64x'
  };

  function categoryLabel(slug) {
    if (!slug) { return ''; }
    return MODRINTH_CATEGORY[slug] || slug;
  }

  // ---------------- 自绘下拉 ----------------
  //
  // 原生 select 的弹层是系统画的（灰底方角），在玻璃面板里很突兀。
  // 这里把 select 留在 DOM 里负责数据和 change 事件，视觉换成自己画的。
  var csRegistry = {};

  var CARET_SVG = '<svg class="cs-caret" viewBox="0 0 12 12"><path d="M2.6 4.4L6 7.8l3.4-3.4z"/></svg>';

  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced) { return; }
    sel.dataset.enhanced = '1';

    var wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('cs-native');

    var btn = el('button', 'cs-btn');
    btn.type = 'button';
    var label = el('span', 'cs-label');
    btn.appendChild(label);
    btn.insertAdjacentHTML('beforeend', CARET_SVG);
    wrap.appendChild(btn);

    var menu = el('div', 'cs-menu hidden');
    wrap.appendChild(menu);

    function rebuild() {
      var opt = sel.options[sel.selectedIndex];
      label.textContent = opt ? opt.textContent : '';
      menu.innerHTML = '';
      Array.prototype.forEach.call(sel.options, function (o, i) {
        var item = el('div', 'cs-item' + (i === sel.selectedIndex ? ' on' : ''), o.textContent);
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          rebuild();
          menu.classList.add('hidden');
          btn.classList.remove('open');
        });
        menu.appendChild(item);
      });
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = menu.classList.contains('hidden');
      closeAllCustomSelects();
      if (willOpen) {
        menu.classList.remove('hidden');
        btn.classList.add('open');
      }
    });

    rebuild();
    if (sel.id) { csRegistry[sel.id] = { rebuild: rebuild }; }
  }

  function closeAllCustomSelects() {
    var menus = document.querySelectorAll('.cs-menu');
    for (var i = 0; i < menus.length; i++) { menus[i].classList.add('hidden'); }
    var btns = document.querySelectorAll('.cs-btn.open');
    for (var j = 0; j < btns.length; j++) { btns[j].classList.remove('open'); }
  }

  document.addEventListener('click', closeAllCustomSelects);

  // ---------------- 搜索缓存 ----------------
  //
  // Modrinth 一次搜索要几百毫秒到几秒。来回切标签、翻页又翻回来、
  // 改完搜索又清空，同一批参数没必要重打一次。
  var adSearchCache = {};
  var AD_CACHE_MAX = 40;

  function cacheGet(cache, key) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
  }

  function cachePut(cache, key, value) {
    var keys = Object.keys(cache);
    if (keys.length >= AD_CACHE_MAX) { delete cache[keys[0]]; }
    cache[key] = value;
  }"""

assert anchor in s
s = s.replace(anchor, addition, 1)

# ---------------------------------------------------------------- 2. 搜索走缓存

old_search = """  function requestAddonSearch() {
    var grid = document.getElementById('ad-grid');
    grid.innerHTML = '';
    grid.appendChild(el('div', 'empty', '正在搜索…'));
    document.getElementById('ad-pager').hidden = true;
    call('addonSearch', adType, adGameVersion(), adQuery, String(adPage), adSort, adLoader());
  }"""

new_search = """  function addonSearchKey() {
    return [adType, adGameVersion(), adQuery, adPage, adSort, adLoader()].join('|');
  }

  function requestAddonSearch() {
    var grid = document.getElementById('ad-grid');

    var cached = cacheGet(adSearchCache, addonSearchKey());
    if (cached) {
      applyAddonSearch(cached);
      return;
    }

    grid.innerHTML = '';
    grid.appendChild(el('div', 'empty', '正在搜索…'));
    document.getElementById('ad-pager').hidden = true;
    call('addonSearch', adType, adGameVersion(), adQuery, String(adPage), adSort, adLoader());
  }

  /// 把一次搜索结果落到界面上。缓存命中和网络返回走同一段。
  function applyAddonSearch(data) {
    var grid = document.getElementById('ad-grid');
    if (!data || data.type !== adType) { return; }

    adItems = data.items || [];
    adPage = data.page || 0;
    adTotalPages = data.totalPages || 0;

    if (data.error) {
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
  }"""

assert old_search in s
s = s.replace(old_search, new_search, 1)

# ---------------------------------------------------------------- 3. 卡片标签用中文分类

old_tags = """      if (it.categories && it.categories.length) {
        var tags = el('div', 'ad-tags');
        it.categories.forEach(function (c) { tags.appendChild(el('span', 'tag', c)); });
        body.appendChild(tags);
      }"""

new_tags = """      if (it.categories && it.categories.length) {
        var tags = el('div', 'ad-tags');
        // 分类里既有内容性质（库 / 优化 / 装饰）也有加载器（Fabric / Forge），
        // 跟 HMCL 的卡片一样全列出来，用户一眼能判断这个资源合不合用
        it.categories.forEach(function (c) {
          tags.appendChild(el('span', 'tag', categoryLabel(c)));
        });
        body.appendChild(tags);
      }"""

assert old_tags in s
s = s.replace(old_tags, new_tags, 1)

# ---------------------------------------------------------------- 4. 版本列表缓存

old_ver = """  function openAddonVersions(item) {
    adTarget = item;
    adVersionItems = [];
    var list = document.getElementById('adver-list');
    list.innerHTML = '';
    list.appendChild(el('div', 'lm-empty', '正在拉取版本…'));
    document.getElementById('adver-title').textContent = item.title || '选择版本';
    document.getElementById('adver-modal').classList.remove('hidden');
    call('addonVersions', adType, item.slug, adGameVersion(), adLoader());
  }"""

new_ver = """  function addonVersionKey(slug) {
    return [adType, slug, adGameVersion(), adLoader()].join('|');
  }

  function openAddonVersions(item) {
    adTarget = item;
    adVersionItems = [];
    var list = document.getElementById('adver-list');
    list.innerHTML = '';
    document.getElementById('adver-title').textContent = item.title || '选择版本';
    document.getElementById('adver-modal').classList.remove('hidden');

    var cached = cacheGet(adVersionCache, addonVersionKey(item.slug));
    if (cached) {
      adVersionItems = cached;
      renderAddonVersions();
      return;
    }

    list.appendChild(el('div', 'lm-empty', '正在拉取版本…'));
    call('addonVersions', adType, item.slug, adGameVersion(), adLoader());
  }"""

assert old_ver in s
s = s.replace(old_ver, new_ver, 1)

s = s.replace("  var adSearchCache = {};",
              "  var adSearchCache = {};\n  var adVersionCache = {};", 1)

# ---------------------------------------------------------------- 5. 下拉初始化 & 动态选项刷新

old_init = """    var adSearch = document.getElementById('ad-search');"""

new_init = """    enhanceSelect(document.getElementById('ad-sort'));
    enhanceSelect(document.getElementById('ad-instance'));

    var adSearch = document.getElementById('ad-search');"""

assert old_init in s
s = s.replace(old_init, new_init, 1)

# 实例下拉的 options 是动态重建的，重建后要让自绘层同步
old_toolbar = """        if (!adInstanceId) {
          var cur = currentInstance();
          if (cur) { adInstanceId = cur.id; inst.value = cur.id; }
        }
      }
    }"""

new_toolbar = """        if (!adInstanceId) {
          var cur = currentInstance();
          if (cur) { adInstanceId = cur.id; inst.value = cur.id; }
        }
        // 原生 select 换了 options，自绘那一层要跟着重建
        if (csRegistry['ad-instance']) { csRegistry['ad-instance'].rebuild(); }
      }
    }"""

assert old_toolbar in s
s = s.replace(old_toolbar, new_toolbar, 1)

# ---------------------------------------------------------------- 6. 搜索结果回调改走 applyAddonSearch

old_cb = """    onAddonSearch: function (json) {
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
    },"""

new_cb = """    onAddonSearch: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== adType) { return; }
      // 成功的结果才缓存，报错（网络/限流）下次还要重试
      if (!data.error) { cachePut(adSearchCache, addonSearchKey(), data); }
      applyAddonSearch(data);
    },"""

assert old_cb in s
s = s.replace(old_cb, new_cb, 1)

old_vercb = """      adVersionItems = data.items || [];
      renderAddonVersions();
    },"""

new_vercb = """      adVersionItems = data.items || [];
      if (adTarget) { cachePut(adVersionCache, addonVersionKey(adTarget.slug), adVersionItems); }
      renderAddonVersions();
    },"""

assert old_vercb in s
s = s.replace(old_vercb, new_vercb, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('js ok')
