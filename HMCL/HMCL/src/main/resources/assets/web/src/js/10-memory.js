  // ---------------- 内存滑条 ----------------
  //
  // 刻度换算照 PCL-CE 的 GetRamFromTick（PageSetupLaunch.xaml.cs）：
  // 分段线性，0.3~1.5 每档 0.1，1.5~8 每档 0.5，8~16 每档 1，之后每档 2。
  // 一条滑条就能覆盖 0.3~48 GB，比让人手填 MB 数字好用得多——
  // 填数字既要知道自己有多少内存，又容易填成 2048 这种一看就知道是猜的值。

  var RAM_TICK_MAX = 49;

  /// 最近一次从后端读到的物理内存（MB）。
  /// 滑条拖动时要不停重画三段条，不能每动一下就问后端一次。
  var memInfo = { total: 0, used: 0, available: 0 };

  /// 档位 -> GB
  function ramFromTick(tick) {
    if (tick <= 0) { return 0; }
    if (tick <= 12) { return tick * 0.1 + 0.3; }
    if (tick <= 25) { return (tick - 12) * 0.5 + 1.5; }
    if (tick <= 33) { return (tick - 25) + 8; }
    return (tick - 33) * 2 + 16;
  }

  /// GB -> 档位。取最接近的一档，而不是向上取整：
  /// 用户原来的值可能是 6144MB（6GB），向上取整会变成 6.5，看起来像被改了。
  function tickFromRam(gb) {
    if (!(gb > 0)) { return 0; }
    var best = 1;
    var bestDiff = Infinity;
    for (var t = 1; t <= RAM_TICK_MAX; t++) {
      var diff = Math.abs(ramFromTick(t) - gb);
      if (diff < bestDiff) { bestDiff = diff; best = t; }
    }
    return best;
  }

  /// 滑条上界。不能让人把物理内存全分出去，按总量分段留余量（同 PCL）。
  function maxTickFor(totalMb) {
    var total = totalMb / 1024;
    if (!(total > 0)) { return RAM_TICK_MAX; }
    var tick;
    if (total <= 1.5) { tick = Math.floor((total - 0.3) / 0.1); }
    else if (total <= 8) { tick = Math.floor((total - 1.5) / 0.5) + 12; }
    else if (total <= 16) { tick = Math.floor((total - 8) / 1) + 25; }
    else { tick = Math.floor((total - 16) / 2) + 33; }
    return Math.max(1, Math.min(RAM_TICK_MAX, tick));
  }

  /// 最近一次读到的全局游戏设置。勾选「自动分配内存」时要重画面板，
  /// 但那时候手上没有新的后端数据，用这份缓存就够。
  var lastGlobalGame = null;

  function withGlobalMemory(fn) {
    if (lastGlobalGame) { fn(lastGlobalGame); }
  }

  function fmtGb(gb) {
    return (gb > 0 ? gb : 0).toFixed(1) + ' GB';
  }

  /// 画三段条：已用 / 游戏分配 / 空闲。
  ///
  /// 「游戏分配」这段特意画成半透明：分配超过当前可用内存时，实际能吃到的
  /// 只有可用那部分，超出的部分在条上不应该显示成「已经占住了」。
  function drawMemoryBar(prefix, gameMb, auto) {
    var segUsed = document.getElementById(prefix + 'mem-seg-used');
    var segGame = document.getElementById(prefix + 'mem-seg-game');
    var segFree = document.getElementById(prefix + 'mem-seg-free');
    if (!segUsed) { return; }

    var total = memInfo.total;
    if (!(total > 0)) {
      segUsed.style.width = '0%';
      segGame.style.width = '0%';
      segFree.style.width = '100%';
      setText(prefix + 'mem-used-text', '—');
      setText(prefix + 'mem-game-text', '—');
      setText(prefix + 'mem-free-text', '—');
      return;
    }

    var usedGb = memInfo.used / 1024;
    var availGb = memInfo.available / 1024;
    var gameGb = gameMb > 0 ? Math.min(gameMb / 1024, availGb) : 0;
    var totalGb = total / 1024;

    var usedPct = Math.max(0, Math.min(100, (usedGb / totalGb) * 100));
    var gamePct = auto ? 0 : Math.max(0, Math.min(100 - usedPct, (gameGb / totalGb) * 100));
    var freePct = Math.max(0, 100 - usedPct - gamePct);

    segUsed.style.width = usedPct + '%';
    segGame.style.width = gamePct + '%';
    segFree.style.width = freePct + '%';

    setText(prefix + 'mem-used-text', usedGb.toFixed(1) + ' / ' + totalGb.toFixed(1) + ' GB');
    setText(prefix + 'mem-game-text', auto ? '自动' : (gameGb.toFixed(1) + ' GB'));
    setText(prefix + 'mem-free-text', (totalGb - usedGb - gameGb > 0
      ? (totalGb - usedGb - gameGb).toFixed(1) : '0.0') + ' GB');

    // 分配超过 75% 物理内存就提醒一句：这时候系统本身已经没多少余量了
    var warn = document.getElementById(prefix + 'mem-warn');
    if (warn) {
      var tooMuch = !auto && gameGb / totalGb > 0.75;
      warn.hidden = !tooMuch;
      if (tooMuch) {
        warn.textContent = tr('分配了物理内存的 ') + Math.round((gameGb / totalGb) * 100)
          + tr('%，系统可能因为内存不足而卡顿，也可能启动失败。');
      }
    }
  }

  /// 把后端给的内存值和设置值铺到一组控件上。
  ///
  /// @param prefix 空串 = 全局设置，'inst-' = 实例设置
  function renderMemoryMeter(prefix, maxMb, minMb, info, auto) {
    if (info && info.total) {
      memInfo.total = info.total;
      memInfo.used = info.used || 0;
      memInfo.available = info.available || 0;
    }

    var maxRange = document.getElementById(prefix + 'mem-max-range');
    if (!maxRange) { return; }

    var tmax = maxTickFor(memInfo.total);
    maxRange.max = String(tmax);

    var maxTick = maxMb > 0 ? tickFromRam(maxMb / 1024) : Math.min(tmax, Math.round(tmax * 0.5));
    maxTick = Math.max(1, Math.min(tmax, maxTick));
    maxRange.value = String(maxTick);

    // 自动模式下锁住滑条：值由启动器按整合包和机器情况估算
    maxRange.disabled = !!auto;

    // 显示用「配置里的真实值」而不是刻度换算值：老配置可能是 8064MB 这种
    // 不落在刻度上的数，按刻度显示会变成 8.0 GB，与实际启动参数不符。
    setText(prefix + 'mem-max-value', auto ? '自动' : fmtGb(maxMb / 1024));

    drawMemoryBar(prefix, auto ? 0 : maxMb, auto);
  }

  /// 当前可见的页面 id（去掉 `page-` 前缀）
  function currentPageId() {
    var on = document.querySelector('.page.on');
    return on ? on.id.replace(/^page-/, '') : '';
  }

  /// 每 30 秒取一次物理内存，重画设置页 / 实例页里的内存条。
  ///
  /// 只在两个用得到内存数据的页面刷新：别的页面（下载、账号）没有内存条，
  /// 每半分钟发一次请求纯属浪费。
  function refreshMemorySnapshot() {
    var page = currentPageId();
    if (page !== 'settings' && page !== 'instance') { return; }

    apiCall('memorySnapshot', []).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.total) { return; }
      var info = { total: d.total, used: d.used, available: d.available };

      if (page === 'settings' && lastGlobalGame) {
        renderMemoryMeter('', lastGlobalGame.maxMemory || 0, 0, info, !!lastGlobalGame.autoMemory);
      } else if (page === 'instance' && instData && instData.game) {
        renderMemoryMeter('inst-', instData.game.maxMemory || 0, 0, info, !!instData.game.autoMemory);
      }
    });
  }

  /// 绑定滑条交互。
  ///
  /// `input` 只更新界面、`change` 才落盘——拖动一次会触发几十个 input，
  /// 每个都发一次 HTTP 请求既浪费又会让后端反复写配置文件。
  function mountMemoryMeter(prefix, apply) {
    var maxRange = document.getElementById(prefix + 'mem-max-range');
    if (!maxRange) { return; }

    maxRange.addEventListener('input', function () {
      var gb = ramFromTick(Number(this.value));
      setText(prefix + 'mem-max-value', fmtGb(gb));
      drawMemoryBar(prefix, gb * 1024, false);
    });
    maxRange.addEventListener('change', function (e) {
      // 只认用户操作。renderMemoryMeter 会用代码改 value（回填后端数据、
      // 或者在 max 变小时被浏览器夹紧），那些都不该反过来写进配置文件——
      // 曾经因为这样把 maxMemory 写成了 410MB。
      if (!e.isTrusted) { return; }
      apply('maxMemory', Math.round(ramFromTick(Number(this.value)) * 1024));
    });

  }


