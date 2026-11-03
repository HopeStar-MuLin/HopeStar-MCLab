  // ---------------- 外观页 ----------------

  var apData = null;
  var apTab = 'skin';
  var serverCapes = null;
  /// 上一次外观数据属于哪个账号。切账号时要靠它把 serverCapes 丢掉 ——
  /// 那份列表是「某个账号的披风」，不是全局的。
  var apAccountUuid = '';
  var ctxMenu = null;

  function closeCtx() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }

  // ---------------- 前端 3D 预览（壳模式） ----------------
  //
  // JavaFX WebView 下的预览是 Java 侧渲染成 PNG 推过来的静态图：拖一次视角要等
  // 一轮重绘，待机摆动靠 500ms 定时截图。换成 Tauri 壳后 WebView2 有 WebGL，
  // 直接在前端用 skinview3d 渲染，拖拽是即时的，后端也不用再空转。
  //
  // 只在壳模式启用（window.__HMCL_SHIM__ 存在）；JavaFX 那边继续走后端出图。

  var viewer = null;
  var viewerFailed = false;
  /// 各标签页「第一次拖拽之前」的机位。controls.reset() 不能用 —— 它还原的是
  /// OrbitControls 构造那一瞬间的位置，那时 skinview3d 还没把相机拉到合适距离，
  /// restore 出来会怼到脸上。所以自己记一份稳定的。
  ///
  /// 按标签页分开存：皮肤页的原位是正面、披风页是背面 3/4。只记一份的话，
  /// 在披风页点复位会转回正面，披风直接看不见了。
  var viewerHomeByTab = {};

  /// 用户在预览框上滚出来的缩放倍数。
  /// 100% 就是「整个人填满预览框」那个取景，滚轮最远放到 150%、最小收到 50%。
  /// 这里存的是相对 100% 的倍数，实际取景由 frameViewer 换算。
  var USER_ZOOM = 1;
  var ZOOM_MIN = 0.5;
  var ZOOM_MAX = 1.5;
  /// 100% 时人物占框高的比例。0.75 = 头顶留一指、脚底也留一指，
  /// 整个人完整落在框里，四周都有余量。50%/150% 档位是相对它的倍数。
  var BASE_FILL = 0.75;

  function wantsFrontend3d() {
    return !viewerFailed && !!window.skinview3d && !!window.__HMCL_SHIM__;
  }

  /// 画布该多大：**内容区**尺寸，不是 clientWidth/Height。
  ///
  /// clientWidth 含 padding。之前直接拿它当画布宽高，画布比内容区大一圈，
  /// `.preview-slot` 又是 overflow:hidden，结果下半身被裁掉、人物看着偏下。
  function previewSize() {
    var slot = document.getElementById('preview-slot');
    if (!slot) { return { w: 320, h: 400 }; }
    var cs = getComputedStyle(slot);
    var padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var w = Math.round(slot.clientWidth - padX);
    var h = Math.round(slot.clientHeight - padY);
    return { w: Math.max(160, w), h: Math.max(200, h) };
  }

  function ensureViewer() {
    if (viewer) { return viewer; }
    if (!wantsFrontend3d()) { return null; }

    var canvas = document.getElementById('ap-preview-3d');
    if (!canvas) { return null; }

    var size = previewSize();
    try {
      viewer = new window.skinview3d.SkinViewer({
        canvas: canvas,
        width: size.w,
        height: size.h
      });
    } catch (e) {
      // WebGL 不可用（远程桌面、显卡驱动异常）就退回后端的 PNG
      console.error('[3d] 初始化失败，回退到后端预览', e);
      viewerFailed = true;
      canvas.hidden = true;
      return null;
    }

    document.getElementById('ap-preview').hidden = true;
    canvas.hidden = false;
    // 留个调试口子：自动化测试要读相机/包围盒，不靠截图目测。
    // 只是个只读引用，不影响运行。
    window.__skinViewer = viewer;

    viewer.autoRotate = false;
    try { viewer.zoom = 0.9; } catch (ignored) {}
    if (viewer.controls) {
      viewer.controls.enableZoom = false;
      viewer.controls.enablePan = false;
      viewer.controls.enableRotate = true;
      // 别让视角转到脚底或头顶
      viewer.controls.minPolarAngle = Math.PI * 0.28;
      viewer.controls.maxPolarAngle = Math.PI * 0.72;
    }
    // 用户转过视角就记在这个标签名下，之后这个标签不再自动摆位
    if (viewer.controls && viewer.controls.addEventListener) {
      // 第一次按下鼠标那一刻把机位存下来当「原位」。OrbitControls 的 reset()
      // 不能用 —— 它还原的是构造那一瞬间的位置，那时相机还没拉到合适距离，
      // 恢复出来会怼到脸上（实测 7.7 而不是正常的 49.7）。
      viewer.controls.addEventListener('start', function () {
        if (!viewerHomeByTab[apTab]) {
          viewerHomeByTab[apTab] = {
            pos: viewer.camera.position.clone(),
            target: viewer.controls.target.clone()
          };
        }
      });
      viewer.controls.addEventListener('end', function () {
        var yaw = currentViewerYaw();
        if (yaw !== null) { tabYaw[apTab] = yaw; }
      });
    }
    // 轻微待机摆动，比完全静止自然
    try { viewer.animation = new window.skinview3d.IdleAnimation(); } catch (ignored) {}

    window.addEventListener('resize', resizeViewer);

    // 左栏宽度随窗口变（rail 展开/收起也会变），窗口 resize 事件抓不到这些变化
    if (window.ResizeObserver) {
      window.__slotObserver = new ResizeObserver(function () {
        resizeViewer();
        frameViewer();
      });
      window.__slotObserver.observe(document.getElementById('preview-slot'));
    }

    bindPreviewZoom();
    frameViewer();
    return viewer;
  }

  /// 3D 视角：皮肤页看正面，披风页转到背面。
  ///
  /// 后端也有一套同样的逻辑（previewYaw），但它是给 JavaFX 那边渲染 PNG 用的；
  /// 壳模式的 3D 是前端 skinview3d 画的，后端那张图直接丢掉，所以这里必须自己转——
  /// 不然在披风页选了一件，预览还是正面，用户根本看不到披在背后的是什么。
  /// 每个标签页各自记一份视角。切标签时不再把相机拽回默认值——
  /// 之前就是这样，用户转到侧面看一眼、切个标签再回来，角度全丢了，
  /// 看起来像「3D 预览被重置了」。两个标签本来就共用同一块 canvas 和同一个 viewer。
  var tabYaw = { skin: 0, cape: null };   // null = 这个标签还没定过视角

  function currentViewerYaw() {
    var v = viewer;
    if (!v || !v.camera || !v.controls) { return null; }
    var t = v.controls.target || { x: 0, y: 0, z: 0 };
    var dx = v.camera.position.x - t.x;
    var dz = v.camera.position.z - t.z;
    return Math.atan2(dx, dz);
  }

  function setViewerYaw(radians) {
    var v = viewer;
    if (!v || !v.camera) { return; }
    var controls = v.controls;
    var target = (controls && controls.target) ? controls.target : { x: 0, y: 0, z: 0 };
    var dx = v.camera.position.x - target.x;
    var dz = v.camera.position.z - target.z;
    var radius = Math.sqrt(dx * dx + dz * dz);
    if (!radius) { return; }
    v.camera.position.x = target.x + Math.sin(radians) * radius;
    v.camera.position.z = target.z + Math.cos(radians) * radius;
    v.camera.lookAt(target.x, target.y, target.z);
    if (controls && controls.update) { controls.update(); }
  }

  function resizeViewer() {
    if (!viewer) { return; }
    var size = previewSize();
    if (Math.abs(viewer.width - size.w) > 2 || Math.abs(viewer.height - size.h) > 2) {
      viewer.width = size.w;
      viewer.height = size.h;
    }
  }

  /// 把人物摆到视野正中，并按框高留白缩放。
  ///
  /// 两个坑：
  /// 1. skinview3d 的相机固定看向原点，而人物模型的**脚底**在原点——
  ///    直接渲染人整体偏上，4:5 的竖框里头顶被切掉。这里按几何包围盒
  ///    把人物中心挪到原点（重复调用是幂等的，位置累加量自然为 0）。
  /// 2. 默认 zoom 下身高占框高约 94%，几乎顶满。缩到 ~72%，
  ///    和右边那些皮肤卡片的小人视觉重量才对得上。
  function frameViewer() {
    var v = viewer;
    if (!v || !v.playerObject || !v.camera) { return; }
    // 页面切走时容器是 0×0，这时候取景算出来的是垃圾值，
    // 切回来又不会自动纠正，等于把缩放弄坏
    if (!v.width || !v.height) { return; }
    try {
      v.playerObject.updateWorldMatrix(true, true);

      var minY = Infinity, maxY = -Infinity;
      v.playerObject.traverse(function (o) {
        if (!o.isMesh || !o.geometry) { return; }
        // 耳朵（deadmau5 那种）会高出头顶 5 个单位、还伸出两侧，
        // 算进去人物就会被整体上推，看着不居中。取景只按身体算。
        // 盔甲同理：它比皮肤大一圈，算进去会让「穿甲」比「不穿」小一号，
        // 同一个角色切来切去尺寸会跳。
        if (/ear/i.test(o.name || '')) { return; }
        if (/^armor/i.test(o.name || '')) { return; }
        o.geometry.computeBoundingBox();
        var bb = o.geometry.boundingBox.clone();
        bb.applyMatrix4(o.matrixWorld);
        if (bb.min.y < minY) { minY = bb.min.y; }
        if (bb.max.y > maxY) { maxY = bb.max.y; }
      });
      if (!isFinite(minY) || !isFinite(maxY) || maxY <= minY) { return; }

      // 盔甲比皮肤大一圈（头盔顶 +1、靴底 -1）。取景不把盔甲算进包围盒
      // （否则穿脱时尺寸会跳），但这里补上那 1 格余量：
      // 不然穿甲时头盔顶贴边、靴子探出框外，看着像被裁了。
      minY -= 1;
      maxY += 1;

      // 几何中心落到原点。包围盒是带当前位移算出来的，所以这一步可以反复做
      var center = (minY + maxY) / 2;
      v.playerObject.position.y -= center;
      var bottom = minY - center;
      var top = maxY - center;

      // 目标占框高 = 基准 50% × 用户缩放。
      //
      // **不能**拿「实测占用 × 倍数」反复逼近：那等于假设 zoom 和占高成正比，
      // 而库里的相机距离是 d = A + K/zoom（带一个固定偏移），高倍时差得远，
      // 迭代会来回震荡——表现就是滚一下大一下，再点一下又变小。
      // 这里直接从物理关系解出来：
      //   占高比例 = H / (2·d·tan(fov/2))  ⇒  d = H / (2·tan(fov/2)·目标)
      // d 与 zoom 的 A/K 两个常数不硬编码，现场取两个点拟合，换库版本也不会错。
      var TARGET = BASE_FILL * USER_ZOOM;
      var height = top - bottom;
      var halfTan = Math.tan(v.camera.fov * Math.PI / 360);
      var dNeeded = height / (2 * halfTan * TARGET);

      var z1 = 1, z2 = 2;
      v.zoom = z1;
      var d1 = v.camera.position.length();
      v.zoom = z2;
      var d2 = v.camera.position.length();

      var solved = z1;
      if (d1 > 0 && d2 > 0 && Math.abs(d1 - d2) > 1e-6) {
        // d = A + K/zoom
        var K = (d1 - d2) / (1 / z1 - 1 / z2);
        var A = d1 - K / z1;
        var denom = dNeeded - A;
        solved = Math.abs(denom) < 1e-6 ? z1 : K / denom;
        if (!isFinite(solved) || solved <= 0) { solved = z1; }
      }
      v.zoom = Math.min(64, Math.max(0.05, solved));
    } catch (e) {
      console.warn('[3d] 取景失败', e);
    }
  }

  /// 预览框上的滚轮缩放。
  ///
  /// 不用 skinview3d 自带的 controls.zoom——那个是连续值，没法钉死 25%/300%，
  /// 也没法保证 100% 对应「占框高一半」。这里自己记倍数，取景统一由 frameViewer 算。
  function bindPreviewZoom() {
    var slot = document.getElementById('preview-slot');
    if (!slot || slot.dataset.zoomBound) { return; }
    slot.dataset.zoomBound = '1';

    slot.addEventListener('wheel', function (e) {
      if (!viewer) { return; }
      e.preventDefault();
      // 触控板一次事件可能带很大的 deltaY，按方向只走一档，手感更稳
      var step = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setUserZoom(USER_ZOOM * step);
    }, { passive: false });

    // 双击复位：滚歪了不用一点点滚回来
    slot.addEventListener('dblclick', function () {
      if (!viewer) { return; }
      setUserZoom(1);
    });
  }

  function setUserZoom(next) {
    var clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (Math.abs(clamped - USER_ZOOM) < 0.001) { return; }
    USER_ZOOM = clamped;
    frameViewer();
    showZoomBadge();
  }

  var zoomBadgeTimer = null;

  function showZoomBadge() {
    var badge = document.getElementById('preview-zoom');
    if (!badge) { return; }
    badge.textContent = Math.round(USER_ZOOM * 100) + '%';
    badge.hidden = false;
    badge.classList.add('on');
    clearTimeout(zoomBadgeTimer);
    zoomBadgeTimer = setTimeout(function () {
      badge.classList.remove('on');
      // 等淡出动画结束再真正藏起来
      setTimeout(function () { if (!badge.classList.contains('on')) { badge.hidden = true; } }, 220);
    }, 900);
  }

  function findAsset(list, id) {
    if (!list || !id) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

