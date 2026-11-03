  // ---------------- 启动器更新 ----------------
  //
  // 走 GitHub Releases：检查 → 下载 → 写一个延迟脚本，退出后解压覆盖再启动。
  // 运行中的 exe 是锁着的，所以最后一步必须等进程退干净才做。

  var updateState = { info: null, ready: false };

  function setUpdateStatus(text) {
    var el = document.getElementById('update-status');
    if (el) { el.textContent = text || ''; }
  }

  function setUpdateBar(percent) {
    var wrap = document.getElementById('update-bar-wrap');
    var bar = document.getElementById('update-bar');
    if (!wrap || !bar) { return; }
    wrap.hidden = percent == null;
    if (percent != null) { bar.style.width = Math.max(0, Math.min(100, percent)) + '%'; }
  }

  function initUpdateUi() {
    var check = document.getElementById('check-update');
    if (check) {
      check.addEventListener('click', function () {
        if (check.disabled) { return; }
        check.disabled = true;
        check.textContent = tr('检查中…');
        var card = document.getElementById('update-card');
        if (card) { card.hidden = true; }
        call('checkLauncherUpdate');
      });
    }
    var now = document.getElementById('update-now');
    if (now) {
      now.addEventListener('click', function () {
        if (now.disabled) { return; }
        if (updateState.ready) { call('applyLauncherUpdate'); return; }
        if (!updateState.info || !updateState.info.url) { return; }
        now.disabled = true;
        now.textContent = tr('下载中…');
        setUpdateStatus('正在下载更新包…');
        setUpdateBar(0);
        call('downloadLauncherUpdate', updateState.info.url, updateState.info.size || 0);
      });
    }
  }

  function initLoginModals() {
    // 三张登录卡片
    var cards = document.querySelectorAll('[data-login]');
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener('click', function () {
        openLogin(this.getAttribute('data-login'));
      });
    }

    // 没有内置 client id 的构建（发行版在 Mojang 审核期就是这种）把微软入口置灰，
    // 别让用户点了才看到失败提示
    apiCall('isMicrosoftAuthAvailable').then(function (raw) {
      var v = asJson(raw);
      msAuthAvailable = (v === true || v === 'true' || raw === true || raw === 'true');
      if (msAuthAvailable) { return; }
      var card = document.querySelector('[data-login="microsoft"]');
      if (!card) { return; }
      card.classList.add('disabled');
      card.setAttribute('aria-disabled', 'true');
      card.title = tr('Mojang 审核通过后开放');
      var sub = card.querySelector('span:last-child');
      if (sub) { sub.textContent = tr('暂未开放，请用离线或外置认证'); }
    }).catch(function () { /* 问不到就按可用处理，不挡用户 */ });

    var bindClose = function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', function () { hideModal(id.replace('-close', '').replace('-cancel', '')); }); }
    };
    // 关掉对应的弹窗（close / cancel 两个按钮都绑）
    ['lo-close', 'lo-cancel'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', function () { hideModal('login-offline'); }); }
    });
    ['lm-close', 'lm-cancel'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', closeMicrosoftLogin); }
    });
    ['la-close', 'la-cancel'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) { b.addEventListener('click', function () { hideModal('login-authlib'); }); }
    });

    var loOk = document.getElementById('lo-ok');
    if (loOk) { loOk.addEventListener('click', submitOffline); }
    var loName = document.getElementById('lo-name');
    if (loName) {
      loName.addEventListener('input', syncOfflineHint);
      loName.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitOffline(); }
      });
    }

    var laOk = document.getElementById('la-ok');
    if (laOk) { laOk.addEventListener('click', submitAuthlib); }
    var laPass = document.getElementById('la-pass');
    if (laPass) {
      laPass.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { submitAuthlib(); }
      });
    }

    var laToggle = document.getElementById('la-toggle-add');
    if (laToggle) {
      laToggle.addEventListener('click', function () {
        var box = document.getElementById('la-add');
        box.hidden = !box.hidden;
        if (!box.hidden) { document.getElementById('la-url').focus(); }
      });
    }
    var laAddOk = document.getElementById('la-add-ok');
    if (laAddOk) { laAddOk.addEventListener('click', addAuthlibServer); }

    var lmOpen = document.getElementById('lm-open');
    if (lmOpen) {
      lmOpen.addEventListener('click', function () {
        var url = document.getElementById('lm-url').href;
        if (url && url !== '#') { call('openLink', url); }
      });
    }
  }

  function renderAccountPage() {
    var acc = state.account;
    document.getElementById('account-name').textContent = acc ? acc.name : '未登录';
    document.getElementById('account-channel').textContent = acc ? acc.channel : '选择一个登录方式';
    document.getElementById('account-uuid').textContent = acc ? acc.uuid : '';
    setAvatar(document.getElementById('account-avatar'), acc);
    document.getElementById('btn-account-remove').disabled = !acc;

    var list = document.getElementById('account-list');
    var accounts = state.accounts || [];
    if (!accounts.length) {
      list.innerHTML = '';
      list.appendChild(el('div', 'empty', '还没有账号。上面三种方式任选一种登录。'));
      return;
    }
    var emptyNode = list.querySelector('.empty');
    if (emptyNode) { emptyNode.remove(); }

    // 按 uuid 复用行，不整段重建。
    // 以前每次 push 都 innerHTML='' 再来一遍：<img> 变成新节点，浏览器得重新
    // 解码一次头像 PNG，于是界面一更新头像就闪 —— 换皮肤、头像异步到货、
    // 点任何按钮都会触发。
    var reuse = {};
    Array.prototype.forEach.call(list.children, function (node) {
      var key = node.getAttribute('data-uuid');
      if (key) { reuse[key] = node; }
    });

    accounts.forEach(function (a, index) {
      var row = reuse[a.uuid];
      if (!row) {
        row = el('div', 'account-row');
        row.setAttribute('data-uuid', a.uuid);
        row.appendChild(document.createElement('img'));
        var main = el('div', 'row-main');
        main.appendChild(el('div', 'row-name'));
        main.appendChild(el('div', 'row-sub'));
        row.appendChild(main);
        row.appendChild(el('button', 'row-del', '删除'));

        // 事件里一律读 data-uuid，不用闭包里的 a：
        // 行是复用的，闭包捕获的那个 a 早就过期了，点删除会删错账号
        row.querySelector('.row-del').addEventListener('click', function (e) {
          e.stopPropagation();
          call('removeAccount', row.getAttribute('data-uuid'));
        });
        row.addEventListener('click', function () {
          if (!row.classList.contains('current')) {
            call('selectAccount', row.getAttribute('data-uuid'));
          }
        });
        // 右键：改名 / 复制账号 ID / 删除。正版与外置认证不给改名——
        // 它们的名字由服务器决定，本地改了下次拉 profile 又变回去。
        row.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          var acc = null;
          (state.accounts || []).forEach(function (x) {
            if (x.uuid === row.getAttribute('data-uuid')) { acc = x; }
          });
          openAccountMenu(e.clientX, e.clientY, acc);
        });
      }

      // 这一行必须写在 if 外面。
      // 原来只在「新建行」的分支里删，复用的行留在 reuse 表里，
      // 函数末尾「清理后端已经不存在的账号」就会把刚复用的行一起 remove 掉 ——
      // 表现就是切换账号后列表整个空白，切走再切回来（列表已空、全部重建）才恢复。
      delete reuse[a.uuid];

      row.classList.toggle('current', !!a.selected);
      setAvatar(row.querySelector('img'), a);
      row.querySelector('.row-name').textContent = a.name;
      row.querySelector('.row-sub').textContent = a.channel;
      // 当前账号不给删除按钮，和以前一致
      row.querySelector('.row-del').hidden = !!a.selected;

      if (list.children[index] !== row) {
        list.insertBefore(row, list.children[index] || null);
      }
    });

    // 后端已经没有的账号，把残留的行清掉
    Object.keys(reuse).forEach(function (key) {
      var node = reuse[key];
      if (node.parentNode) { node.parentNode.removeChild(node); }
    });
    stagger(list);
  }

  /// 账号行右键菜单。
  ///
  /// 离线账号：改名 / 复制账号 ID / 删除
  /// 正版、外置认证：只有复制账号 ID / 删除（名字由服务器决定，改了也没用）
  function openAccountMenu(x, y, acc) {
    if (!acc) { return; }
    var offline = (acc.channel || '').indexOf('离线') >= 0;
    var items = [];

    if (offline) {
      items.push({
        label: '修改昵称',
        action: function () {
          askName(tf('修改「{0}」的昵称', acc.name), acc.name).then(function (value) {
            if (value) { call('renameAccount', acc.uuid, value); }
          });
        }
      });
    }
    items.push({
      label: '复制账号 ID',
      action: function () { call('copyText', acc.uuid); }
    });
    items.push({
      label: '删除账号',
      danger: true,
      action: function () {
        askConfirm(tf('删除账号「{0}」？', acc.name)).then(function (yes) {
          if (yes) { call('removeAccount', acc.uuid); }
        });
      }
    });

    showContextMenu(x, y, items);
  }

