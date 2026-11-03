/* 多人联机页：托管「陶瓦联机（Terracotta）」。
 *
 * 原则是只调用、不修改：启动器负责下载、启动、退出，开房和加入都走陶瓦
 * 自己暴露的本地 HTTP 接口。这一页只做状态映射和按钮显隐，不参与协议细节。
 *
 * 状态来源是后端 lanState：
 *   exists      模块装好没有
 *   installing  正在下载
 *   installError 上一次下载失败的原因
 *   running     核心在跑（端口 + /state 有应答）
 *   starting    核心进程起来了但端口还没出来
 *   core.state  陶瓦自己的状态机
 */
(function () {
  'use strict';

  var LAN_RELEASES = 'https://github.com/burningtnt/Terracotta/releases';

  var lanTimer = null;
  var lanTimerMs = 0;
  var lanData = null;
  var lanLastFail = '';       // 上一次报过的下载失败原因，避免每轮都弹
  var lanLastStartError = '';

  /// 状态名 → 页面。陶瓦的状态机在 `core.state` 里，这里只做展示映射。
  var LAN_PHASE = {
    waiting: {
      badge: '待机',
      hint: '输入房间码后即可加入房间，若您为房主请点击创建房间',
      idle: ''
    },
    'host-scanning': {
      badge: '等待开局域网',
      hint: '请进入需多人联机的世界，对局域网开放',
      idle: '取消创建'
    },
    'host-starting': {
      badge: '正在开房',
      hint: '正在创建房间，稍候…',
      idle: '取消创建'
    },
    'host-ok': {
      badge: '房间已创建',
      hint: '已创建房间，发送房间码给好友加入房间即可',
      idle: '关闭房间'
    },
    'guest-connecting': {
      badge: '连接中',
      hint: '正在连接房主，稍候…',
      idle: '取消加入'
    },
    'guest-starting': {
      badge: '正在加入',
      hint: '正在加入房间，稍候…',
      idle: '取消加入'
    },
    'guest-ok': {
      badge: '已加入',
      hint: '已加入房间，打开游戏 → 多人游戏，双击「陶瓦联机大厅」进入',
      idle: '退出房间'
    },
    exception: {
      badge: '出错',
      hint: '联机出错了，可以退出房间后重试',
      idle: '回到待机'
    }
  };

  /// 只绑定一次。`initLan` 目前只在启动时调，但页面重建、热重载都会再进来一次，
  /// 重复 addEventListener 会让一次点击触发多次请求。
  var lanBound = false;

  function initLan() {
    if (lanBound) { return; }
    lanBound = true;

    var download = document.getElementById('lan-download');
    if (download) {
      download.addEventListener('click', function () { call('openUrl', LAN_RELEASES); });
    }

    var install = document.getElementById('lan-install');
    if (install) {
      install.addEventListener('click', function () {
        install.disabled = true;
        // 失败后重试：清掉上一轮的错误，让按钮回到「下载中」而不是继续红着
        lanLastFail = '';
        apiCall('lanInstall', []).then(function (raw) {
          install.disabled = false;
          var d = asJson(raw);
          if (d && d.ok === false && d.error) { toast(d.error, 'error'); }
          lanRefresh();
        });
      });
    }

    var start = document.getElementById('lan-start');
    if (start) {
      start.addEventListener('click', function () {
        start.disabled = true;
        apiCall('lanStart', []).then(function (raw) {
          start.disabled = false;
          var d = asJson(raw);
          if (d && d.ok === false && d.error) { toast(d.error, 'error'); }
          lanRefresh();
        });
      });
    }

    var host = document.getElementById('lan-host');
    if (host) { host.addEventListener('click', function () { lanAct('lanHost', []); }); }

    var join = document.getElementById('lan-join');
    if (join) {
      join.addEventListener('click', function () {
        var input = document.getElementById('lan-room-input');
        var code = input ? String(input.value || '').trim() : '';
        if (!code) {
          toast(tr('先填房间码'), 'error');
          if (input) { input.focus(); }
          return;
        }
        lanAct('lanJoin', [code]);
      });
    }

    var roomInput = document.getElementById('lan-room-input');
    if (roomInput) {
      roomInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && join) { join.click(); }
      });
    }

    var idle = document.getElementById('lan-idle');
    if (idle) { idle.addEventListener('click', function () { lanAct('lanIdle', []); }); }

    var copy = document.getElementById('lan-copy');
    if (copy) { copy.addEventListener('click', function () { lanCopyCode(); }); }
  }

  function lanAct(method, args) {
    apiCall(method, args).then(function (raw) {
      var d = asJson(raw);
      if (d && d.ok === false && d.error) {
        toast(d.error, 'error');
        return;
      }
      if (d) {
        lanData = d;
        renderLan(d);
      }
      lanRefresh();
    });
  }

  function lanCopyCode() {
    var code = document.getElementById('lan-room-code');
    if (!code) { return; }
    var text = code.textContent || '';
    if (!text) { return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast(tr('房间码已复制'));
      }, function () {
        toast(tr('复制失败'), 'error');
      });
    }
  }

  /// 停在联机页时才轮询：核心可能被系统或用户从任务栏关掉，房间状态也在变。
  function showLan() {
    lanRefresh();
    startLanTimer(lanData && lanData.installing ? 700 : 1500);
  }

  function startLanTimer(ms) {
    if (lanTimer && lanTimerMs === ms) { return; }
    lanStopPoll();
    lanTimerMs = ms;
    lanTimer = setInterval(lanRefresh, ms);
  }

  function lanStopPoll() {
    if (lanTimer) {
      clearInterval(lanTimer);
      lanTimer = null;
      lanTimerMs = 0;
    }
  }

  function lanRefresh() {
    apiCall('lanState', []).then(function (raw) {
      var d = asJson(raw);
      if (!d || !d.ok) { return; }
      lanData = d;
      renderLan(d);
    });
  }

  function renderLan(d) {
    var installing = !!d.installing;
    var ready = !!d.exists;
    var running = !!d.running;
    var starting = !!d.starting;
    var failed = !installing && !ready && !!d.installError;
    var core = d.core || {};
    var phase = String(core.state || 'waiting');
    var view = LAN_PHASE[phase] || LAN_PHASE.waiting;

    // ---- 徽标 ----
    var badge = document.getElementById('lan-badge');
    if (badge) {
      if (installing) {
        badge.textContent = tf('下载中 {0}%', d.progress || 0);
        badge.className = 'lan-badge';
      } else if (failed) {
        badge.textContent = tr('下载失败');
        badge.className = 'lan-badge bad';
      } else if (!ready) {
        badge.textContent = tr('未加载');
        badge.className = 'lan-badge';
      } else if (starting) {
        badge.textContent = tr('启动中');
        badge.className = 'lan-badge';
      } else if (!running) {
        badge.textContent = tr('已就绪');
        badge.className = 'lan-badge ready';
      } else {
        badge.textContent = tr(view.badge);
        badge.className = 'lan-badge on';
      }
    }

    // ---- 一句话状态 ----
    var hint = document.getElementById('lan-hint');
    if (hint) {
      if (installing) {
        hint.textContent = tr('正在下载联机模块…');
      } else if (failed) {
        hint.textContent = tr('下载联机模块失败，请检查网络是否正常');
      } else if (!ready) {
        hint.textContent = tr('当前联机模块未加载，点击「下载联机模块」加载');
      } else if (starting) {
        hint.textContent = tr('正在启动联机核心…');
      } else if (!running) {
        hint.textContent = tr('联机模块已就绪');
      } else {
        hint.textContent = tr(view.hint);
      }
    }

    // ---- 按钮 ----
    // 「下载联机模块」在失败后也要留着：那就是重试入口
    toggleRow('lan-install', !ready && !installing);
    toggleRow('lan-start', ready && !running && !starting && !installing);
    // 待机时才给开房和加入：已经在房间里再点没有意义
    var idlePhase = running && phase === 'waiting';
    toggleRow('lan-host', idlePhase);
    toggleRow('lan-room-input', idlePhase);
    toggleRow('lan-join', idlePhase);
    toggleRow('lan-idle', running && !!view.idle);
    // 没有「停止核心」按钮：核心跟着启动器一起退出，用户不需要单独管

    var idle = document.getElementById('lan-idle');
    if (idle && view.idle) { idle.textContent = tr(view.idle); }

    // ---- 房间码：只有房主有 ----
    var room = document.getElementById('lan-room');
    var code = phase === 'host-ok' && core.room ? String(core.room) : '';
    if (room) { room.hidden = !code; }
    if (code) { setText('lan-room-code', code); }

    renderLanPlayers(core.profiles);

    // ---- 失败提示：只弹一次，别每 1.5 秒重复 ----
    if (!installing && d.installError) {
      if (d.installError !== lanLastFail) {
        lanLastFail = d.installError;
        toast(d.installError, 'error');
      }
    } else if (!d.installError) {
      lanLastFail = '';
    }

    if (!starting && d.startError && d.startError !== lanLastStartError) {
      lanLastStartError = d.startError;
      toast(d.startError, 'error');
    }
    if (!d.startError) { lanLastStartError = ''; }
  }

  /// 玩家列表。陶瓦给的 `profiles` 是「名字 → 状态」的对象，
  /// 房主自己那一条会带 `host` 标记。
  function renderLanPlayers(profiles) {
    var box = document.getElementById('lan-players');
    if (!box) { return; }
    if (!profiles) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    var names = Object.keys(profiles);
    if (!names.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.innerHTML = '';
    names.forEach(function (name) {
      var info = profiles[name] || {};
      var label = name || tr('匿名玩家');
      if (info.host) { label += ' · ' + tr('房主'); }
      box.appendChild(el('span', 'lan-player', label));
    });
    box.hidden = false;
  }

  window.initLan = initLan;
  window.showLan = showLan;
  window.lanStopPoll = lanStopPoll;
})();
