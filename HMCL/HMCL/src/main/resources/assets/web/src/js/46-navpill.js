  // ---------------- 胶囊指示器 ----------------
  //
  // 导航/分段控件的选中态不再由按钮自己画底，而是一块 .nav-pill 滑过去。
  // 这是最「系统 UI」的一处细节：点哪一格，底色从上一格滑到这一格，
  // 视线不用重新定位，也不会有两帧「旧的高亮没了、新的还没亮」的空档。
  //
  // 为什么必须用 JS：想让滑块跟着选中项，CSS 只有 :has() 和锚点定位两条路，
  // JavaFX WebEngine 两个都没有（它连 ES module 都不支持）。所以老实算坐标。
  //
  // 为什么用 MutationObserver 而不是在每个切换函数里插一句：
  // 会改选中态的地方有七八处（settings 的滚动高亮、下载页切分类、实例页切 tab、
  // syncSeg 到处用、语言切换重建文案……），逐个插迟早漏一个，漏了就是滑块卡住。
  // 观察 class 变化是唯一不漏的挂法。

  var PILL_NAVS = '.dl-tabs, .settings-nav, .seg, .tabs';

  function pillOf(nav) {
    for (var i = 0; i < nav.children.length; i++) {
      if (nav.children[i].classList.contains('nav-pill')) { return nav.children[i]; }
    }
    return null;
  }

  /// 把滑块挪到当前选中项下面。
  ///
  /// 尺寸走 rect 而不是 offsetWidth：按钮可能被 flex 拉伸、被 transform 缩放过，
  /// offsetWidth 拿到的是布局尺寸，和眼睛看到的对不上。
  function syncPill(nav, instant) {
    var pill = pillOf(nav);
    if (!pill) { return; }
    // 选中态标记有几个名字（.on / .active）。滑块自己的显隐**不能**用这两个，
    // 否则 querySelector('.on') 第一个命中的是滑块自己，从此自指、再也动不了。
    var btn = nav.querySelector('.on, .active');
    var nr = nav.getBoundingClientRect();
    var br = btn ? btn.getBoundingClientRect() : null;

    // 页面不可见（display:none）时量出来是 0，收起滑块。
    // 但注意 snap 必须清掉——留着它等于把过渡永久关掉，切回来就是硬跳。
    if (!br || br.width < 1 || br.height < 1) {
      pill.classList.remove('shown', 'snap');
      return;
    }

    // left/top 是相对 nav 的 padding box，rect 差是相对 border box，补掉边框
    var x = br.left - nr.left - nav.clientLeft;
    var y = br.top - nr.top - nav.clientTop;

    if (instant) { pill.classList.add('snap'); }
    pill.style.width = br.width + 'px';
    pill.style.height = br.height + 'px';
    pill.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    pill.classList.add('shown');
    if (instant) {
      // 读一次布局，让浏览器把「无过渡的初始位置」吃进去，
      // 再把过渡还回去 —— 否则第一帧会从 (0,0) 滑过来
      void pill.offsetWidth;
      pill.classList.remove('snap');
    }
  }

  function schedulePill(nav) {
    if (nav.__pillRaf) { return; }
    nav.__pillRaf = requestAnimationFrame(function () {
      nav.__pillRaf = 0;
      syncPill(nav, false);
    });
  }

  function watchPill(nav) {
    if (nav.__pillWatched) { return; }
    nav.__pillWatched = true;

    if (!pillOf(nav)) {
      var pill = document.createElement('span');
      pill.className = 'nav-pill snap';
      nav.insertBefore(pill, nav.firstChild);
    }

    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        // 滑块自己也在改 class（.on / .snap），不排除就是死循环
        if (t && t.classList && t.classList.contains('nav-pill')) { continue; }
        schedulePill(nav);
        return;
      }
    });
    // hidden 也要看：分段控件是一组一组显隐的（盔甲四部位那种），
    // 显示出来的那一刻得重新量一次，否则滑块停在上一次的位置
    mo.observe(nav, {
      attributes: true,
      attributeFilter: ['class', 'hidden', 'style'],
      subtree: true
    });

    nav.classList.add('pill-on');
    syncPill(nav, true);
  }

  /// 窗口尺寸变了所有滑块都要重量：按钮是 flex 撑出来的，宽度全变了。
  function resizePills() {
    var navs = document.querySelectorAll(PILL_NAVS);
    for (var i = 0; i < navs.length; i++) { syncPill(navs[i], true); }
  }

  function initNavPills() {
    var navs = document.querySelectorAll(PILL_NAVS);
    for (var i = 0; i < navs.length; i++) { watchPill(navs[i]); }

    var t = 0;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(resizePills, 120);
    });
  }
