/* Tauri 壳的前端适配层
   ────────────────────────────────────────────────────────────────────
   目的：让 app.js 一行都不用改。
   JavaFX 模式下 Java 用 window.setMember("nativeBridge", bridge) 注入一个 JSObject，
   方法同步返回。换到 Tauri 后前后端变成两个进程，桥走 127.0.0.1 的 HTTP。

   这里伪造一个等价的 nativeBridge：
     - 绝大多数方法是「发出去就不管」，返回 null 不影响调用点
     - 只有 getState / appearance 依赖返回值，用预取缓存的招式做成同步返回
     - Java -> JS 的推送走 SSE，收到就 eval，和原来 engine.executeScript 等价

   由 index.html 在 app.js 之后引，非 Tauri 环境（JavaFX WebView）直接返回，不做任何事。
*/
(function () {
  'use strict';

  var isTauri = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
  if (!isTauri || window.__HMCL_SHIM__) { return; }
  window.__HMCL_SHIM__ = true;

  // 端口和 token 由壳拼在 URL 上：index.html?port=xxxxx&token=yyyy
  // 走 query 而不是注入全局变量，刷新页面时不会丢
  var qs = new URLSearchParams(location.search);
  var PORT = window.__HMCL_PORT__ || qs.get('port');
  var TOKEN = window.__HMCL_TOKEN__ || qs.get('token') || '';
  if (!PORT) {
    console.error('[bridge] 没有拿到核心端口，页面不会工作');
    return;
  }
  var BASE = 'http://127.0.0.1:' + PORT;
  var HEADERS = { 'Content-Type': 'application/json', 'X-HMCL-Token': TOKEN };

  // 需要同步返回值的方法，都在这里缓存
  var cache = Object.create(null);

  // 窗口控制交给 Tauri，不绕 Java——JavaFX Stage 在新壳里不存在
  var WINDOW_OPS = {
    minimize: function () { ti().minimize(); },
    toggleMaximize: function () { ti().toggleMaximize(); },
    close: function () { ti().close(); },
    dragStart: function () { ti().startDragging(); }
  };

  // 预览相关的调用在壳模式里是空操作：3D 由前端 skinview3d 渲染，
  // 不需要 Java 启动那个 500ms 定时截图，也不需要它维护视角和显隐。
  var PREVIEW_NOOP = {
    setPreviewActive: 1,
    setPreviewRect: 1,
    hidePreview: 1,
    rotatePreview: 1,
    setAppearanceTab: 1
  };

  function ti() {
    // Tauri 2：withGlobalTauri 打开后挂在 __TAURI__.window
    var w = window.__TAURI__ && window.__TAURI__.window;
    if (w && w.getCurrentWindow) { return w.getCurrentWindow(); }
    var cur = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.metadata
      && window.__TAURI_INTERNALS__.metadata.currentWindow;
    if (cur && cur.label && w && w.Window && w.Window.getByLabel) {
      return w.Window.getByLabel(cur.label);
    }
    throw new Error('Tauri window API 不可用');
  }

  function post(method, args) {
    return fetch(BASE + '/api/' + encodeURIComponent(method), {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(args || [])
    }).then(function (r) { return r.json(); })
      .catch(function (e) { console.error('[bridge]', method, e); return { ok: false, error: String(e) }; });
  }

  // ---------------- 伪造 nativeBridge ----------------

  window.nativeBridge = new Proxy({}, {
    get: function (_, method) {
      if (typeof method !== 'string') { return undefined; }

      // 同步读：返回预取的缓存
      if (method === 'getState') {
        return function () { return cache.getState || null; };
      }
      // appearance 不返回缓存——那里会一直是启动那一刻的数据。
      // 改成让后端把最新的推过来，渲染交给 onAppearance。
      if (method === 'appearance') {
        return function () {
          post('requestAppearance');
          return null;
        };
      }
      // instanceInstallers 同理
      if (method === 'instanceInstallers') {
        return function (id) {
          post('instanceInstallers', [id]).then(function (r) {
            if (r && r.ok && r.data != null && window.__hmcl && window.__hmcl.onInstanceInstallers) {
              window.__hmcl.onInstanceInstallers(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
            }
          });
          return null;
        };
      }
      // instanceAddons 同理：拉回来推 onInstanceAddons
      if (method === 'instanceAddons') {
        return function (id, kind) {
          post('instanceAddons', [id, kind]).then(function (r) {
            if (r && r.ok && r.data != null && window.__hmcl && window.__hmcl.onInstanceAddons) {
              window.__hmcl.onInstanceAddons(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
            }
          });
          return null;
        };
      }

      // getSettings 同理：拉回来直接塞给 onSettings
      if (method === 'getSettings') {
        return function () {
          post('getSettings').then(function (r) {
            if (r && r.ok && r.data != null && window.__hmcl && window.__hmcl.onSettings) {
              window.__hmcl.onSettings(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
            }
          });
          return null;
        };
      }

      // 窗口操作走 Tauri API
      if (WINDOW_OPS[method]) {
        return function () {
          try { WINDOW_OPS[method](); } catch (e) { console.error(e); }
          return null;
        };
      }

      // 预览控制由前端接管，不发出去
      if (PREVIEW_NOOP[method]) {
        return function () { return null; };
      }

      // 其余全部转发。返回值一律 null——调用点本来也不看
      return function () {
        post(method, Array.prototype.slice.call(arguments));
        return null;
      };
    },

    // app.js 里有 typeof b[m] === 'function' 的判断，has 也要放行
    has: function () { return true; }
  });

  // ---------------- Java -> JS 推送 ----------------

  // 注意创建时机：这份脚本在 </body> 前同步执行，此时页面还在解析。
  // 在这个阶段建 EventSource 会被 WebView2 断掉（实测连上即 error），
  // 所以等 load 之后再连，那时网络栈已经稳定。
  var es = null;

  function connect() {
    es = new EventSource(BASE + '/events?token=' + encodeURIComponent(TOKEN));
    window.__HMCL_SSE = es;

    es.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (!msg.js) { return; }
      try {
        // 间接 eval：拿到全局作用域，和 engine.executeScript 的行为一致
        (0, eval)(msg.js);
      } catch (err) {
        console.error('[bridge] eval failed', err, msg.js);
      }
    };

    es.onerror = function () {
      // EventSource 自带重连；这里只记录，不手动重建（手动重建会和自动重连打架）
      if (es.readyState === 2) {
        console.warn('[bridge] SSE 已关闭，5 秒后重建');
        setTimeout(connect, 5000);
      }
    };
  }

  if (document.readyState === 'complete') {
    connect();
  } else {
    window.addEventListener('load', connect);
  }

  // ---------------- 启动：预取 -> 派发 native-ready ----------------

  // app.js 在 native-ready 之后立刻 call('getState')，所以必须在这之前把缓存填好。
  // 只预取这一项：外观数据是随页面切换按需拉的（importSkin 之后会变），不适合预取。
  post('getState').then(function (s) {
    if (s && s.ok && s.data != null) {
      cache.getState = typeof s.data === 'string' ? s.data : JSON.stringify(s.data);
    }
    document.dispatchEvent(new Event('native-ready'));
  });
})();
