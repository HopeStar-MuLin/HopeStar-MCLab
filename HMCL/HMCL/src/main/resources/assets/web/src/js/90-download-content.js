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
  var adVersionTotal = 0;
  // 版本弹窗里的筛选状态
  var adVerGv = '';
  var adVerLoader = '';
  var adVerReleaseOnly = false;
  /// 每个资源类型各自选中的实例。
  /// 共用一个变量会串台：模组页自动挑上当前实例后，切到光影页也会按那个
  /// 实例的版本和加载器去筛，「进过模组页」前后同一个页面条数就不一样。
  var adInstPicked = {};
  /// 当前类型选中的实例 id，没选就是空串（表示不筛）。
  function adInstId() { return adInstPicked[adType] || ''; }
  /// 用户手动改过「实例」下拉没有。手动改过就不再自动跟当前实例，
  /// 否则选「暂未选择实例」会在下一次状态推送时被撤销。
  var adInstanceTouched = false;
  /// 用户手动切过内容平台没有。设置里那个「默认内容源」只在用户没手动切过时套用，
  /// 否则每次状态推送都会把他刚选的平台顶回去。
  var adSourceTouched = false;
  /// CurseForge 能不能用（构建期有没有 API Key）。null = 还没问出来。
  /// 设置里的默认内容源要套到下载页时，得先过这一关：
  /// 默认设成 CF、但这版根本没 key，切过去就是一片空白。
  var cfReady = null;
  var adSearchTimer = null;
  // 搜索请求序号。连点类别芯片会同时发出多个请求，回来的顺序不保证；
  // 只有 seq 等于当前值的响应才算数，其余直接丢。
  var adReqSeq = 0;

  // 类别。两家平台各一套表，所以缓存键是 `类型|平台`：
  // Modrinth 给的是 `adventure` 这种 slug，CurseForge 给的是 434 这种数字 id，
  // 混用的话点哪个类别都搜不出东西。
  var adCatGroups = [];   // 当前类型 + 平台的 [{key, items:[{slug, name}]}]
  var adCatCache = {};    // "type|source" -> groups，切走再切回来不重新拉
  var adCat = '';         // 当前选中的 slug（单选），空串 = 全部类别

  /// 接口的 header → 中文组名。认不出来的直接用原 key。
  var AD_CAT_GROUP = {
    categories: '类别', features: '特性', resolutions: '分辨率',
    'performance impact': '性能影响'
  };

  // 世界也要选目标实例：存档得知道放进哪个实例的 saves 里
  var AD_INSTANCE_TYPES = { mod: 1, resourcepack: 1, shader: 1, world: 1 };

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

  /// CurseForge 的分类名 → 中文。按英文原名做键，因为接口给的 id 会随
  /// 分类重建而变，名字反而是稳定的。命中不了就原样显示英文——
  /// 显示 `Blood Magic` 比显示一个猜的中文名好。
  var CF_CATEGORY = {
    // 模组
    'Armor, Tools, and Weapons': '装备与武器', 'Server Utility': '服务端工具',
    'Map and Information': '地图与信息', 'Addons': '附属', 'Bug Fixes': '修复',
    'API and Library': 'API 与前置', 'Food': '食物', 'Education': '教育',
    'Technology': '科技', 'Storage': '存储', 'Utility & QoL': '实用与体验',
    'Redstone': '红石', 'Miscellaneous': '杂项', 'World Gen': '世界生成',
    'Performance': '优化', 'Cosmetic': '装饰', 'Twitch Integration': 'Twitch 集成',
    'Adventure and RPG': '冒险与 RPG', 'Magic': '魔法', 'Horror': '恐怖',
    'CreativeMode': '创造模式',
    // 整合包
    'Extra Large': '超大', 'Small / Light': '轻量', 'Combat / PvP': '战斗 / PvP',
    'Sci-Fi': '科幻', 'FTB Official Pack': 'FTB 官方包', 'Quests': '任务',
    'Tech': '科技', 'Skyblock': '空岛', 'Map Based': '地图包',
    'Multiplayer': '多人', 'Mini Game': '小游戏',
    // 资源包 / 光影
    'Photo Realistic': '写实', 'Traditional': '传统', 'Font Packs': '字体',
    'Mod Support': '支持模组', 'Medieval': '中世纪', 'Data Packs': '数据包',
    'Animated': '动态', 'Realistic': '写实', 'Fantasy': '奇幻', 'Vanilla': '原版',
    // 世界
    'Puzzle': '解谜', 'Survival': '生存', 'Creation': '创造',
    'Modded World': '模组世界', 'Adventure': '冒险', 'Game Map': '游戏地图',
    'Parkour': '跑酷'
  };

  /// 类别芯片上的文字。没翻译过的 slug 折成「Kitchen Sink」这种标题式，
  /// 比原样打印 `kitchen-sink` 好看，也不用为了一个新类别去改代码。
  function adCatLabel(slug, name) {
    // CurseForge 直接给英文名（`Armor, Tools, and Weapons`），先过一遍中文表；
    // Modrinth 只给 slug，走自己的词表。
    if (name) { return CF_CATEGORY[name] || name; }
    if (!slug) { return ''; }
    if (MODRINTH_CATEGORY[slug]) { return MODRINTH_CATEGORY[slug]; }
    return slug.replace(/-+$/, '').replace(/[-_]/g, ' ').replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
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
        // 菜单现在会限高滚动（类别能有三十项）。上次滚到一半关掉，
        // 再打开还停在半截，看着像丢了几项。选中项在视野外就滚回去。
        var on = menu.querySelector('.cs-item.on');
        if (on) {
          var top = on.offsetTop;
          if (top < menu.scrollTop || top + on.offsetHeight > menu.scrollTop + menu.clientHeight) {
            menu.scrollTop = Math.max(0, top - menu.clientHeight / 2);
          }
        } else {
          menu.scrollTop = 0;
        }
        btn.classList.add('open');
      }
    });

    rebuild();
    if (sel.id) { csRegistry[sel.id] = { rebuild: rebuild }; }

    // 选项是动态填的（语言列表、实例列表、存档列表…），变了就重建按钮文案与菜单，
    // 否则自绘按钮上会一直显示第一项
    try {
      new MutationObserver(function () { rebuild(); })
        .observe(sel, { childList: true, subtree: true });
    } catch (e) { /* WebView 太老没有 MutationObserver 就退化：靠调用方手动 rebuild */ }

    // 脚本直接改 sel.value 时（比如恢复上次选的盔甲），按钮上的文字不会跟着变，
    // 因为 rebuild 只在点选项 / 改 options 时跑。把入口挂出去，调用方自己喊一声。
    sel.__csRebuild = rebuild;
  }

  /// 把某个子树里所有还没换过的 select 都换成自绘下拉。
  function enhanceAllSelects(root) {
    var list = (root || document).querySelectorAll('select:not([data-enhanced])');
    for (var i = 0; i < list.length; i++) {
      enhanceSelect(list[i]);
    }
  }

  /// 页面是动态渲染的（切页、开弹窗都会新建 DOM），新出现的 select 也要接上，
  /// 不然「第一次进实例设置是原生、刷新一下变自绘」这种不一致会一直存在
  function observeNewSelects() {
    if (!window.MutationObserver) { return; }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) { continue; }
          if (node.tagName === 'SELECT' && !node.dataset.enhanced) {
            enhanceSelect(node);
          } else if (node.querySelector && node.querySelector('select:not([data-enhanced])')) {
            enhanceAllSelects(node);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function closeAllCustomSelects() {
    var menus = document.querySelectorAll('.cs-menu');
    for (var i = 0; i < menus.length; i++) { menus[i].classList.add('hidden'); }
    var btns = document.querySelectorAll('.cs-btn.open');
    for (var j = 0; j < btns.length; j++) { btns[j].classList.remove('open'); }
  }

  document.addEventListener('click', closeAllCustomSelects);

  // 关于页的致谢链接：壳把外部导航全拦了，所以链接只带 data-url，
  // 点击时交给 Java 侧用系统默认浏览器打开
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-url]') : null;
    if (!a) { return; }
    e.preventDefault();
    call('openUrl', a.getAttribute('data-url'));
  });

  // ---------------- 搜索缓存 ----------------
  //
  // Modrinth 一次搜索要几百毫秒到几秒。来回切标签、翻页又翻回来、
  // 改完搜索又清空，同一批参数没必要重打一次。
  var adSearchCache = {};
  var adVersionCache = {};
  var AD_CACHE_MAX = 40;

  function cacheGet(cache, key) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null;
  }

  function cachePut(cache, key, value) {
    var keys = Object.keys(cache);
    if (keys.length >= AD_CACHE_MAX) { delete cache[keys[0]]; }
    cache[key] = value;
  }

  function currentInstance() {
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === state.selected) { return list[i]; }
    }
    return list[0] || null;
  }

  /// 当前在下载页选中的实例（不是启动器里选中的那个）。
  ///
  /// 两者的区别很关键：下拉第一项是「暂未选择实例」，用户可能故意不选，
  /// 这时候要展示全量、不按加载器和版本筛。所以这里不能用 currentInstance() 兜底。
  function adInstance() {
    var id = adInstId();
    if (!id) { return null; }
    var list = (state && state.instances) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  /// 筛选用的游戏版本。模组 / 资源包 / 光影都吃实例的版本；
  /// 没选实例就返回空，表示不筛。
  function adGameVersion() {
    var inst = adInstance();
    return inst ? (inst.gameVersion || '') : '';
  }

  /// 加载器筛选。**只有模组需要它**：装错加载器的 jar 会直接崩。
  ///
  /// 其余三类都不该拿实例的加载器去筛：
  /// - 整合包自带加载器（fabric 包还是 forge 包由作者定），用当前实例的
  ///   `fabric` 去筛，只支持 forge 的整合包会被整片过滤掉 —— 表现就是
  ///   「整合包页一条都没有」。
  /// - 资源包和光影跟加载器毫无关系，筛了纯属自减结果。
  function adLoader() {
    if (adType !== 'mod') { return ''; }
    var inst = adInstance();
    if (!inst) { return ''; }
    var loader = inst.loader || '';
    // 中文标签（原版 / 未知）不是 Modrinth 的 loader 名，当成不筛
    if (!loader || loader === '原版' || loader === '未知') { return ''; }
    return loader;
  }

  function switchDownloadTab(tab) {
    dlTab = tab;
    // 上一个分类可能滚了好几屏，新分类只有一行加载提示。
    // 不复位的话停在半空，看着像「什么都没有」。
    var body = document.querySelector('.page-body');
    if (body) { body.scrollTop = 0; }
    var btns = document.querySelectorAll('#dl-tabs button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-dltab') === tab);
    }
    document.getElementById('dl-pane-game').hidden = tab !== 'game';
    document.getElementById('dl-pane-addon').hidden = tab === 'game';

    if (tab === 'game') { return; }

    // 世界只存在于 CurseForge，没有「选哪个平台」这回事 —— 藏掉那个下拉，
    // 摆一个选了也没用的开关比不摆更让人困惑。
    var adSource = document.getElementById('ad-source');
    if (adSource) {
      // 原生 select 已经被 enhanceSelect 包成自定义下拉了，
      // 直接 hidden 原生元素没用，得连外层的 .cs-wrap 一起藏
      adSource.hidden = (tab === 'world');
      var wrap = adSource.closest('.cs-wrap');
      if (wrap) { wrap.hidden = (tab === 'world'); }
    }

    adType = tab;
    adPage = 0;
    adItems = [];
    adTotalPages = 0;
    // 类别必须清掉：分类表是按资源类型分的，`adventure` 拿到资源包查询里
    // facets 一筛就是零结果，CurseForge 的数字 id 更是另一套体系。
    adCat = '';
    // 搜索词也一起清。切分类 = 换一批内容，留着上一个分类的词只会得到
    // 「零结果 + 一个跟自己无关的关键词」，用户还得手动删一次才算重来。
    // 防抖定时器必须一起清掉：打字后 350ms 内切 tab，那个定时器会把旧词
    // 又写回 adQuery，等于刚清完又被自己顶回去。
    clearTimeout(adSearchTimer);
    adSearchTimer = null;
    adQuery = '';
    var adSearchBox = document.getElementById('ad-search');
    if (adSearchBox) { adSearchBox.value = ''; }
    updateAddonToolbar();
    requestAddonCategories();
    requestAddonSearch();
  }

  function updateAddonToolbar() {
    var needsInstance = !!AD_INSTANCE_TYPES[adType];
    var inst = document.getElementById('ad-instance');
    inst.hidden = !needsInstance;
    // 自绘下拉外面套了一层 .cs-wrap，隐藏 select 的同时得把壳也藏掉，
    // 不然工具栏里会留一个空的圆角框
    var instWrap = inst.closest('.cs-wrap');
    if (instWrap) { instWrap.hidden = !needsInstance; }
    if (needsInstance) {
      inst.innerHTML = '';
      var list = (state && state.instances) || [];

      // 第一项永远是「暂未选择实例」——不按版本和加载器筛，看全量。
      // 一个实例都没有时它是唯一选项，正好符合「没有可用实例就展示所有模组」。
      var none = el('option', null, '暂未选择实例');
      none.value = '';
      inst.appendChild(none);

      list.forEach(function (it) {
        var o = el('option', null, it.name + (it.gameVersion ? '  ' + it.gameVersion : ''));
        o.value = it.id;
        if (it.id === adInstId()) { o.selected = true; }
        inst.appendChild(o);
      });

      // 只有模组默认挑当前实例 —— 装错加载器的 jar 会直接崩，值得先筛上。
      // 资源包 / 光影 / 世界跟加载器无关，默认看全量；用户想按实例筛自己选。
      //
      // 只在用户没动过下拉时自动挑。否则用户选了「暂未选择实例」，
      // 下一次状态推送重建工具栏时又会被拽回当前实例，等于选不了。
      if (!adInstanceTouched && !adInstId() && list.length && adType === 'mod') {
        var cur = currentInstance();
        if (cur) { adInstPicked[adType] = cur.id; inst.value = cur.id; }
      }
      if (!list.length) {
        adInstPicked[adType] = '';
        inst.value = '';
      }
      // 原生 select 换了 options，自绘那一层要跟着重建
      if (csRegistry['ad-instance']) { csRegistry['ad-instance'].rebuild(); }
    }

    // 模组只从在线库下；其余几类本地导入才有意义
    var importBtn = document.getElementById('ad-import');
    importBtn.hidden = adType === 'mod';
    var label = { modpack: '导入整合包', world: '导入世界', resourcepack: '导入文件', shader: '导入文件' };
    document.getElementById('ad-import-label').textContent = label[adType] || '导入';

    applyAddonSearchHint();
  }

  /// 搜索框的占位提示。两家平台的索引语言不一样：
  /// Modrinth 建了中文索引，CurseForge 只有英文标题。
  /// 提示就写在输入框里 —— 用户点进来还没打字的时候正好看得见。
  function applyAddonSearchHint() {
    var box = document.getElementById('ad-search');
    if (!box) { return; }
    box.placeholder = adSourceValue() === 'curseforge'
      ? tr('仅支持英文搜索')
      : tr('支持中英文搜索');
  }

  /// 当前选的内容平台。世界只有 CurseForge，其它类型默认 Modrinth。
  function adSourceValue() {
    if (adType === 'world') { return 'curseforge'; }
    var sel = document.getElementById('ad-source');
    return sel && sel.value ? sel.value : 'modrinth';
  }

  function addonSearchKey() {
    // 平台也算进 key：同一个词在 Modrinth 和 CurseForge 上是两套结果
    return [adType, adSourceValue(), adGameVersion(), adQuery, adPage, adSort, adLoader(), adCategory()].join('|');
  }

  // ---------------- 下载页：类别下拉 ----------------

  /// 当前选中的类别。单选，空串 = 全部。后端直接当 category 参数用：
  /// Modrinth 收 slug，CurseForge 收数字 id，各归各的，前端不解释。
  function adCategory() {
    return adCat;
  }

  /// 分类表的缓存键。平台必须算进去 —— 上面那张表两家完全不一样。
  function adCatKey() {
    return adType + '|' + adSourceValue();
  }

  function requestAddonCategories() {
    var key = adCatKey();
    var cached = adCatCache[key];
    if (cached) {
      adCatGroups = cached;
      renderAddonCategories();
      return;
    }
    // 还没拿到就先清空下拉，只留「全部类别」
    adCatGroups = [];
    renderAddonCategories();
    call('addonCategories', adType, adSourceValue());
  }

  /// 把分类表填进工具栏那个下拉。
  ///
  /// Modrinth 一次给四组（类别 / 特性 / 分辨率 / 性能影响），挤成 chips 要占三四行，
  /// 首屏全被筛选项吃掉。这里全塞进一个下拉：多组时给选项加「组名 · 」前缀，
  /// 一组（CurseForge 就是一组）就不用前缀。
  function renderAddonCategories() {
    var sel = document.getElementById('ad-cat');
    if (!sel) { return; }

    sel.innerHTML = '';
    var all = el('option', null, tr('全部类别'));
    all.value = '';
    sel.appendChild(all);

    var multi = adCatGroups.length > 1;
    adCatGroups.forEach(function (g) {
      var items = (g && g.items) || [];
      var prefix = multi ? ((AD_CAT_GROUP[g.key] || g.key) + ' · ') : '';
      items.forEach(function (it) {
        if (!it || !it.slug) { return; }
        var opt = el('option', null, prefix + adCatLabel(it.slug, it.name));
        opt.value = it.slug;
        sel.appendChild(opt);
      });
    });

    // 换平台/换类型后老 slug 可能不在新表里，落回「全部」而不是让下拉空着
    sel.value = adCat;
    if (sel.value !== adCat) {
      adCat = '';
      sel.value = '';
    }
    if (csRegistry['ad-cat']) { csRegistry['ad-cat'].rebuild(); }
  }

  function requestAddonSearch() {
    var grid = document.getElementById('ad-grid');

    // 页数属于「这一次查询」，换分类 / 换类别 / 换词都得立刻清掉。
    // 不清的话新结果回来之前，界面上还挂着上一个分类的「共 87 页」，
    // 用户会以为光影有 87 页。
    var countEl = document.getElementById('ad-count');
    if (countEl) { countEl.textContent = ''; }

    var cached = cacheGet(adSearchCache, addonSearchKey());
    if (cached) {
      adReqSeq++;          // 作废在途请求，否则它回来会把缓存结果盖掉
      applyAddonSearch(cached);
      return;
    }

    grid.innerHTML = '';
    var searchLoad = el('div', 'empty');
    searchLoad.appendChild(loadingRow('正在搜索…'));
    grid.appendChild(searchLoad);
    document.getElementById('ad-pager').hidden = true;
    adReqSeq++;
    call('addonSearch', adType, adGameVersion(), adQuery, String(adPage), adSort,
      adLoader(), adCategory(), String(adReqSeq), adSourceValue());
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
      var fail = el('div', 'empty ad-fail');
      fail.appendChild(el('p', 'ad-fail-text', friendlyError(data.error)));
      // 重试只在这里给：协议正常但没结果是「这个平台真没有」，刷多少次都一样
      var retry = el('button', 'btn ghost small', '重新搜索');
      retry.addEventListener('click', function () {
        delete adSearchCache[addonSearchKey()];
        requestAddonSearch();
      });
      fail.appendChild(retry);
      grid.appendChild(fail);
      document.getElementById('ad-count').textContent = '';
      document.getElementById('ad-pager').hidden = true;
      return;
    }

    document.getElementById('ad-count').textContent =
      adTotalPages > 0 ? (tr('共 ') + adTotalPages + tr(' 页')) : '';
    renderAddonGrid();

    var pager = document.getElementById('ad-pager');
    pager.hidden = adTotalPages <= 1;
    if (!pager.hidden) {
      document.getElementById('ad-page-label').textContent =
        (adPage + 1) + ' / ' + adTotalPages;
      document.getElementById('ad-prev').disabled = adPage <= 0;
      document.getElementById('ad-next').disabled = adPage + 1 >= adTotalPages;
    }
  }

  /// 搜不到东西时说人话，重点是告诉用户下一步该干嘛。
  ///
  /// 最坑的一种是「CurseForge + 中文关键词」：这不是没内容，是平台压根不索引中文。
  /// 这时候只说「没有搜到内容」，用户会换个中文词再试，试三次就开始怀疑启动器。
  /// 重置搜索：清空关键词，回到默认来源和「全部类别」。
  ///
  /// 三样一起清才对。用户点这个按钮的意思是「这个词/这个平台我搜不下去了，重来」，
  /// 只清关键词会留下一个本来就搜不到的来源，等于没重置。
  function resetAddonSearch() {
    var box = document.getElementById('ad-search');
    if (box) { box.value = ''; }
    adQuery = '';
    adPage = 0;
    adCat = '';
    adSearchCache = {};

    // 默认来源跟设置走；缺 Key 的构建里不能切过去，那会是一片空白
    var def = (state && state.download && state.download.defaultAddonSource) || 'modrinth';
    if (def === 'curseforge' && cfReady === false) { def = 'modrinth'; }

    var sel = document.getElementById('ad-source');
    // 世界只有 CurseForge，那个下拉本来就藏着，别去动它
    if (sel && adType !== 'world' && sel.value !== def) {
      sel.value = def;
      if (csRegistry['ad-source']) { csRegistry['ad-source'].rebuild(); }
      call('setAddonSource', def);
    }

    // 来源可能换了，分类表跟着换；已选类别上面已经清空
    requestAddonCategories();
    applyAddonSearchHint();
    requestAddonSearch();
  }

  function adEmptyText() {
    var q = (adQuery || '').trim();
    if (q) {
      return tf('暂未搜索到「{0}」，请尝试更换搜索关键词或切换下载源。', q);
    }
    return '暂未搜索到内容，请尝试更换搜索关键词或切换下载源。';
  }

  function renderAddonGrid() {
    var grid = document.getElementById('ad-grid');
    grid.innerHTML = '';

    if (!adItems.length) {
      grid.appendChild(el('div', 'empty', adEmptyText()));
      return;
    }

    adItems.forEach(function (it) {
      var card = el('div', 'ad-card');

      if (it.iconUrl) {
        card.appendChild(buildAddonIcon(it));
      } else {
        card.appendChild(adPlaceholderIcon(it.title));
      }

      var body = el('div', 'ad-body');
      body.appendChild(el('div', 'ad-title', it.title || ''));
      var meta = it.author ? (tr('作者 ') + it.author) : '';
      body.appendChild(el('div', 'ad-meta', meta));
      if (it.description) {
        body.appendChild(el('div', 'ad-desc', it.description));
      }
      if (it.categories && it.categories.length) {
        var tags = el('div', 'ad-tags');
        // 分类里既有内容性质（库 / 优化 / 装饰）也有加载器（Fabric / Forge），
        // 跟 HMCL 的卡片一样全列出来，用户一眼能判断这个资源合不合用
        it.categories.forEach(function (c) {
          tags.appendChild(el('span', 'tag', categoryLabel(c)));
        });
        body.appendChild(tags);
      }
      card.appendChild(body);

      card.addEventListener('click', function () { openAddonVersions(it); });
      grid.appendChild(card);
    });

    // 一页 20 张卡片同时"啪"地出现太硬。按 18ms 递进淡入，前 6 张带延迟，
    // 后面的同时落位 —— 用户视线本来也只跟着前几张走。
    stagger(grid);
  }

  /// Modrinth 的图标放在 cdn.modrinth.com，这个域名在国内经常连不上
  /// （实测 curl 和 JVM 都 connect timeout，而同域的 api.modrinth.com 正常）。
  /// 所以按「直连 → 公共图片代理」的顺序试，全挂了才退回字母块。
  ///
  /// wsrv.nl 是老牌的开源图片缓存服务，它自己去取 cdn 上的图再转给我们，
  /// 国内能连上，代价是多一跳、图会被重新编码。
  /// 拼「核心进程」的 HTTP 地址。壳模式下 port/token 挂在页面 URL 上；
  /// JavaFX 模式没有这两样，返回 null（那种模式不走本地 HTTP）。
  function apiEndpoint(path, params) {
    var base = apiBase();
    if (!base) { return null; }
    var url = 'http://127.0.0.1:' + base.port + path;
    var parts = [];
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null) { parts.push(k + '=' + encodeURIComponent(params[k])); }
      });
    }
    parts.push('token=' + encodeURIComponent(base.token));
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + parts.join('&');
  }

  function iconCandidates(url) {
    var list = [url];
    var m = /^https?:\/\/(.+)$/i.exec(url || '');
    if (m) {
      var bare = encodeURIComponent(m[1]);
      list.push('https://wsrv.nl/?url=' + bare + '&w=96&h=96&fit=cover');
      list.push('https://images.weserv.nl/?url=' + bare + '&w=96&h=96&fit=cover');
    }
    return list;
  }

  // 图标 blob 的 objectURL 缓存。key 是原始的 cdn 地址。
  // 上限防止内存无限涨——一页 20 个图标、每个十几 KB，300 个也就几 MB。
  var iconBlobCache = {};
  var ICON_BLOB_MAX = 300;

  /// 建一个卡片图标。
  ///
  /// **不能直接 `img.src = 后端地址`**：页面在 `tauri.localhost`（公开地址空间），
  /// 后端在 `127.0.0.1`（本地），WebView2 对 <img> 这类 subresource 的
  /// Private Network Access 检查比 fetch 严得多——同一个地址 `fetch` 返回 200，
  /// `<img>` 会 0ms 直接 error（实测）。
  ///
  /// 所以走 fetch 拿 blob，再 `createObjectURL` 给 img。这样只要能取到字节就一定显示，
  /// 不依赖浏览器的私有网络策略。
  function buildAddonIcon(item) {
    var local = apiEndpoint('/icon', { u: item.iconUrl });
    if (!local) {
      // 非壳模式（JavaFX WebView）没有本地 HTTP，直接请求原地址
      return buildRemoteIcon(item);
    }

    var img = document.createElement('img');
    img.className = 'ad-icon loading';

    var cached = iconBlobCache[item.iconUrl];
    if (cached) {
      img.src = cached;
      img.classList.remove('loading');
      return img;
    }

    fetch(local).then(function (response) {
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      return response.blob();
    }).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      rememberIconBlob(item.iconUrl, objectUrl);
      img.src = objectUrl;
      img.classList.remove('loading');
    }).catch(function () {
      // 取不到就换字母占位，别留一块空白
      if (img.parentNode) {
        img.replaceWith(adPlaceholderIcon(item.title));
      }
    });

    return img;
  }

  function rememberIconBlob(key, objectUrl) {
    var keys = Object.keys(iconBlobCache);
    if (keys.length >= ICON_BLOB_MAX) {
      var oldest = keys[0];
      try { URL.revokeObjectURL(iconBlobCache[oldest]); } catch (e) { /* 忽略 */ }
      delete iconBlobCache[oldest];
    }
    iconBlobCache[key] = objectUrl;
  }

  /// 非壳模式的退路：直接请求远程地址，失败换代理、再失败换字母。
  function buildRemoteIcon(item) {
    var urls = iconCandidates(item.iconUrl);
    var img = document.createElement('img');
    img.className = 'ad-icon loading';
    img.loading = 'lazy';
    img.decoding = 'async';

    var index = 0;
    var timer = null;

    function tryNext() {
      clearTimeout(timer);
      if (index >= urls.length) {
        if (img.parentNode) {
          img.replaceWith(adPlaceholderIcon(item.title));
        }
        return;
      }
      var src = urls[index++];
      timer = setTimeout(tryNext, 7000);
      img.onload = function () {
        clearTimeout(timer);
        if (img.naturalWidth > 0) {
          img.classList.remove('loading');
        } else {
          tryNext();
        }
      };
      img.onerror = tryNext;
      img.src = src;
    }

    tryNext();
    return img;
  }

  /// 图标拉不到时的占位：用项目名算一个稳定色，显示首字母。
  ///
  /// Modrinth 的图标放在 cdn.modrinth.com，国内经常连不上，一屏全是灰块很难看。
  /// 按名字哈希上色之后，每个项目有固定配色，看着像设计好的字母头像。
  function adPlaceholderIcon(title) {
    var name = (title || '?').trim() || '?';
    var hue = 0;
    for (var i = 0; i < name.length; i++) {
      hue = (hue * 31 + name.charCodeAt(i)) % 360;
    }
    var d = el('div', 'ad-icon placeholder', name.charAt(0).toUpperCase());
    d.style.background = 'hsl(' + hue + ', 62%, 93%)';
    d.style.color = 'hsl(' + hue + ', 48%, 40%)';
    return d;
  }

