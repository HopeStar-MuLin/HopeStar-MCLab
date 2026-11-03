  // ---------------- 盔甲预览 ----------------
  //
  // 皮肤站那套（blessing-skin-server 里的 skinview3d 3.x）只画皮肤、披风、鞘翅，
  // 没有盔甲模型，所以这里自己补：`vendor/skinview3d.bundle.js` 是
  // `tools/skinview3d-armor` 那个打了盔甲层的本地构建，几何按 **1.21.1** 的
  // HumanoidArmorLayer 摆（头盔/胸甲/靴子外扩 1px，护腿 0.5px，手臂只到上臂）。
  //
  // 贴图是 1.21.1 客户端的原版图层，内置在 `img/armor/` 下。四个部位各一个下拉，
  // 可以混搭（头盔钻石 + 胸甲皮革 + 护腿铁 + 靴子金），默认全都不穿。

  var ARMOR_DIR = 'img/armor/';

  /// 四个装备槽，顺序就是界面上的排列顺序
  var ARMOR_SLOTS = [
    { id: 'helmet', label: '头盔' },
    { id: 'chest', label: '胸甲' },
    { id: 'legs', label: '护腿' },
    { id: 'boots', label: '靴子' }
  ];

  /// 能穿的材质。`only` 表示只有这个槽能用（海龟壳只做头盔，贴图也只有头盔那一块）。
  /// `item` 是物品图标的前缀：金在游戏里叫 golden，跟贴图名 gold 不一样。
  var ARMOR_MATERIALS = [
    // 皮革的物品图标在游戏里是靠染料色染上去的（贴图本身是灰度），
    // 直接显示原图会是一张白图，所以准备了 *_dyed.png
    { id: 'leather', name: '皮革', item: 'leather', dye: true },
    { id: 'chainmail', name: '锁链', item: 'chainmail' },
    { id: 'iron', name: '铁', item: 'iron' },
    // 铜盔甲是 1.21.9 才有的，1.21.1 的客户端里没有这套图层 ——
    // 贴图和图标是拿铁的按亮度映射成铜色生成的（见 AGENT.md）
    { id: 'copper', name: '铜', item: 'copper' },
    { id: 'gold', name: '金', item: 'golden' },
    { id: 'diamond', name: '钻石', item: 'diamond' },
    { id: 'netherite', name: '下界合金', item: 'netherite' },
    { id: 'turtle', name: '海龟壳', item: 'turtle', only: 'helmet' }
  ];

  /// 槽位到物品图标后缀的映射（护腿在游戏里叫 leggings）
  var ARMOR_ITEM_SUFFIX = {
    helmet: 'helmet',
    chest: 'chestplate',
    legs: 'leggings',
    boots: 'boots'
  };

  /// 四个槽当前穿的材质，空串表示没穿。不再用 <select>：
  /// 图标比下拉直观，而且能一眼看出哪个部位还空着。
  var armorSel = { helmet: '', chest: '', legs: '', boots: '' };
  /// 盔甲总开关。默认关：大多数人只是看皮肤，一进来先套四个空框没必要；
  /// 关着的时候四件装备完全不参与渲染，格子也不出现
  var armorOn = false;
  /// 弹窗当前在给哪个槽选
  var armorPickSlot = null;

  /// 某个材质在某槽的物品图标路径
  function armorItemIcon(mat, slot) {
    return 'img/item/' + mat.item + '_' + ARMOR_ITEM_SUFFIX[slot]
      + (mat.dye ? '_dyed' : '') + '.png';
  }

  /// 皮革在游戏里可染色：基础图层是灰度，要乘上染料色（默认这个棕）
  var LEATHER_COLOR = '#a06540';

  var armorImages = null;
  var armorImagesLoading = null;
  /// 鞘翅自己的贴图（灰紫那对翅膀）；披风里没带鞘翅图案时才用它
  var elytraImage = null;
  /// 上一次套上去的组合，形如 "helmet:iron,chest:diamond"
  var viewerArmorSig = null;

  function loadImageEl(src) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  /// 各材质的图层 + 皮革染色遮罩 + 一张鞘翅图，第一次用到时一次读完。
  /// 海龟壳只有 layer_1，别去请求不存在的 layer_2（会 404）。
  function ensureArmorImages() {
    if (armorImages) { return Promise.resolve(armorImages); }
    if (armorImagesLoading) { return armorImagesLoading; }

    armorImagesLoading = Promise.all(ARMOR_MATERIALS.map(function (mat) {
      var id = mat.id;
      var layer1 = loadImageEl(ARMOR_DIR + id + '_layer_1.png');
      var layer2 = id === 'turtle'
        ? Promise.resolve(null)
        : loadImageEl(ARMOR_DIR + id + '_layer_2.png');
      var overlay = id === 'leather'
        ? loadImageEl(ARMOR_DIR + 'leather_layer_1_overlay.png')
        : Promise.resolve(null);
      return Promise.all([layer1, layer2, overlay]).then(function (imgs) {
        return [id, { l1: imgs[0], l2: imgs[1], overlay: imgs[2] }];
      });
    })).then(function (pairs) {
      var out = {};
      pairs.forEach(function (p) { if (p[1].l1) { out[p[0]] = p[1]; } });
      armorImages = out;
      armorImagesLoading = null;
      return loadImageEl(ARMOR_DIR + 'elytra.png');
    }).then(function (img) {
      elytraImage = img;
      return armorImages;
    });
    return armorImagesLoading;
  }

  /// 皮革染色：灰度底 × 染料色，再盖一层遮罩（拉链、缝线那些细节）。
  ///
  /// `multiply` 会把透明区域也涂上颜色，所以接着用 `destination-in`
  /// 拿底图的 alpha 当遮罩裁回来 —— 顺序反了边缘会多出一圈实色。
  function leatherArmorCanvas(base, overlay) {
    var w = base.naturalWidth || base.width || 64;
    var h = base.naturalHeight || base.height || 32;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(base, 0, 0, w, h);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = LEATHER_COLOR;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(base, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    if (overlay) { ctx.drawImage(overlay, 0, 0, w, h); }
    return c;
  }

  /// 取某个槽要用的图：护腿用 layer_2，其余用 layer_1；皮革现染一次后缓存。
  function armorTextureFor(materialId, slot) {
    var real = armorImages && armorImages[materialId];
    if (!real) { return null; }
    if (materialId === 'leather') {
      if (slot === 'legs') {
        if (!real._inner) { real._inner = leatherArmorCanvas(real.l2 || real.l1, real.overlay); }
        return real._inner;
      }
      if (!real._outer) { real._outer = leatherArmorCanvas(real.l1, real.overlay); }
      return real._outer;
    }
    return slot === 'legs' ? (real.l2 || real.l1) : real.l1;
  }

  /// 四个槽当前的组合，用来判断要不要重画 —— 每次 syncViewer 都重画
  /// 会重建纹理，画面会闪一下。
  function armorSignature() {
    if (!armorOn) { return 'off'; }
    var parts = [];
    for (var i = 0; i < ARMOR_SLOTS.length; i++) {
      var id = ARMOR_SLOTS[i].id;
      if (armorSel[id]) { parts.push(id + ':' + armorSel[id]); }
    }
    return parts.join(',');
  }

  /// 盔甲开关的按钮态跟着 armorOn 走（syncViewer 每次都会调一次）。
  function renderArmorSeg() {
    var seg = document.getElementById('armor-seg');
    if (!seg) { return; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var on = (btns[i].getAttribute('data-armor') === 'on') === armorOn;
      btns[i].classList.toggle('active', on);
    }
  }

  /// 把四个槽的当前选择套到 viewer 上。
  function applyArmor(v) {
    if (!v) { return; }
    if (!armorImages) {
      // 图还没读完：读完再画一次，用户不用再点
      ensureArmorImages().then(function () { if (v === viewer) { applyArmor(v); } });
      return;
    }
    var parts = {};
    for (var i = 0; i < ARMOR_SLOTS.length; i++) {
      var slot = ARMOR_SLOTS[i].id;
      var id = armorSel[slot];
      // 没选的槽也要显式给 null，否则上一次穿的还挂在身上；
      // 总开关关掉时一律 null —— 这就是「关掉就真的不渲染」
      parts[slot] = (armorOn && id) ? armorTextureFor(id, slot) : null;
    }
    try {
      v.loadArmors(parts);
    } catch (e) {
      console.error('[3d] 盔甲加载失败', e);
    }
  }

  /// 把四个槽的当前选择画到格子上：穿了就显示物品图标 + 实线框，
  /// 没穿显示虚线框和「空」字（和「无登录账号」那个头像占位是同一套视觉）。
  function renderArmorCells() {
    var cells = document.querySelectorAll('#ap-armor-row .armor-cell');
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var slot = cell.getAttribute('data-slot');
      var img = cell.querySelector('img');
      var empty = cell.querySelector('.ac-empty');
      var mat = null;
      for (var j = 0; j < ARMOR_MATERIALS.length; j++) {
        if (ARMOR_MATERIALS[j].id === armorSel[slot]) { mat = ARMOR_MATERIALS[j]; break; }
      }
      if (mat) {
        img.src = armorItemIcon(mat, slot);
        img.hidden = false;
        if (empty) { empty.hidden = true; }
        cell.classList.add('on');
        cell.title = ARMOR_SLOTS[i].label + '：' + mat.name;
      } else {
        img.hidden = true;
        if (empty) { empty.hidden = false; }
        cell.classList.remove('on');
        // 悬停提示只留部位名，别带操作说明 —— 格子的虚线边框已经说明可以点了
        cell.title = ARMOR_SLOTS[i].label;
      }
    }
  }

  /// 贴着槽位弹出的小浮层：列出这个槽能穿的所有材质，第一格是「无」。
  ///
  /// 不做成全屏对话框 —— 换一件甲只是想看一眼效果，盖住 3D 预览反而没法判断。
  function openArmorPicker(slot, anchor) {
    armorPickSlot = slot;
    var label = '装备';
    for (var i = 0; i < ARMOR_SLOTS.length; i++) {
      if (ARMOR_SLOTS[i].id === slot) { label = ARMOR_SLOTS[i].label; }
    }
    var title = document.getElementById('armor-pick-title');
    if (title) { title.textContent = label; }

    var grid = document.getElementById('armor-pick-grid');
    var pop = document.getElementById('armor-picker');
    if (!grid || !pop) { return; }
    grid.innerHTML = '';

    // 「无」：和图标的 26px 同尺寸的虚线空框
    var none = el('button', 'armor-pop-item' + (armorSel[slot] ? '' : ' on'));
    none.appendChild(el('span', 'apn-empty', '无'));
    none.appendChild(el('span', 'apn', '不穿'));
    none.addEventListener('click', function () { pickArmor(''); });
    grid.appendChild(none);

    for (var j = 0; j < ARMOR_MATERIALS.length; j++) {
      var mat = ARMOR_MATERIALS[j];
      if (mat.only && mat.only !== slot) { continue; }
      (function (m) {
        var item = el('button', 'armor-pop-item' + (armorSel[slot] === m.id ? ' on' : ''));
        var img = document.createElement('img');
        img.src = armorItemIcon(m, slot);
        img.alt = m.name;
        item.appendChild(img);
        item.appendChild(el('span', 'apn', m.name));
        item.addEventListener('click', function () { pickArmor(m.id); });
        grid.appendChild(item);
      })(mat);
    }

    // 先显示再量尺寸，否则 offsetWidth/Height 都是 0
    pop.hidden = false;
    placeArmorPicker(anchor);
  }

  /// 把浮层摆在槽位正下方；下面放不下就翻到上面，再夹在视口内。
  function placeArmorPicker(anchor) {
    var pop = document.getElementById('armor-picker');
    if (!pop || !anchor) { return; }
    var r = anchor.getBoundingClientRect();
    var pw = pop.offsetWidth;
    var ph = pop.offsetHeight;
    var gap = 8;

    var left = r.left + r.width / 2 - pw / 2;
    var top = r.bottom + gap;
    // 四个格子贴在最下面，弹层要往上翻 —— 侧栏高度不够时也不会被窗口裁掉
    if (top + ph > window.innerHeight - 8) {
      top = r.top - ph - gap;
    }
    if (top < 8) { top = 8; }
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));

    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }

  function closeArmorPicker() {
    var pop = document.getElementById('armor-picker');
    if (pop) { pop.hidden = true; }
    armorPickSlot = null;
  }

  function pickArmor(materialId) {
    if (!armorPickSlot) { return; }
    armorSel[armorPickSlot] = materialId || '';
    renderArmorCells();
    applyArmor(viewer);
    closeArmorPicker();
  }

  /// 格子的点击、浮层的关闭，只绑一次。
  function initArmorCells() {
    var cells = document.querySelectorAll('#ap-armor-row .armor-cell');
    for (var i = 0; i < cells.length; i++) {
      (function (cell) {
        cell.addEventListener('click', function (e) {
          var pop = document.getElementById('armor-picker');
          // 再点同一个格子就是收起，不用先点空白处
          if (pop && !pop.hidden && armorPickSlot === cell.getAttribute('data-slot')) {
            closeArmorPicker();
            return;
          }
          openArmorPicker(cell.getAttribute('data-slot'), cell);
          e.stopPropagation();
        });
      })(cells[i]);
    }

    // 点浮层以外的地方收起。用 mousedown 而不是 click：
    // click 要等鼠标抬起，中间拖动选择文字也会触发，手感发飘。
    document.addEventListener('mousedown', function (e) {
      var pop = document.getElementById('armor-picker');
      if (!pop || pop.hidden) { return; }
      if (pop.contains(e.target)) { return; }
      if (e.target.closest && e.target.closest('.armor-cell')) { return; }
      closeArmorPicker();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeArmorPicker(); }
    });
    // 滚动、改窗口大小时位置就失效了，直接收起来，免得贴错地方
    window.addEventListener('resize', function () { closeArmorPicker(); });
    var body = document.getElementById('page-body');
    if (body) { body.addEventListener('scroll', function () { closeArmorPicker(); }, true); }

    renderArmorCells();
  }

  /// 动作状态：站着还是走起来。skinview3d 自带 WalkingAnimation，
  /// 皮肤站（Viewer.tsx）也是拿它切换的 —— 只是它做成了循环 4 种动画的按钮，
  /// 这里只要「站立 / 行走」两态，看得清就够了。
  var skinAnim = 'idle';

  function applyAnimation(v) {
    if (!v) { return; }
    var S = window.skinview3d;
    if (!S) { return; }
    try {
      var isWalk = S.WalkingAnimation && v.animation instanceof S.WalkingAnimation;
      var isIdle = S.IdleAnimation && v.animation instanceof S.IdleAnimation;

      if (skinAnim === 'walk') {
        if (!isWalk) {
          v.animation = new S.WalkingAnimation();
        }
        v.animation.speed = 0.7;
        return;
      }

      // 「站立」不是完全静止：游戏里站着的时候手臂会随呼吸轻微摆动，
      // skinview3d 的 IdleAnimation 就是做这个的（手臂绕 z 轴 ±0.03 弧度，
      // 顺带让披风轻轻飘）。皮肤站的四态循环里也包含它。
      if (!isIdle) {
        // 从行走切回来时腿还停在迈步的中间姿势，先复位一次再交给 idle ——
        // IdleAnimation 只管手臂和披风，不动腿。
        if (isWalk && v.playerObject && typeof v.playerObject.resetJoints === 'function') {
          v.playerObject.resetJoints();
        }
        if (S.IdleAnimation) {
          v.animation = new S.IdleAnimation();
        } else {
          v.animation = null;
        }
      }
    } catch (e) { /* 老 bundle 没有动画类就当不支持 */ }
  }

  function renderAnimSeg() {
    var seg = document.getElementById('anim-seg');
    if (!seg) { return; }
    var row = document.getElementById('ap-anim-row');
    // 只有能真跑动画时才露出这组按钮：JavaFX 模式是后端渲的 PNG，
    // 点了也没反应，不如藏起来
    seg.hidden = false;
    if (row) { row.hidden = false; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-anim') === skinAnim;
      btns[i].classList.toggle('active', on);
    }
  }

  /// 后背装备。游戏里「鞘翅」和「披风」共用同一张贴图，只是换了个模型 ——
  /// skinview3d 把这件事做成 `playerObject.backEquipment` 上的一个开关，
  /// 皮肤站（blessing-skin-server）的 Viewer.tsx 也是这么切的。
  var backEquipment = 'cape';

  /// 披风贴图里自带鞘翅图案吗？
  ///
  /// 鞘翅模型用的是 64x32 贴图上的 x=22..46 / y=0..24 这一条（skinview3d 的
  /// `setCapeUVs(box, 22, 0, 10, 20, 2)`：左右各 2px 侧面 + 10px 正面 + 10px 背面）。
  /// 披风本体只用 0..22，所以这块只要被画满，就说明这张图是「披风 + 鞘翅」的合并图。
  ///
  /// 之前这里只测了 (22,0) 起 10x20 的一小块，而实际翅膀图案画在 x 31..45 ——
  /// 正好落在检测框外面，所以自带鞘翅的披风一直被当成「没有鞘翅」。
  function capeHasElytraArt(v) {
    try {
      var c = v.capeCanvas;
      if (!c || !c.width || !c.height) { return false; }
      // 检测框只罩「翅膀实际会画到的那一块」：x 28..46、y 0..22。
      // 不取整个 UV 区（22..46）：披风本体的右边缘会溢进来，把普通披风
      // 误判成自带鞘翅；也不取 24..46，那样翅膀只占 15%，和噪声太接近。
      var sx = Math.round(28 * c.width / 64);
      var sy = 0;
      var sw = Math.max(1, Math.round(18 * c.width / 64));
      var sh = Math.max(1, Math.round(22 * c.height / 32));
      var data = c.getContext('2d').getImageData(sx, sy, sw, sh).data;
      var hits = 0;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] > 8) { hits++; }
      }
      // 翅膀是斜着铺的，中间还有透明缝隙，实测这张「披风+鞘翅」合并图是 20.4%。
      // 阈值取 10%：够低，翅膀画得稀疏也能认出来；又够高，普通披风在这一块
      // 几乎是全空的（实测 Migration 披风整块只有个位数像素），不会误判。
      return hits >= (data.length / 4) * 0.10;
    } catch (e) {
      return false;
    }
  }

  /// 把鞘翅图案补到「正反两面」。
  ///
  /// 原版 elytra.png 只把翅膀画在 UV 的背面那块（64x32 坐标里 x 36..46），
  /// 正面（x 24..34）是空的 —— 因为游戏里玩家永远从背后看翅膀，正面看不见。
  /// 但预览可以随便转，转过去就是一张透明的空翅膀，看着像「里面被掏空了」。
  ///
  /// 这里量一下两面的不透明像素，把有内容的那面贴到另一面上。翅膀是轴对称的，
  /// 镜像一下看不出区别；披风本体只用 x 0..22，碰不到。
  /// 鞘翅贴图只保留背面那一块。
  ///
  /// 原版鞘翅是**三面包的薄壳**：只有外表面有图，内侧是空的。之前这里做了两件
  /// 多余的事，都跟官方对不上：
  ///
  /// 1. 把正面（内表面）也补满 —— 内侧多出一层皮，从侧面看像给翅膀套了个壳；
  /// 2. 把侧面和底面的边缘像素铺过去 —— 那圈 UV 在模型上对应的是**颈部和披风
  ///    连接处**，不是鞘翅的底面。铺上图案之后，脖子后面会凭空多出一截蓝色条纹。
  ///
  /// 现在只清正面，别的都不动。翅膀就是一张单面薄片，和游戏里看到的一致。
  ///
  /// （函数名沿用旧名字，调用方不用改。）
  function mirrorElytra(canvas) {
    if (!canvas || !canvas.width || !canvas.height) { return canvas; }
    try {
      var w = canvas.width;
      var h = canvas.height;
      var out = document.createElement('canvas');
      out.width = w;
      out.height = h;
      var ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(canvas, 0, 0);

      // 64x32 基准下的 UV：正面 24..34、背面 36..46，纵向 2..22
      var fw = Math.round(10 * w / 64);
      var fh = Math.round(20 * h / 32);
      var y = Math.round(2 * h / 32);
      var fx = Math.round(24 * w / 64);

      // 正面 = 内表面，清空。背面那块的图原样留着，不动。
      ctx.clearRect(fx, y, fw, fh);
      return out;
    } catch (e) {
      // 跨域画布读不了像素就原样返回
      return canvas;
    }
  }

  /// 当前应该用哪张图给鞘翅，返回已经补好两面的 canvas（或 null 表示不换）。
  function elytraCanvasFor(v) {
    if (backEquipment !== 'elytra') { return null; }
    var base = capeHasElytraArt(v) && v.capeCanvas ? v.capeCanvas : elytraImage;
    if (!base) { return null; }
    return mirrorElytra(base);
  }

  function applyBackEquipment(v, hasCape) {
    if (!v || !v.playerObject) { return; }
    try {
      // 没披风就什么都不该挂在背上：`resetCape()` 已经把 cape/elytra 两张
      // map 都清成 null，这时候再把 backEquipment 设成 'elytra'（或 'cape'），
      // 网格会带着空贴图渲染出来 —— 材质没有 map 就是纯白，
      // 看到的就是一条 1 像素宽的白边。所以这里必须设 null。
      if (!hasCape) {
        v.playerObject.backEquipment = null;
        return;
      }
      if (v.loadElytra) {
        // 披风自带鞘翅图案就用披风那张，否则用内置的灰紫翅膀；
        // 两张都过一遍 mirrorElytra —— 原版只画了背面，正面是透的
        v.loadElytra(elytraCanvasFor(v));
      }
      // 注意 loadCape 每次都会把 backEquipment 重置成 cape，
      // 所以换完披风要再喊一次，不然用户选的鞘翅会被打回披风
      v.playerObject.backEquipment = backEquipment;
    } catch (e) { /* 老 bundle 没这个属性就当没有 */ }
  }

  /// 两个按钮在**皮肤页和披风页都显示**（页面上都能转到背面看效果），
  /// 但前提是真的戴着披风：没披风就没有贴图，切鞘翅只会得到两只白板翅膀。
  ///
  /// `hasArt` 表示这件披风的贴图里画了鞘翅图案（合并图）。为真时在「鞘翅」
  /// 按钮上点一个小圆点 —— 不然用户看不出这件披风切过去是不是原版图案。
  function renderBackSeg(hasCape, hasArt) {
    var seg = document.getElementById('back-seg');
    if (!seg) { return; }
    var show = !!hasCape && wantsFrontend3d();
    seg.hidden = !show;
    var row = document.getElementById('ap-back-row');
    if (row) { row.hidden = !show; }
    var btns = seg.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var key = btns[i].getAttribute('data-back');
      btns[i].classList.toggle('active', key === backEquipment);
      if (key === 'elytra') {
        btns[i].classList.toggle('has-art', !!hasArt);
        btns[i].title = hasArt
          ? '这件披风自带鞘翅图案，切过去用它自己的'
          : '这件披风没有鞘翅图案，用内置的原版鞘翅';
      }
    }
  }

  /// 把 data URL 先解码成 <img>，再把 Image 交给 skinview3d。
  ///
  /// 直接传字符串时，skinview3d 内部要自己 new Image 等 onload；而它拿到结果后的
  /// 第一步是 `rc()` —— 里面 `clearRect` 之后才 `drawImage`，那段时间 skinCanvas
  /// 是空的，紧接着又 dispose 旧纹理重建。表现出来就是换皮肤那一下模型白闪。
  ///
  /// 传 HTMLImageElement 时它是同步 drawImage + 重建纹理，一帧内完成，看不到空窗。
  /// 解码失败就退回原路径，不能因为一张坏图把预览卡死。
  function loadSkinSmooth(v, src, model) {
    var apply = function (arg) {
      if (v !== viewer) { return; }
      try { v.loadSkin(arg, { model: model }); } catch (e) { console.error('[3d] loadSkin', e); }
    };
    var img = new Image();
    img.onload = function () { apply(img); };
    img.onerror = function () { apply(src); };
    img.src = src;
  }

  /// 披风同理。返回 Promise：调用方要等它画进 capeCanvas 再量鞘翅范围。
  function loadCapeSmooth(v, src) {
    if (!src) {
      try { return Promise.resolve(v.loadCape(null)); } catch (e) { return Promise.resolve(); }
    }
    return new Promise(function (resolve) {
      var img = new Image();
      var apply = function (arg) {
        if (v !== viewer) { resolve(); return; }
        try { resolve(v.loadCape(arg)); } catch (e) { resolve(); }
      };
      img.onload = function () { apply(img); };
      img.onerror = function () { apply(src); };
      img.src = src;
    });
  }

  function syncViewer() {
    var v = ensureViewer();
    if (!v || !apData) { return; }

    var state = apData.state || {};
    var skin = findAsset(apData.skins, state.skin);
    var cape = findAsset(apData.capes, state.cape);

    // 没选自定义皮肤就穿账号自带那张。
    // 后端在「没有本地皮肤但有账号纹理」时会把 state.skin 报成 null，
    // findAsset 因此返回 null，接下去就落到 accountSkinRaw 上。
    var skinSrc = (skin && skin.raw) || apData.accountSkinRaw || null;

    // 模型：state.model 是用户在「宽体/纤体」里手动选的那个，优先级最高。
    // 之前这里先看 asset.model，导致点了切换没反应——内置皮肤自带 model，
    // 把用户的选择盖掉了。
    var model;
    if (state.model === 'slim') { model = 'slim'; }
    else if (state.model === 'default' || state.model === 'wide') { model = 'classic'; }
    else if (skin && skin.model === 'slim') { model = 'slim'; }
    else { model = 'classic'; }

    // 披风来源分三种：
    //   - 本地资产（离线 / 外置认证，或者正版用户从本地列表里选的）
    //   - 正版账号的服务器披风：不在 apData.capes 里，得从 serverCapes 或账号纹理里取
    //   - 明确不戴
    var capeSrc = (cape && cape.raw) ? cape.raw : null;
    if (!capeSrc && apData.kind === 'microsoft') {
      var pending = apData.pendingServerCape;
      var list = serverCapes || [];
      if (pending === '') {
        capeSrc = null;                       // 用户明确摘掉了
      } else if (pending) {
        for (var ci = 0; ci < list.length; ci++) {
          if (list[ci].id === pending) { capeSrc = list[ci].raw || null; break; }
        }
        // 目标那件的展开图还没到手（列表是异步一张张推的）。这时候不能就
        // 这么空着——点了切换却看到模型上光秃秃一片，比显示旧图还吓人。
        // 后端在 selectServerCape 时已经把选中那件的图塞进 accountCapeRaw 了。
        if (!capeSrc) { capeSrc = apData.accountCapeRaw || null; }
      } else {
        // 没动过：用账号当前装备的那件。纹理还没到就先留空，
        // onCapePreview / onAppearance 到货后会再同步一次
        for (var cj = 0; cj < list.length; cj++) {
          if (list[cj].active && list[cj].raw) { capeSrc = list[cj].raw; break; }
        }
        if (!capeSrc) { capeSrc = apData.accountCapeRaw || null; }
      }
    }

    // 「看鞘翅」的归位判断放在 capeSrc 定稿之后，而且只在**确实没有披风**时才做。
    //
    // 两处坑：
    // 1. 原来这段写在服务器披风分支前面。正版账号的披风不在 apData.capes 里，
    //    每次 syncViewer 都先判成「没披风」，把鞘翅打回披风 —— 切皮肤/披风标签、
    //    数据一刷新就横跳一次。
    // 2. 光挪位置还不够：刚点了一件披风、纹理还在路上时 capeSrc 也是 null，
    //    按它判照样会打回披风。所以这里看的是「用户到底有没有披风」，
    //    不是「这一帧算不算得出图」。
    var reallyNoCape;
    if (apData.kind === 'microsoft') {
      var pend = apData.pendingServerCape;
      // pending === ''：用户明确摘掉了。null：没动过，看服务器有没有装备中的
      reallyNoCape = pend === ''
        ? true
        : (pend === null || pend === undefined)
          ? !(serverCapes || []).some(function (c) { return c.active; })
          : false;
    } else {
      reallyNoCape = !state.cape;
    }
    if (reallyNoCape) { backEquipment = 'cape'; }

    // 只有贴图或模型真的变了才重新加载。
    // skinview3d 的 loadSkin 每调一次都会重新建纹理，切宽体/纤体这种只改参数的操作
    // 再走一遍就会让 3D 区域闪白一下。
    var skinChanged = (skinSrc !== viewerSkinSrc) || (model !== viewerSkinModel);

    if (skinChanged && skinSrc) {
      viewerSkinSrc = skinSrc;
      viewerSkinModel = model;
      loadSkinSmooth(v, skinSrc, model);
    }

    if (capeSrc !== viewerCapeSrc) {
      viewerCapeSrc = capeSrc;
      var capeLoaded = loadCapeSmooth(v, capeSrc);
      // 传字符串时 loadCape 返回 Promise（内部 new Image 异步解码）。
      // 必须等它真的画进 capeCanvas 再量鞘翅区和套纹理，否则量到的是上一张
      // 披风的内容 —— 表现就是「换了披风，小圆点和翅膀要再切一次页才更新」。
      Promise.resolve(capeLoaded).then(function () {
        if (v !== viewer) { return; }
        applyBackEquipment(v, !!capeSrc);
        // 按钮用「有没有披风」判，不用「这一帧有没有图」——
        // 换披风时纹理解码要几十毫秒，按图判会让整排按钮闪一下
        renderBackSeg(!reallyNoCape, !!capeSrc && capeHasElytraArt(v));
      });
    } else {
      applyBackEquipment(v, !!capeSrc);
      renderBackSeg(!reallyNoCape, !!capeSrc && capeHasElytraArt(v));
    }

    // 内置贴图是本地文件，第一次进来先把它们读进内存
    ensureArmorImages();

    // 盔甲和皮肤/披风都是独立的材质槽，换皮肤不会把它冲掉，
    // 所以只在四件装备的组合变了时才重画
    // JavaFX 模式是后端渲染的静态 PNG，套不上盔甲，开关也一起收掉
    var armorRow = document.getElementById('ap-armor-row');
    if (armorRow) { armorRow.hidden = !armorOn || !wantsFrontend3d(); }
    var armorSwitchRow = document.getElementById('ap-armor-on-row');
    if (armorSwitchRow) { armorSwitchRow.hidden = !wantsFrontend3d(); }
    renderArmorSeg();
    var sig = armorSignature();
    if (sig !== viewerArmorSig) {
      viewerArmorSig = sig;
      applyArmor(v);
    }

    // 动作状态：站立 / 行走。放在取景之前，先让手脚摆到位再算画面
    applyAnimation(v);
    renderAnimSeg();

    // 披风页第一次进来转到背面 3/4，皮肤页转正；之后各用各记住的角度。
    // 没有披风时披风页也保持正面——转过去只会看到后脑勺。
    var yaw = tabYaw[apTab];
    if (yaw === null || yaw === undefined) {
      yaw = (apTab === 'cape' && capeSrc) ? Math.PI * 0.85 : 0;
      tabYaw[apTab] = yaw;
    }
    setViewerYaw(yaw);

    resizeViewer();
    // 取景只需要在模型变化（包围盒跟着变）时重算；
    // 换皮肤贴图不改包围盒，重算会让画面跳一下
    if (model !== viewerFramedModel) {
      viewerFramedModel = model;
      frameViewer();
    }
  }

  /// 上一次喂给 3D 预览的皮肤 / 模型 / 披风。用来判断要不要真的重新加载。
  var viewerSkinSrc = null;
  var viewerSkinModel = null;
  var viewerCapeSrc = null;
  var viewerFramedModel = null;
  /// 上一次套上的盔甲材质。undefined 表示还没套过（空串 = 明确不穿）
  var viewerArmor;

  function renderAppearance(data) {
    apData = data || apData;
    if (!apData) { return; }
    // Gson 默认不输出 null 字段，`pendingServerCape` 为 null 时整条就没了，
    // 读出来是 undefined，而下面各处判的是 `=== null`：结果「无披风」和「已装备」
    // 都不高亮，列表里一个 current 都没有。统一在这里补回 null。
    if (apData.pendingServerCape === undefined) { apData.pendingServerCape = null; }
    var kind = apData.kind || 'none';
    var readOnly = !!apData.readOnly;

    // 模型 / 背饰开关
    var model = (apData.state && apData.state.model) === 'slim' ? 'slim' : 'default';
    var segs = document.querySelectorAll('#model-seg button');
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle('active', segs[i].getAttribute('data-model') === model);
    }

    // 没有账号时「应用到账号」也没意义，一并禁用（否则点了只会得到一个空 promise）。
    // 没有未保存的修改时也禁用：这时候点它什么都不会发生，留着反而让人以为点了没反应。
    var cannotApply = readOnly || kind === 'none';
    var dirty = !!apData.dirty;
    var applyBtn = document.getElementById('ap-apply');
    applyBtn.disabled = cannotApply || !dirty;
    applyBtn.classList.toggle('primary', dirty && !cannotApply);
    applyBtn.classList.toggle('ghost', !dirty);
    document.getElementById('ap-import').disabled = readOnly;

    var hint = document.getElementById('ap-hint');
    if (kind === 'none') {
      hint.textContent = tr('先在账号页登录一个账号。');
    } else if (kind === 'authlib') {
      hint.textContent = tr('外置认证账号的外观由平台管理，这里只做预览，请前往对应平台修改。');
    } else {
      hint.textContent = '';
    }

    renderAssetGrid();
    syncViewer();
  }

  function assetCard(opts) {
    var card = el('div', 'asset-card' + (opts.current ? ' current' : ''));

    // 缩略图槽：固定高度，图片按原比例等比放进去（皮肤 16:32，披风 10:16）
    var well = el('div', 'asset-well');
    if (opts.emptyFrame) {
      well.appendChild(el('div', 'asset-empty-frame'));
    } else if (opts.glyph) {
      var glyph = el('div', 'asset-glyph');
      glyph.innerHTML = opts.glyph;
      well.appendChild(glyph);
    } else {
      var img = document.createElement('img');
      if (opts.preview) { img.src = opts.preview; }
      else { img.className = 'asset-placeholder'; }
      well.appendChild(img);
    }
    if (opts.badges && opts.badges.length) {
      var badges = el('div', 'asset-badges');
      opts.badges.forEach(function (b) { badges.appendChild(el('span', 'tag', b)); });
      well.appendChild(badges);
    }
    card.appendChild(well);

    // 底部一行：单选圆点 + 名称，和官方账号管理页的披风列表同一个信息结构
    var foot = el('div', 'asset-foot');
    foot.appendChild(el('span', 'asset-radio'));
    foot.appendChild(el('span', 'asset-name', opts.name || '未命名'));
    card.appendChild(foot);

    if (opts.id) { card.setAttribute('data-asset-id', opts.id); }
    // 记住这张卡自带的模型，切换选中态时要按它回填角标
    card.setAttribute('data-asset-model', opts.model || 'default');

    card.addEventListener('click', function (e) {
      e.stopPropagation();
      closeCtx();
      if (opts.onSelect) { opts.onSelect(); }
    });

    if (opts.onContext) {
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        showCtx(e.clientX, e.clientY, opts.onContext);
      });
    }
    return card;
  }

  /// 右键菜单的全局关闭：点空白、按 Esc、窗口失焦都收起来。
  /// 只绑一次，用 captured mousedown——它在 click 之前触发，
  /// 点菜单项时会被 closest('.ctx') 挡下来。
  var ctxDismissBound = false;
  function bindCtxDismiss() {
    if (ctxDismissBound) { return; }
    ctxDismissBound = true;
    document.addEventListener('mousedown', function (e) {
      if (!ctxMenu) { return; }
      if (e.target.closest('.ctx')) { return; }
      closeCtx();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (ctxMenu && e.key === 'Escape') { closeCtx(); }
    }, true);
    window.addEventListener('blur', closeCtx);
  }

  function showCtx(x, y, actions) {
    closeCtx();
    bindCtxDismiss();
    var menu = el('div', 'ctx');
    actions.forEach(function (action) {
      var btn = el('button', action.danger ? 'danger' : '', action.label);
      btn.addEventListener('click', function () {
        closeCtx();
        action.run();
      });
      menu.appendChild(btn);
    });
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);
    ctxMenu = menu;
  }

  /// 皮肤网格的结构签名。
  ///
  /// 只有「有哪些卡」变了才值得重建 DOM——选中态变化不算。
  /// 重建会把每张卡的 base64 预览图重新解码一遍，点一下别的皮肤整页闪一下
  /// 就是这么来的。
  var assetGridKey = '';

  function assetGridSignature() {
    if (!apData) { return ''; }
    var kind = apData.kind;
    var ids = [];
    if (apTab === 'skin') {
      if (kind === 'authlib' || kind === 'microsoft') { ids.push('__account__'); }
      (apData.skins || []).forEach(function (s) { ids.push(s.id + ':' + (s.name || '')); });
      return 'skin|' + kind + '|' + ids.join(',');
    }
    // 披风
    if (kind === 'microsoft') {
      ids.push('__none__');
      // 服务器披风是异步拉来的，列表到没到、有没有装备都影响卡片，一并进签名
      if (serverCapes === null) {
        ids.push('srv:pending');
      } else {
        ids.push('srv:' + serverCapes.map(function (c) {
          return c.id + (c.active ? '+' : '');
        }).join('.'));
      }
    } else if (kind === 'authlib') {
      ids.push('__account__');
    } else {
      ids.push('__none__');
      (apData.capes || []).forEach(function (c) { ids.push(c.id + ':' + (c.name || '')); });
    }
    return 'cape|' + kind + '|' + ids.join(',');
  }

  /// 只更新选中态和角标，不动 DOM 结构
  function syncAssetSelection() {
    var grid = document.getElementById('asset-grid');
    if (!grid || !apData) { return; }
    var state = apData.state || {};
    var kind = apData.kind;
    var cards = grid.querySelectorAll('.asset-card');

    // 披风这边的「当前」不是简单比 id：正版账号还要看 pending 和服务器下发的 active
    var pending = apData.pendingServerCape;
    var serverList = serverCapes || [];
    var serverHasActive = serverList.some(function (c) { return c.active; });
    var serverNoneSelected = pending === '' ? true : (pending === null && !serverHasActive);

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var id = card.getAttribute('data-asset-id');
      var isCurrent;

      if (apTab === 'skin') {
        var isAccount = id === '__account__';
        isCurrent = isAccount ? !state.skin : (state.skin === id);
      } else if (kind === 'microsoft') {
        if (id === '__none__') {
          isCurrent = serverNoneSelected;
        } else {
          var hit = null;
          for (var j = 0; j < serverList.length; j++) {
            if (serverList[j].id === id) { hit = serverList[j]; break; }
          }
          isCurrent = pending === null ? !!(hit && hit.active) : pending === id;
        }
      } else if (kind === 'authlib') {
        isCurrent = true;
      } else {
        isCurrent = id === '__none__' ? !state.cape : (state.cape === id);
      }

      card.classList.toggle('current', isCurrent);

      // 「账号当前皮肤 / 披风」的缩略图是异步到手的：卡片早就画好了，
      // 图晚几秒才来。以前这里只改选中态不改图，于是卡片一直挂着初次渲染时
      // 那张兜底皮肤（橙发绿衣），和右边 3D 里的真皮肤对不上。
      if (id === '__account__') {
        var accPreview = apTab === 'skin' ? apData.accountSkin : apData.accountCape;
        var accImg = card.querySelector('.asset-well img');
        if (accImg && accPreview && accImg.getAttribute('src') !== accPreview) {
          accImg.src = accPreview;
          accImg.classList.remove('asset-placeholder');
        }
      }

      // 皮肤卡角标跟「当前实际用的模型」走：选中那张显示 state.model，其余显示自带值
      if (apTab === 'skin' && id !== '__account__') {
        var badge = card.querySelector('.asset-badges .tag');
        if (badge) {
          var base = card.getAttribute('data-asset-model') || 'default';
          var shown = (isCurrent && state.model) ? state.model : base;
          badge.textContent = shown === 'slim' ? '纤体' : '宽体';
        }
      }
    }
  }

  /// 披风库卡片的右键菜单。刷新重拉的是「账号持有哪些披风」，
  /// 不是贴图 —— Mojang 发了新披风，本地不清 profile 缓存就看不到。
  var REFRESH_CAPE_ITEM = {
    label: '刷新账号披风',
    run: function () { call('refreshAccountCape'); }
  };

  /// 「导出纹理」菜单项。
  ///
  /// 两种来源分开走：本地资产有 id，后端直接复制原始文件（不重编码）；
  /// 正版账号的服务器皮肤/披风本地没有文件，只有页面上那张 dataUrl 缩略图，
  /// 交给后端落临时文件再导出。id 以 `__` 开头的是界面上的虚拟卡片。
  function exportItem(kind, id, preview, serverCape) {
    return {
      label: '导出纹理',
      run: function () {
        // 正版账号的服务器披风：本地只有缩略图，得让后端按 id 去拿原图
        if (serverCape) {
          call('exportServerCape', id);
          return;
        }
        if (id && id.indexOf('__') !== 0) {
          call('exportTexture', kind, id);
          return;
        }
        if (!preview) {
          toast('这张图还没加载出来，等缩略图显示后再试', 'error');
          return;
        }
        call('exportTextureData', preview, kind === 'cape' ? 'cape' : 'skin');
      }
    };
  }

  /// 把导出项放到菜单最前面。原来的菜单项照旧跟在后面。
  ///
  /// 不传 `items` 时返回只有导出项的菜单 —— 内置皮肤（Steve / Alex）
  /// 和只读账号的卡片就是这样：不能改名不能删，但纹理本身仍然导得出来。
  function withExport(kind, id, preview, items, serverCape) {
    var list = (items || []).slice();
    list.unshift(exportItem(kind, id, preview, serverCape));
    return list;
  }

  function renderAssetGrid() {
    var grid = document.getElementById('asset-grid');
    if (!apData) {
      grid.innerHTML = '';
      assetGridKey = '';
      return;
    }

    var sig = assetGridSignature();
    if (sig && sig === assetGridKey) {
      // 卡片没变，只改选中态——不重建，不闪
      syncAssetSelection();
      return;
    }
    // 只有第一次画这个网格才播入场动画。每次重建都重放的话，
    // 在披风列表里点一下会看到整排卡片依次淡入，比「刷新」还晃眼。
    var firstPaint = !assetGridKey;
    assetGridKey = sig;
    grid.innerHTML = '';

    // 资产区标题：给出「现在在看什么、有多少」，避免一堆卡片悬空在页面上
    var headLabel = document.getElementById('asset-head-label');
    var headCount = document.getElementById('asset-head-count');
    if (headLabel) {
      headLabel.textContent = apTab === 'skin' ? '皮肤库' : '披风';
    }
    if (headCount) {
      // 数「实际显示出来的卡片」而不是后端给的资产数：
      // 正版账号的披风来自服务器列表，本地 capes 是空的，照旧的算法会写成「披风 2 项」
      var n;
      if (apTab === 'skin') {
        n = (apData.skins || []).length;
        if (apData.kind === 'authlib' || apData.kind === 'microsoft') { n += 1; }
      } else if (apData.kind === 'microsoft') {
        n = (serverCapes || []).length + 1;   // 「无披风」也算一张
      } else {
        n = (apData.capes || []).length + 1;
      }
      headCount.textContent = n > 0 ? n + tr(' 项') : '';
    }

    var kind = apData.kind;
    var readOnly = !!apData.readOnly;
    var state = apData.state || {};

    if (apTab === 'skin') {
      var skins = apData.skins || [];
      if (kind === 'authlib' || kind === 'microsoft') {
        grid.appendChild(assetCard({
          id: '__account__',
          name: '账号当前皮肤',
          preview: apData.accountSkin,
          badges: ['服务器'],
          current: !state.skin,
          onSelect: function () { call('selectSkin', ''); },
          // 服务器皮肤 24 小时才自动同步一次（省两次网络往返），官网换了皮肤
          // 想立刻看到就走这里。外置认证的皮肤由平台管，没有刷新这回事。
          onContext: withExport('skin', '__account__', apData.accountSkinRaw,
            kind === 'microsoft'
              ? [{ label: '刷新服务器皮肤', run: function () { call('refreshAccountSkin'); } }]
              : [])
        }));
      }
      skins.forEach(function (s) {
        // 角标要跟「当前实际用的模型」一致：选中的那张卡显示 state.model
        // （用户手动切的宽体/纤体），没选中的卡才显示它自带的推荐值。
        // 之前一律读 s.model，切了纤体角标还是「宽体」，跟上面开关和 3D 都对不上。
        var isCurrent = state.skin === s.id;
        var shownModel = (isCurrent && state.model) ? state.model : s.model;
        grid.appendChild(assetCard({
          id: s.id,
          model: s.model,
          name: s.name,
          preview: s.preview,
          badges: [shownModel === 'slim' ? '纤体' : '宽体'].concat(s.builtin ? ['内置'] : []),
          current: isCurrent,
          onSelect: function () { call('selectSkin', s.id); },
          // 内置皮肤（原版 Steve / Alex）不给重命名和删除入口，但纹理本身导得出来
          onContext: withExport('skin', s.id, s.preview, s.builtin || readOnly ? [] : [
            { label: '重命名', run: function () {
                askName('重命名皮肤', s.name).then(function (name) {
                  if (name) { call('renameSkin', s.id, name); }
                });
              } },
            { label: '删除', danger: true, run: function () { call('removeSkin', s.id); } }
          ])
        }));
      });
      if (!skins.length && kind === 'offline') {
        grid.appendChild(el('div', 'empty', '还没有导入皮肤，点右上角「导入文件」。'));
      }
      document.getElementById('ap-tip').textContent = '';
    } else {
      var pending = apData.pendingServerCape;
      var capes = apData.capes || [];

      // 「不戴披风」不是「还没选」——它是一等选项，永远排在第一位

      if (kind === 'microsoft') {
        var list = serverCapes || [];
        var hasActive = list.some(function (c) { return c.active; });
        var noneSelected = pending === ''
          ? true
          : (pending === null && !hasActive);

        grid.appendChild(assetCard({
          id: '__none__',
          name: '无披风',
          emptyFrame: true,
          current: noneSelected,
          onSelect: function () { call('selectServerCape', ''); },
          // 空格子也给个刷新入口：新披风到手时用户不一定已经有「已装备」那件
          onContext: [REFRESH_CAPE_ITEM]
        }));

        if (!serverCapes) {
          var capeLoad = el('div', 'empty');
          capeLoad.appendChild(loadingRow('正在从 Mojang 拉取披风列表…'));
          grid.appendChild(capeLoad);
          call('requestServerCapes');
        } else if (!list.length) {
          grid.appendChild(el('div', 'empty', '这个账号没有可用披风。'));
        } else {
          list.forEach(function (c) {
            var current = pending === null ? !!c.active : pending === c.id;
            grid.appendChild(assetCard({
              id: c.id,
              name: c.name,
              preview: c.preview || null,
              badges: c.active ? ['已装备'] : [],
              current: current,
              onSelect: function () { call('selectServerCape', c.id); },
              onContext: withExport('cape', c.id, c.preview, [REFRESH_CAPE_ITEM], true)
            }));
          });
        }
        document.getElementById('ap-tip').textContent = '';
      } else if (kind === 'authlib') {
        grid.appendChild(assetCard({
          id: '__account__',
          name: '账号当前披风',
          preview: apData.accountCape,
          badges: ['服务器'],
          current: true,
          onContext: withExport('cape', '__account__', apData.accountCapeRaw, [])
        }));
        document.getElementById('ap-tip').textContent =
          '外置认证账号的披风由平台管理，这里只做预览。';
      } else {
        grid.appendChild(assetCard({
          id: '__none__',
          name: '无披风',
          emptyFrame: true,
          current: !state.cape,
          onSelect: function () { call('selectCape', ''); }
        }));

        capes.forEach(function (c) {
          grid.appendChild(assetCard({
            id: c.id,
            name: c.name,
            preview: c.preview,
            current: state.cape === c.id,
            onSelect: function () { call('selectCape', c.id); },
            onContext: withExport('cape', c.id, c.preview, readOnly ? [] : [
              { label: '重命名', run: function () {
                  askName('重命名披风', c.name).then(function (name) {
                    if (name) { call('renameCape', c.id, name); }
                  });
                } },
              { label: '删除', danger: true, run: function () { call('removeCape', c.id); } }
            ])
          }));
        });

        if (!capes.length) {
          grid.appendChild(el('div', 'empty', '还没有导入披风，点右上角「导入文件」。'));
        }
        // 这句说明用户明确要求删掉：占位框上已经写着「还没有导入披风」，
        // 再补一段长解释属于重复
        document.getElementById('ap-tip').textContent = '';
      }
    }
    if (firstPaint) { stagger(grid); }
  }

  /// 复位预览机位。
  ///
  /// 两条渲染路径分开处理：3D 模式（skinview3d）直接调它的 resetCamera；
  /// PNG 模式（JavaFX 出的图）把后端「用户转过视角」的标记清掉，
  /// refreshPreview 会重新按当前标签页算默认角度 —— 皮肤看正面、披风看背面。
  /// 复位预览机位。
  ///
  /// 拖拽转的是 OrbitControls 的相机，`controls.reset()` 就是干这个的 ——
  /// three.js 在构造时存了一份初始机位（position0 / target0），reset 会还原。
  /// 别指望 `viewer.resetCamera()`：这个 bundle 里没有那个方法，写了也是空转。
  ///
  /// 另一半是给 JavaFX 模式的：把后端「用户转过视角」的标记清掉，
  /// refreshPreview 会重新按标签页算默认角度（皮肤正面、披风背面 3/4）。
  /// 复位预览机位。
  ///
  /// 拖拽转的是 OrbitControls 的相机，`controls.reset()` 就是干这个的 ——
  /// three.js 在构造时存了一份初始机位（position0 / target0），reset 会还原。
  /// 别指望 `viewer.resetCamera()`：这个 bundle 里没有那个方法，写了也是空转。
  ///
  /// 另一半是给 JavaFX 模式的：把后端「用户转过视角」的标记清掉，
  /// refreshPreview 会重新按标签页算默认角度（皮肤正面、披风背面 3/4）。
  function resetPreviewView() {
    try {
      if (viewer) {
        var home = viewerHomeByTab[apTab];
        if (home) {
          // 这一页拖过：回到那之前的机位（皮肤页是正面，披风页是背面 3/4）
          viewer.camera.position.copy(home.pos);
          if (viewer.controls && viewer.controls.target) {
            viewer.controls.target.copy(home.target);
            viewer.controls.update();
          }
        } else {
          // 这一页还没拖过，但可能缩放过、上下拖过：把水平角摆回该有的方向，
          // 再让 frameViewer 重新算一遍距离
          var yaw = (apTab === 'cape' && viewerCapeSrc) ? Math.PI * 0.85 : 0;
          tabYaw[apTab] = yaw;
          setViewerYaw(yaw);
          frameViewer();
        }
        if (viewer.render) { viewer.render(); }
      }
    } catch (e) { /* 3D 没起来就交给后端那条路 */ }
    call('resetPreviewCamera');
  }

  function initPreviewDrag() {
    var img = document.getElementById('ap-preview');
    if (!img) { return; }

    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    var pending = 0;

    img.addEventListener('mousedown', function (e) {
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) { return; }
      var dx = e.screenX - lastX;
      lastX = e.screenX;
      lastY = e.screenY;
      pending += dx;
      if (Math.abs(pending) < 2) { return; }
      call('rotatePreview', pending, 0);
      pending = 0;
    });

    window.addEventListener('mouseup', function () { dragging = false; });
  }

  function sendPreviewRect() {
    var slot = document.getElementById('preview-slot');
    if (!slot) { return; }
    var r = slot.getBoundingClientRect();

    // 预览区滚出可视范围时先藏起来，否则画布会浮在别的内容上面
    var visible = r.bottom > 0 && r.top < window.innerHeight && r.width > 1;
    call('setPreviewRect', visible ? r.left : 0, visible ? r.top : 0,
        visible ? r.width : 0, visible ? r.height : 0);
  }

  var previewRectTimer = null;

  function schedulePreviewRect() {
    if (previewRectTimer) { return; }
    previewRectTimer = setTimeout(function () {
      previewRectTimer = null;
      if (document.getElementById('page-appearance').classList.contains('active')) {
        sendPreviewRect();
      }
    }, 40);
  }

  function showAppearance() {
    var raw = call('appearance');
    if (raw) {
      try { renderAppearance(JSON.parse(raw)); } catch (e) { console.error(e); }
    }
    sendPreviewRect();
  }

  function initAppearance() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        var all = document.querySelectorAll('.tab');
        for (var j = 0; j < all.length; j++) { all[j].classList.remove('active'); }
        this.classList.add('active');
        apTab = this.getAttribute('data-tab');
        call('setAppearanceTab', apTab);
        if (apTab === 'cape' && apData && apData.kind === 'microsoft') { call('requestServerCapes'); }
        renderAssetGrid();
        // 壳模式下 3D 在前端，切完标签得自己同步一次视角和贴图
        syncViewer();
      });
    }

    // 「应用到账号」：这个按钮以前压根没绑事件，点了完全没反应。
    // 真正的落盘/上传在 Java 侧 applyAppearance（离线=存本地，正版=上传，外置=提示去平台）
    var applyBtn = document.getElementById('ap-apply');
    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        if (this.disabled) { return; }
        call('applyAppearance');
      });
    }

    // 复位机位：平时几乎看不见，鼠标放上去才亮起来
    var resetView = document.getElementById('ap-reset-view');
    if (resetView) {
      resetView.addEventListener('click', function () { resetPreviewView(); });
    }

    var modelBtns = document.querySelectorAll('#model-seg button');
    for (var m = 0; m < modelBtns.length; m++) {
      modelBtns[m].addEventListener('click', function () {
        call('setSkinModel', this.getAttribute('data-model'));
      });
    }

    // 披风 / 鞘翅：只换模型，贴图用的还是同一张披风
    var backSeg = document.getElementById('back-seg');
    if (backSeg) {
      backSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-back]') : null;
        if (!btn) { return; }
        backEquipment = btn.getAttribute('data-back');
        applyBackEquipment(viewer, true);
        renderBackSeg(true, !!(viewer && viewer.capeCanvas) && capeHasElytraArt(viewer));
        // 图还没读完的话，读完再套一次（第一次进外观页就切鞘翅时会碰到）
        if (!elytraImage) {
          ensureArmorImages().then(function () { applyBackEquipment(viewer, true); });
        }
      });
    }

    // 盔甲：格子和弹窗。纯前端的事，不落后端配置，也不记上次的选择 ——
    // 只是看效果用的，每次进来都是干净的一身。
    initArmorCells();

    // 盔甲总开关：和模型 / 动作 / 披风同一套 seg，关着的时候格子收起来、身上也不挂甲
    var armorSeg = document.getElementById('armor-seg');
    if (armorSeg) {
      armorSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-armor]') : null;
        if (!btn) { return; }
        armorOn = btn.getAttribute('data-armor') === 'on';
        renderArmorSeg();
        var row = document.getElementById('ap-armor-row');
        if (row) { row.hidden = !armorOn; }
        applyArmor(viewer);
        // 手动改完把签名同步掉，避免 syncViewer 里再重画一次（会闪）
        viewerArmorSig = armorSignature();
      });
    }

    // 动作：站立 / 行走。和皮肤站那套一致，直接换 viewer.animation。
    var animSeg = document.getElementById('anim-seg');
    if (animSeg) {
      animSeg.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-anim]') : null;
        if (!btn) { return; }
        skinAnim = btn.getAttribute('data-anim') === 'walk' ? 'walk' : 'idle';
        applyAnimation(viewer);
        renderAnimSeg();
      });
    }

    // 导入文件。走页面自己的 <input type="file">，不调 Java 侧的 FileChooser——
    // 壳模式没有 JavaFX 窗口，那个对话框根本弹不出来，点了会毫无反应。
    // 读成 dataUrl 交给 Java，两边模式（WebView / WebView2）都能用。
    document.getElementById('ap-import').addEventListener('click', function () {
      if (this.disabled) { return; }
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg';
      input.style.display = 'none';
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) { return; }
        var reader = new FileReader();
        reader.onload = function () {
          call(apTab === 'cape' ? 'importCapeData' : 'importSkinData',
               String(reader.result), file.name);
        };
        reader.onerror = function () { toast('读取文件失败', 'error'); };
        reader.readAsDataURL(file);
        document.body.removeChild(input);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

