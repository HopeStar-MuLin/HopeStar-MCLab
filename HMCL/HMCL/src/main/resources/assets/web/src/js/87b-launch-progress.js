/* 启动进度弹窗。
 *
 * 点「启动」之后，从准备到游戏窗口出现有几秒到几十秒。原来这段时间页面上
 * 什么提示都没有，用户不知道是在下载依赖、在等 Java 还是在等窗口。
 *
 * 数据来自 Java 侧 LaunchProgressBridge，它把 HMCL 启动管线的阶段推进
 * 转发过来（检测 Java 版本 → 处理游戏依赖 → 校验游戏文件 → 登录 → 等待游戏启动）。
 * 这里只负责画，不做任何启动决策。
 */
(function () {
  'use strict';

  var REVEAL_DELAY = 250;   // 这么快就完成的话不弹，避免闪一下

  /// 状态的最小停留时间。
  ///
  /// 本地缓存命中时，五个阶段可能在 200ms 内全部跑完，用户只看到最后一句，
  /// 等于没显示。这里保证每次切换至少挂 320ms，太快的阶段会被合并成最后一个 ——
  /// 宁可少显示一步，也不要闪成一片。
  ///
  /// 文字和进度条一起切换：只节流文字会让「正在补全资源文件」配着 80% 的条，
  /// 看着像两个不同步的东西。
  var MIN_STATE_MS = 320;

  var revealTimer = 0;
  var flushTimer = 0;
  var open = false;
  var finished = false;

  var percent = 0;              // 当前显示的进度
  var queue = [];               // 待播放的状态，按到达顺序排
  var pendingFinish = null;     // 队列播完之后再处理的结束事件
  var lastAt = 0;

  /// 用户点了取消之后的静默期。后端要杀进程，收尾事件可能过几秒才到，
  /// 期间推过来的任何状态（包括 executor 报的失败）都不该再弹出来。
  var silentUntil = 0;

  /// 这一轮启动是否要在游戏退出后把窗口放回来（设置里的「隐藏，游戏退出后再打开」）。
  var reopenOnExit = false;

  function node(id) { return document.getElementById(id); }
  function tr(key) { return window.tr ? window.tr(key) : key; }

  /// 拿当前窗口对象。JavaFX 模式下没有 `__TAURI__`，返回 null，调用点静默跳过。
  function launcherWindow() {
    var tauri = window.__TAURI__;
    if (!tauri || !tauri.window) { return null; }
    try {
      return tauri.window.getCurrentWindow ? tauri.window.getCurrentWindow() : tauri.window.getCurrent();
    } catch (e) {
      return null;
    }
  }

  /// 启动成功后把启动器收起来。
  ///
  /// 壳模式下界面本身就是一个 Tauri 窗口，JavaFX 的 `LauncherVisibility.HIDE`
  /// 对它完全无效 —— 那个枚举只管 JavaFX 的 Stage。所以窗口要由页面自己调。
  function hideLauncherWindow() {
    var win = launcherWindow();
    if (win && win.hide) {
      try { win.hide(); } catch (e) { /* 隐藏失败就留着，总比崩了强 */ }
    }
  }

  function showLauncherWindow() {
    var win = launcherWindow();
    if (!win) { return; }
    try {
      if (win.show) { win.show(); }
      if (win.unminimize) { win.unminimize(); }
      if (win.setFocus) { win.setFocus(); }
    } catch (e) { /* 同上 */ }
  }

  /// 播放队列里的一项。文字和条一起换，保证读到的是一致的一帧。
  function render(next) {
    if (next.label) {
      var stage = node('lp-stage');
      var text = tr(next.label);
      if (stage && text !== stage.textContent) { stage.textContent = text; }
    }
    if (next.percent >= 0) {
      // 只许向前：阶段是跳着报的，偶尔会先收到靠后的再收到靠前的
      if (next.percent > percent) { percent = next.percent; }
      var fill = node('lp-fill');
      var bar = node('lp-bar');
      if (fill) {
        if (bar) { bar.classList.remove('pending'); }
        fill.style.width = Math.round(Math.max(4, percent * 100)) + '%';
      }
    }
    lastAt = Date.now();
  }

  /// 按固定节奏播放队列。
  ///
  /// 不是「合并丢弃」而是「排队播放」：本地缓存命中时五个阶段 200ms 就跑完了，
  /// 如果只显示最后一个，「补全依赖」「校验文件」这些步骤用户永远看不到 ——
  /// 那这几行文案就等于没写。宁可启动完成后多播一秒，也要把步骤走一遍。
  function pump() {
    if (!open) { return; }

    var since = Date.now() - lastAt;
    if (since < MIN_STATE_MS) {
      if (!flushTimer) {
        flushTimer = setTimeout(function () {
          flushTimer = 0;
          pump();
        }, MIN_STATE_MS - since);
      }
      return;
    }

    var next = queue.shift();
    if (!next) {
      var done = pendingFinish;
      if (done) {
        pendingFinish = null;
        finish(done);
      }
      return;
    }

    render(next);

    if (queue.length && !flushTimer) {
      flushTimer = setTimeout(function () {
        flushTimer = 0;
        pump();
      }, MIN_STATE_MS);
    }
  }

  function applyState(label, value) {
    if (!label && !(typeof value === 'number' && value >= 0)) { return; }
    queue.push({
      label: label || '',
      percent: typeof value === 'number' ? value : -1
    });
    // 队列别无限涨：同一阶段重复上报时只留最后一条
    if (queue.length > 12) { queue.splice(0, queue.length - 12); }
    pump();
  }

  function show() {
    var modal = node('lp-modal');
    if (!modal || open) { return; }
    open = true;
    finished = false;
    silentUntil = 0;
    lastAt = 0;
    percent = 0;

    var card = modal.querySelector('.lp-body');
    if (card) { card.classList.remove('failed'); }

    var stage = node('lp-stage');
    if (stage) { stage.textContent = tr('正在准备启动…'); }

    var fill = node('lp-fill');
    if (fill) { fill.style.width = '0%'; }
    var bar = node('lp-bar');
    if (bar) { bar.classList.add('pending'); }
    // 队列里攒的是弹窗出现之前攒下的阶段，马上开始播第一个
    lastAt = 0;

    var note = node('lp-note');
    if (note) {
      note.textContent = '';
      note.classList.remove('error');
    }
    var cancel = node('lp-cancel');
    if (cancel) {
      cancel.textContent = tr('取消启动');
      cancel.disabled = false;
      cancel.hidden = false;
    }

    modal.classList.remove('hidden');
    // 弹窗出现之前攒下的阶段，从第一项开始播
    pump();
  }

  function hide() {
    var modal = node('lp-modal');
    if (modal) { modal.classList.add('hidden'); }
    // 文字一起清掉：下次打开如果不带阶段，不该先闪一下上一轮的结果
    var stage = node('lp-stage');
    if (stage) { stage.textContent = ''; }

    open = false;
    percent = 0;
    finished = false;
    queue = [];
    pendingFinish = null;
    lastAt = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = 0;
    }
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = 0;
    }
  }

  /// 失败时卡片留着，把原因写清楚，用户点「关闭」才走。
  function showFailure(error) {
    var modal = node('lp-modal');
    if (!modal) { return; }
    if (!open) { show(); }
    finished = true;

    var card = modal.querySelector('.lp-body');
    if (card) { card.classList.add('failed'); }
    var stage = node('lp-stage');
    if (stage) { stage.textContent = tr('启动失败'); }

    var note = node('lp-note');
    if (note) {
      note.textContent = error;
      note.classList.add('error');
    }
    var cancel = node('lp-cancel');
    if (cancel) {
      cancel.textContent = tr('关闭');
      cancel.disabled = false;
      cancel.hidden = false;
    }
  }

  function finish(data) {
    // 队列里还有没播完的阶段：先播完再收尾，否则用户永远看不到中间那几步
    if (queue.length) {
      pendingFinish = data;
      pump();
      return;
    }

    var error = data.error || '';

    if (error === 'cancelled') {
      hide();
      return;
    }
    if (error) {
      showFailure(error);
      return;
    }

    // 成功：把条推满，停一下让用户看到「走完了」，再关
    if (!open) { return; }   // 快到没来得及弹，不打扰
    finished = true;
    render({ label: '游戏已启动', percent: 1 });
    var btn = node('lp-cancel');
    if (btn) { btn.hidden = true; }
    setTimeout(hide, 520);

    if (data.hideLauncher) {
      reopenOnExit = !!data.reopenLauncher;
      // 比弹窗关闭晚一点：先让「游戏已启动」露个面，窗口再收起来，
      // 否则用户会觉得点完启动界面直接没了
      setTimeout(hideLauncherWindow, 900);
    }
  }

  /// Java 侧推过来的进度。参数是一段 JSON 文本，和别的回调保持一致。
  function onProgress(json) {
    var data = null;
    try { data = JSON.parse(json); } catch (e) { return; }
    if (!data) { return; }

    // 点了取消之后的收尾事件全部丢掉：那时候弹窗已经收了，
    // 再把「启动失败：xxx」推出来就是自己给自己找麻烦
    if (Date.now() < silentUntil) { return; }

    if (data.done) {
      if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = 0;
      }
      finish(data);
      return;
    }

    applyState(data.label || '', typeof data.percent === 'number' ? data.percent : -1);

    if (!open) {
      // 第一条：延迟一点再弹。本地缓存命中时整个启动 300ms 就完了，
      // 弹一下马上消失比不弹更烦人。
      if (!revealTimer && !finished) {
        revealTimer = setTimeout(function () {
          revealTimer = 0;
          if (!finished) { show(); }
        }, REVEAL_DELAY);
      }
    }
  }

  function bind() {
    var cancel = node('lp-cancel');
    if (!cancel) { return; }
    cancel.addEventListener('click', function () {
      if (finished) { hide(); return; }
      // 点了就立刻收起：后端还要杀进程、清临时目录，可能几秒。
      // 让用户盯着一个「正在取消…」的框等，不如直接消失。
      silentUntil = Date.now() + 4000;
      hide();
      try { call('cancelLaunchProgress'); } catch (e) { /* 后端没实现也不影响关闭 */ }
    });
  }

  window.__launchProgress = onProgress;

  /// 游戏退出时由 Java 侧推过来。只有「隐藏，退出后再打开」才主动恢复窗口 ——
  /// 单纯的「隐藏启动器」是让用户自己从任务栏找回来。
  window.__launchShowWindow = function () {
    if (reopenOnExit) {
      reopenOnExit = false;
      showLauncherWindow();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
