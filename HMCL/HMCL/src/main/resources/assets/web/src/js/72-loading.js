  // ---------------- 液滴加载动画（LiquidLoader · 直线版） ----------------
  //
  // 移植自 https://github.com/yoavlt/LiquidLoader（MIT，本地也有一份：
  // E:\项目（乐色）\UI Coding\LiquidLoader）。
  // 原库有两套：环形（LiquidCircleEffect）和直线（LiquidLineEffect）。
  // 这里用**直线版**——按钮是 96×32 的胶囊，横排几个点比塞个圆环更像它；
  // 而且直线版里游走圆贴着每个点擦过去，液桥的融合过程看得更清楚。
  //
  // 原库的几何全在 LiquidLineEffect 里：
  //   circleRadius = width * 0.05
  //   circleInter  = (width - 2*r*N) / (N+1)
  //   第 i 个点圆心 x = circleInter + r + i*(circleInter + 2r)
  //   游走圆 x = 最后一个点的右边缘 + inter，再乘 sin(key*π)*0.5+0.5（两端缓一下）
  //   resize(): normalized = 1 - 距离/(r + inter)，就近放大到 1.1 倍
  //   液桥路径见 SimpleCircleLiquidEngine.normalPath / splitPath
  // 另外它那个「发光」才是视觉重点：游走圆用更亮的颜色 + 光晕，
  // 所以这里加了 shadowBlur 和一层径向渐变。

  var LIQ_DOTS = 3;
  var LIQ_DURATION = 1.5;       // key 走完 0→2 的秒数（一次来回）
  var LIQ_RADIUS_RATIO = 0.05;  // 同 LiquidLineEffect
  var LIQ_MOVE_SCALE = 0.8;     // 游走圆半径倍数
  var LIQ_THRESH = 1.0;         // radiusThresh = 圆半径 × 1.0
  var LIQ_ANGLE_THRESH = 0.2;   // 同 LiquidLineEffect
  var LIQ_CONNECT_THRESH = 0.3;
  var LIQ_SCALE_MAX = 1.1;

  function liqPoint(c, rad, dist) {
    return { x: c.x + Math.cos(rad) * dist, y: c.y + Math.sin(rad) * dist };
  }
  function liqDist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function liqMid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function liqSplit(from, to, t) {
    return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
  }
  /// 两条直线求交（对应 CGPoint.intersection(p1, to: p3, from2: p2, to2: p4)）
  function liqIntersect(a1, a2, b1, b2) {
    var d = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
    if (Math.abs(d) < 1e-9) { return null; }
    var t = ((b1.x - a1.x) * (b2.y - b1.y) - (b1.y - a1.y) * (b2.x - b1.x)) / d;
    return { x: a1.x + (a2.x - a1.x) * t, y: a1.y + (a2.y - a1.y) * t };
  }
  function liqRatio(a, ra, b, rb, thresh) {
    var ratio = 1 - (liqDist(a, b) - thresh) / (ra + rb + thresh);
    return Math.min(1, Math.max(0, ratio));
  }
  function liqConnectedPoints(c, rc, o, angle) {
    var rad = Math.atan2(o.y - c.y, o.x - c.x);
    return [liqPoint(c, rad + angle, rc), liqPoint(c, rad - angle, rc)];
  }

  /// 画两个圆之间的液桥。返回 false 表示还没近到要连。
  function liqBridge(ctx, c, rc, o, ro, thresh) {
    if (liqDist(c, o) - rc - ro >= thresh) { return false; }
    var ratio = liqRatio(c, rc, o, ro, thresh);

    if (ratio >= LIQ_ANGLE_THRESH) {
      var angle = Math.PI / 2 * ((ratio + LIQ_CONNECT_THRESH) / (1 + LIQ_CONNECT_THRESH));
      var ab = liqConnectedPoints(c, rc, o, angle);
      var cd = liqConnectedPoints(o, ro, c, angle);
      var cross = liqIntersect(ab[0], cd[0], ab[1], cd[1]);
      if (!cross) { return false; }
      var k = ratio * 1.25 - 0.25;
      var m1 = liqSplit(liqMid(ab[0], cd[1]), cross, k);
      var m2 = liqSplit(liqMid(ab[1], cd[0]), cross, k);
      ctx.beginPath();
      ctx.moveTo(ab[0].x, ab[0].y);
      ctx.quadraticCurveTo(m1.x, m1.y, cd[1].x, cd[1].y);
      ctx.lineTo(cd[0].x, cd[0].y);
      ctx.quadraticCurveTo(m2.x, m2.y, ab[1].x, ab[1].y);
      ctx.closePath();
      ctx.fill();
      return true;
    }

    // ratio 很小时两圆几乎分离，原库只留两条细弧（splitPath）
    var e = Math.PI * 40 / 180;
    var p12 = liqConnectedPoints(c, rc, o, e);
    var p34 = liqConnectedPoints(o, ro, c, e);
    var cross2 = liqIntersect(p12[0], p34[0], p12[1], p34[1]);
    if (!cross2) { return false; }
    var d1 = liqConnectedPoints(c, rc, o, 0)[0];
    var d2 = liqConnectedPoints(o, ro, c, 0)[0];
    var t = (ratio - LIQ_CONNECT_THRESH) / (LIQ_ANGLE_THRESH - LIQ_CONNECT_THRESH);
    var a1 = liqSplit(d1, liqMid(cross2, d2), 1 - t);
    var a2 = liqSplit(d2, liqMid(cross2, d1), 1 - t);
    ctx.beginPath();
    ctx.moveTo(p12[0].x, p12[0].y);
    ctx.quadraticCurveTo(a1.x, a1.y, p12[1].x, p12[1].y);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(p34[0].x, p34[0].y);
    ctx.quadraticCurveTo(a2.x, a2.y, p34[1].x, p34[1].y);
    ctx.fill();
    return true;
  }

  function LiquidLine(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.key = 0;
    this.raf = 0;
    this.last = 0;
    this.size = 0;
    this.dpr = 0;
    this.dots = [];
    this.measure();
  }

  LiquidLine.prototype.measure = function () {
    var rect = this.canvas.getBoundingClientRect();
    var w = Math.max(24, Math.round(rect.width || 36));
    var h = Math.max(12, Math.round(rect.height || 22));
    var dpr = window.devicePixelRatio || 1;
    if (this.size === w + 'x' + h && this.dpr === dpr) { return; }
    this.size = w + 'x' + h;
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var r = w * LIQ_RADIUS_RATIO;
    var n = LIQ_DOTS;
    var inter = (w - 2 * r * n) / (n + 1);
    this.r = r;
    this.inter = inter;
    // 游走圆在最后一个点右边 inter 处折返
    this.travelMax = (inter + r + (n - 1) * (inter + 2 * r)) + r + inter;
    this.midY = h / 2;
    this.dots = [];
    for (var i = 0; i < n; i++) {
      this.dots.push({ x: inter + r + i * (inter + 2 * r), y: this.midY });
    }
  };

  /// sin(key·π)·0.5+0.5：往返时两端会慢下来，不是匀速直冲
  function liqSine(key) {
    return Math.sin(key * Math.PI) * 0.5 + 0.5;
  }

  LiquidLine.prototype.draw = function () {
    var ctx = this.ctx;
    var w = this.w;
    var h = this.h;
    var r = this.r;
    var thresh = r * LIQ_THRESH;
    var moveR = r * LIQ_MOVE_SCALE;

    ctx.clearRect(0, 0, w, h);

    var move = { x: this.travelMax * liqSine(this.key), y: this.midY };

    // resize()：离游走圆越近放大越多
    var radii = [];
    var i, d, norm, rr;
    for (i = 0; i < this.dots.length; i++) {
      d = liqDist(this.dots[i], move);
      norm = 1 - d / (r + this.inter);
      rr = r;
      if (norm > 0) { rr = r + (r * LIQ_SCALE_MAX - r) * norm; }
      radii.push(rr);
    }

    // 普通点：白色但压一点透明度，衬得游走圆更亮
    ctx.fillStyle = 'rgba(255,255,255,0.74)';
    // 先画桥（和点同色），再画点，边缘才干净
    for (i = 0; i < this.dots.length; i++) {
      liqBridge(ctx, move, moveR, this.dots[i], radii[i], thresh);
    }
    for (i = 0; i < this.dots.length; i++) {
      ctx.beginPath();
      ctx.arc(this.dots[i].x, this.dots[i].y, radii[i], 0, Math.PI * 2);
      ctx.fill();
    }

    // 游走圆：高亮 + 光晕。原库用一个更亮的 growColor 加阴影，这里等价
    ctx.save();
    var glow = ctx.createRadialGradient(move.x, move.y, moveR * 0.5, move.x, move.y, moveR * 2.5);
    glow.addColorStop(0, 'rgba(255,255,255,0.5)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(move.x, move.y, moveR * 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(move.x, move.y, moveR, 0, Math.PI * 2);
    ctx.fill();

    // 游走圆和相邻点之间的那截桥要重新按高亮色画一遍，
    // 否则它留在上面那层的半透明配色里，看起来是断的
    ctx.fillStyle = '#fff';
    for (i = 0; i < this.dots.length; i++) {
      if (liqDist(move, this.dots[i]) - moveR - radii[i] < thresh * 0.9) {
        liqBridge(ctx, move, moveR, this.dots[i], radii[i], thresh);
      }
    }
  };

  LiquidLine.prototype.start = function () {
    if (this.raf) { return; }
    this.measure();
    this.last = 0;
    var self = this;
    var step = function (ts) {
      if (!self.last) { self.last = ts; }
      var dt = Math.min(0.1, (ts - self.last) / 1000);
      self.last = ts;
      self.key += dt * 2 / LIQ_DURATION;
      if (self.key > 2) { self.key -= 2; }
      self.draw();
      self.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  };

  LiquidLine.prototype.stop = function () {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.key = 0;
    if (this.ctx && this.w) {
      this.ctx.clearRect(0, 0, this.w, this.h);
    }
  };

  var liquidLine = null;

  function startLiquidLine() {
    // 进度每秒推好几次，这里必须早退，否则每帧都去量尺寸
    if (liquidLine && liquidLine.raf) { return; }
    var canvas = document.getElementById('tb-ring');
    if (!canvas) { return; }
    if (!liquidLine) { liquidLine = new LiquidLine(canvas); }
    liquidLine.start();
  }

  function stopLiquidLine() {
    if (liquidLine) { liquidLine.stop(); }
  }

  function updateDownloadButton() {
    var btn = document.getElementById('btn-refresh');
    var fill = document.getElementById('tb-progress-fill');
    var text = document.getElementById('tb-progress-text');
    if (!btn || !fill || !text) { return; }

    // 失败的任务会留在列表里让用户看原因，但它不算「在下载」——
    // 否则按钮会一直转圈，看着像还在跑
    var ids = Object.keys(dlTasks).filter(function (id) {
      return !dlTasks[id].error;
    });
    if (!ids.length) {
      btn.classList.remove('busy', 'indeterminate');
      fill.style.width = '0%';
      text.textContent = tr('下载');
      btn.title = tr('下载任务');
      stopLiquidLine();
      return;
    }

    // 挑进度最高的；都没量化进度就随便挑一个，走不确定动画
    var best = null;
    for (var i = 0; i < ids.length; i++) {
      var t = dlTasks[ids[i]];
      if (t.percent < 0) { continue; }
      if (!best || t.percent > best.percent) { best = t; }
    }

    btn.classList.add('busy');
    startLiquidLine();
    if (!best) {
      btn.classList.add('indeterminate');
      fill.style.width = '40%';
      text.textContent = tr('下载中');
      btn.title = (dlTasks[ids[0]].stage || '正在下载');
      return;
    }

    btn.classList.remove('indeterminate');
    var pct = Math.max(0, Math.min(100, Math.round(best.percent * 100)));
    fill.style.width = pct + '%';
    text.textContent = pct + '%';
    btn.title = best.stage || '正在下载';
  }

  /// 一行「三点 + 文字」的加载提示，给各处 empty 占位用。
  /// 纯文字太干，加个液滴在动的感觉就不像卡住了。
  /// 加载占位：一块在容器里**正中**的 gooey 动画 + 文案。
  ///
  /// 以前是 .loading-inline（inline-flex），塞进 grid / list 里就贴在左上角，
  /// 看着像角落里一个残留的提示。现在统一成一个块级居中块：
  /// grid 里跨所有列，普通容器里撑到 42vh 再居中，视觉上落在内容区中央。
  function loadingRow(text) {
    var box = el('div', 'loading-block');
    var dots = el('div', 'gooey');
    dots.appendChild(document.createElement('i'));
    dots.appendChild(document.createElement('i'));
    dots.appendChild(document.createElement('i'));
    box.appendChild(dots);
    box.appendChild(el('span', 'loading-text', text));
    return box;
  }

  /// 下载任务小窗。顶栏那个按钮点开就是它。
  ///
  /// 之前有两个毛病，一起改了：
  /// 1. 有任务时点不开列表——每来一次进度就整块 innerHTML 重建，
  ///    用户的点击刚好落在被替换掉的节点上就白点了。现在改成按 id 增量更新，
  ///    DOM 节点常驻，进度只改宽度和文字。
  /// 2. 打开时没有任何过渡，硬切出来。现在带一段弹出动画。
  var dlPopoverOpen = false;
  var dlPopoverRows = {};   // taskId -> {row, title, pct, fill, foot, bar}

  /// 一行下载任务。
  ///
  /// 版式是「标题 + 百分比」一行、进度条一行、状态文案一行：
  /// 百分比必须在**进度条右上角**（用户明确要求），所以它和标题同一行，
  /// 靠右对齐；进度条通栏，看上去百分比就压在条的右上角。
  function buildDownloadRow(id) {
    var node = el('div', 'dl-task');
    var head = el('div', 'dlt-head');
    var title = el('span', 'dlt-title', id);
    var pct = el('span', 'dlt-pct', '');
    head.appendChild(title);
    head.appendChild(pct);
    node.appendChild(head);

    var bar = el('div', 'dlt-bar');
    var fill = el('i', 'dlt-fill');
    bar.appendChild(fill);
    node.appendChild(bar);

    var foot = el('div', 'dlt-foot', '');
    node.appendChild(foot);

    return { row: node, title: title, pct: pct, fill: fill, foot: foot, bar: bar };
  }

  function renderDownloadPopover() {
    var list = document.getElementById('dl-popover-list');
    if (!list) { return; }

    var ids = Object.keys(dlTasks);

    if (!ids.length) {
      list.innerHTML = '';
      dlPopoverRows = {};
      list.appendChild(el('div', 'empty', '没有正在进行的下载任务'));
      return;
    }

    var placeholder = list.querySelector('.empty');
    if (placeholder) { placeholder.remove(); }

    ids.forEach(function (id) {
      var t = dlTasks[id];
      var row = dlPopoverRows[id];
      if (!row) {
        row = buildDownloadRow(id);
        list.appendChild(row.row);
        dlPopoverRows[id] = row;
      }

      // 标题优先用后端给的文件名（pushTitle），没有才退回任务 id
      row.title.textContent = t.title || id;
      row.title.title = t.title || id;

      if (t.error) {
        // 已经结束了，暂停/取消都没意义，只留「移除这条」。
        // 光设 hidden 不够：这些按钮是 flex 项，display 会被布局重新算出来
        if (row.cancel) { row.cancel.hidden = true; row.cancel.style.display = 'none'; }
        if (row.pause) { row.pause.hidden = true; row.pause.style.display = 'none'; }
        row.row.classList.add('failed');
        row.pct.textContent = '';
        row.pct.hidden = true;
        row.bar.hidden = true;
        row.foot.textContent = t.error;
        row.foot.classList.add('dlt-err');
        // 失败的任务不自动消失：用户得能看到到底为什么失败
        if (!row.close) {
          var close = el('button', 'dlt-close', '✕');
          close.title = tr('移除这条任务');
          close.addEventListener('click', function (e) {
            e.stopPropagation();
            delete dlTasks[id];
            renderDownloadPopover();
            updateDownloadButton();
          });
          row.row.querySelector('.dlt-head').appendChild(close);
          row.close = close;
        }
        return;
      }

      // Java 下载可以暂停：后端是自己写的断点下载，已下好的部分留在 .part 里，
      // 继续时带 Range 从断点接上。其它任务（版本 / 整合包）走 FileDownloadTask，
      // 写临时文件、取消即删，没有续传可言，所以不给暂停按钮。
      // 解压阶段没法暂停（已经下完了，剩下是本地解压），按钮收掉
      var canPause = t.kind === 'java' && (t.stage || '').indexOf('解压') !== 0;
      if (canPause && !row.pause) {
        var pauseBtn = el('button', 'dlt-close dlt-pause', '⏸');
        pauseBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var paused = dlTasks[id] && dlTasks[id].paused;
          if (paused) {
            call('resumeJavaDownload', id);
          } else {
            call('pauseJavaDownload', id);
          }
        });
        var head = row.row.querySelector('.dlt-head');
        head.insertBefore(pauseBtn, row.cancel || null);
        row.pause = pauseBtn;
      }
      if (row.pause) {
        row.pause.hidden = !canPause;
        row.pause.style.display = canPause ? '' : 'none';
        if (canPause) {
          row.pause.textContent = t.paused ? '▶' : '⏸';
          row.pause.title = t.paused ? '继续下载' : '暂停下载';
        }
      }

      // 运行中给一个 ✕：下载/安装中途不想要了可以直接停掉。
      // 后端 executor.cancel() 会把任务停掉并推一条 done=cancelled。
      if (!row.cancel) {
        var cancelBtn = el('button', 'dlt-close dlt-cancel', '✕');
        cancelBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          cancelBtn.disabled = true;
          cancelBtn.title = tr('正在取消…');
          call('cancelDownload', id);
        });
        row.row.querySelector('.dlt-head').appendChild(cancelBtn);
        row.cancel = cancelBtn;
      }
      row.cancel.hidden = false;
      row.cancel.style.display = '';
      if (!row.cancel.disabled) { row.cancel.title = tr('取消这个任务'); }

      var hasPct = t.percent >= 0;
      row.pct.hidden = false;
      row.bar.hidden = false;
      row.pct.textContent = hasPct ? Math.round(t.percent * 100) + '%' : '';
      row.bar.classList.toggle('indeterminate', !hasPct);
      row.fill.style.width = (hasPct ? Math.max(3, Math.round(t.percent * 100)) : 100) + '%';
      row.foot.textContent = t.stage || '';
      row.foot.classList.toggle('dlt-paused', !!t.paused);
    });

    // 已经结束的任务把行删掉
    Object.keys(dlPopoverRows).forEach(function (id) {
      if (dlTasks[id]) { return; }
      var row = dlPopoverRows[id];
      if (row && row.row.parentNode) { row.row.parentNode.removeChild(row.row); }
      delete dlPopoverRows[id];
    });
  }

  /// 开/关小窗。状态自己记，不靠读 class——读 class 在连点时会和 CSS 打架。
  function setDownloadPopover(open) {
    var pop = document.getElementById('dl-popover');
    if (!pop) { return; }
    dlPopoverOpen = !!open;
    if (dlPopoverOpen) {
      renderDownloadPopover();
      pop.classList.remove('hidden');
      // 重启动画：先摘 class、强制回流、再挂上
      pop.classList.remove('pop-in');
      void pop.offsetWidth;
      pop.classList.add('pop-in');
    } else {
      pop.classList.add('hidden');
    }
  }

  function toggleDownloadPopover(force) {
    setDownloadPopover(force === undefined ? !dlPopoverOpen : !!force);
  }

  /// 后台把外观页的数据先拉一遍。
  ///
  /// 外观页是整个启动器里最重的一页：要拉皮肤库、每张皮肤的原图（base64），
  /// 还要初始化 WebGL。用户点进去再开始拉，会先看到一段空白。
  /// 首页画完之后就偷偷发一次请求，数据先到 onAppearance 里躺着。
  function preloadAppearanceData() {
    setTimeout(function () {
      try { call('requestAppearance'); } catch (e) { /* 预取失败无所谓，进页面会再拉 */ }
    }, 1200);
  }

