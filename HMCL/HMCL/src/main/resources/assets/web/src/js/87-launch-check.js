  // ---------------- 启动前检查 ----------------
  //
  // 后端在真正拉起进程之前跑一遍资源检查（Java 版本 / 内存 / 客户端 jar / 模组），
  // 有问题就推 onLaunchCheck 过来，由这里出弹窗。没问题的实例根本走不到这里 ——
  // 后端直接启动，用户看到的就是「点了就开」，不额外多一次点击。
  //
  // 分两档：blocking 是「几乎必然起不来」，默认按钮给「取消」；warnings 是
  // 「能开但可能出事」，默认按钮给「继续启动」。两档都是提示，不硬拦 ——
  // 用户永远有权说「我知道，让我试」。

  var lcInstanceId = '';

  function openLaunchCheck(d) {
    if (!d || !d.instanceId) { return; }
    lcInstanceId = d.instanceId;

    var blocking = d.blocking || [];
    var warnings = d.warnings || [];
    var sub = document.getElementById('lc-sub');
    var list = document.getElementById('lc-list');
    var ok = document.getElementById('lc-ok');
    list.innerHTML = '';

    if (blocking.length) {
      sub.textContent = tr('检测到以下问题，游戏可能无法启动。');
      ok.textContent = tr('继续');
      ok.classList.remove('primary');
      ok.classList.add('ghost');
    } else {
      sub.textContent = tr('检测到以下问题，可能影响游戏运行。');
      ok.textContent = tr('继续');
      ok.classList.add('primary');
      ok.classList.remove('ghost');
    }

    blocking.forEach(function (it) { list.appendChild(lcRow(it, 'block')); });
    warnings.forEach(function (it) { list.appendChild(lcRow(it, 'warn')); });

    document.getElementById('lc-modal').classList.remove('hidden');
  }

  /// 把 `{0}` / `{1}` 换成后端给的参数。
  ///
  /// 顺序是「先翻模板，再填数字」：语言包里的键是带占位符的模板，
  /// 反过来（先填再翻）就永远查不到，等于没翻。
  function lcFill(text, params) {
    if (!text || !params || !params.length) { return text; }
    return String(text).replace(/\{(\d+)\}/g, function (m, i) {
      var v = params[+i];
      return v == null ? m : String(v);
    });
  }

  function lcRow(item, kind) {
    var row = el('div', 'lc-row ' + kind);
    var head = el('div', 'lc-row-head');
    head.appendChild(el('span', 'lc-dot'));
    head.appendChild(el('strong', null, lcFill(tr(item.title || ''), item.params)));
    row.appendChild(head);
    if (item.detail) {
      row.appendChild(el('p', 'lc-detail', lcFill(tr(item.detail), item.params)));
    }
    return row;
  }

  /// 关弹窗。`cancelled` 为真时告诉后端「这次不启动」，把放行标记清掉 ——
  /// 不清的话下一次点启动会被当成「已确认」，检查就白做了。
  function closeLaunchCheck(cancelled) {
    document.getElementById('lc-modal').classList.add('hidden');
    if (cancelled && lcInstanceId) {
      call('cancelLaunch', lcInstanceId);
    }
    lcInstanceId = '';
  }

  function initLaunchCheck() {
    var close = document.getElementById('lc-close');
    var cancel = document.getElementById('lc-cancel');
    var ok = document.getElementById('lc-ok');
    var modal = document.getElementById('lc-modal');
    if (!close || !cancel || !ok || !modal) { return; }

    close.addEventListener('click', function () { closeLaunchCheck(true); });
    cancel.addEventListener('click', function () { closeLaunchCheck(true); });
    ok.addEventListener('click', function () {
      var id = lcInstanceId;
      // 先关窗再启动：后端会重新走一遍检查以外的流程，
      // 弹窗留在屏幕上会盖住启动后的任务条。
      closeLaunchCheck(false);
      if (id) { call('launchConfirmed', id); }
    });
    // 点遮罩等于取消（和别的弹窗一致）
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeLaunchCheck(true); }
    });
  }
