  // ---------------- 登录（离线 / 微软 / 外置认证） ----------------
  //
  // 三个弹窗都在页面里画：壳模式没有 JavaFX 窗口，HMCL 自带的登录面板弹不出来。
  // 后端只负责「拿凭据 → 建账号 → 加进列表 → 推状态」，界面全在这里。

  var authlibList = [];
  var loginFlow = '';          // 当前正在登录的方式，用来忽略过期的回调
  /// 微软登录是否还在跑。设备码流程背后是一个最长 15 分钟的轮询，
  /// 用户关掉弹窗就得把它掐掉，否则后台一直转、还可能悄悄登进去一个账号。
  var msLoginActive = false;
  /// 这个构建有没有微软登录的 client id。null = 还没问过后端。
  /// 发行版在 Mojang 审核期不带 id，前端据此把入口置灰。
  var msAuthAvailable = null;

  function openLogin(kind) {
    if (kind === 'microsoft' && msAuthAvailable === false) {
      toast('本版暂未开放微软正版登录，请使用离线登录或外置认证');
      return;
    }
    loginFlow = kind;
    if (kind === 'offline') {
      document.getElementById('lo-name').value =
        (state && state.account && state.account.name) ? '' : '';
      showModal('login-offline');
      syncOfflineHint();
      setTimeout(function () { document.getElementById('lo-name').focus(); }, 60);
      return;
    }
    if (kind === 'microsoft') {
      // 每次都重新申请设备码，旧码可能已经过期
      document.getElementById('lm-stage').textContent = tr('正在申请登录代码…');
      document.getElementById('lm-code-box').hidden = true;
      document.getElementById('lm-open').hidden = true;
      msLoginActive = true;
      showModal('login-ms');
      call('loginMicrosoft');
      return;
    }
    // 外置认证
    showModal('login-authlib');
    document.getElementById('la-add').hidden = true;
    document.getElementById('la-user').value = '';
    document.getElementById('la-pass').value = '';
    document.getElementById('la-url').value = '';
    document.getElementById('la-add-hint').textContent = tr('名称等信息会自动从皮肤站读取');
    call('requestAuthlibServers');
  }

  /// 关闭微软登录弹窗。真在登录的时候顺手把后台轮询掐掉。
  ///
  /// 以前这里只是 hideModal：弹窗关了看不见了，Java 那边的设备码轮询还在跑，
  /// 最长 15 分钟；这期间用户去浏览器授权，账号仍然会登进来——人已经取消了却还是登上了。
  function closeMicrosoftLogin() {
    if (msLoginActive) {
      msLoginActive = false;
      call('cancelMicrosoftLogin');
    }
    hideModal('login-ms');
  }

  function showModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.remove('hidden'); }
  }

  function hideModal(id) {
    var m = document.getElementById(id);
    if (m) { m.classList.add('hidden'); }
  }

  function renderAuthlibServers(list) {
    authlibList = list || [];
    var sel = document.getElementById('la-server');
    if (!sel) { return; }
    var prev = sel.value;
    sel.innerHTML = '';
    if (!authlibList.length) {
      var empty = el('option', null, '还没有可用的皮肤站');
      empty.value = '';
      sel.appendChild(empty);
      return;
    }
    authlibList.forEach(function (s) {
      var o = el('option', null, s.name + (s.builtin ? '（内置）' : ''));
      o.value = s.url;
      sel.appendChild(o);
    });
    // 尽量保持用户原来选的那个
    if (prev && authlibList.some(function (s) { return s.url === prev; })) {
      sel.value = prev;
    }
  }

  /// 用户名规则照抄 HMCL：`^[A-Za-z0-9_]+$`，不超过 16 个字符
  /// （CreateAccountPane.USERNAME_CHECKER_PATTERN）
  var PROFILE_NAME_RE = /^[A-Za-z0-9_]+$/;

  function offlineNameError(name) {
    if (!name) { return ''; }
    if (name.length > 16) { return tr('不能超过 16 个字符'); }
    if (!PROFILE_NAME_RE.test(name)) { return tr('只能用英文字母、数字和下划线'); }
    return '';
  }

  function syncOfflineHint() {
    var input = document.getElementById('lo-name');
    var hint = document.getElementById('lo-hint');
    var ok = document.getElementById('lo-ok');
    if (!input) { return; }
    var err = offlineNameError(input.value.trim());
    if (hint) {
      hint.textContent = err ? tf('用户名{0}', err) : '';
      hint.hidden = !err;
    }
    if (ok) {
      ok.disabled = !!err || !input.value.trim();
    }
  }

  function submitOffline() {
    var name = document.getElementById('lo-name').value.trim();
    var err = offlineNameError(name);
    if (err) { toast(tf('用户名{0}', err), 'error'); return; }
    if (!name) { toast('先填个用户名', 'error'); return; }
    hideModal('login-offline');
    call('loginOffline', name);
  }

  function submitAuthlib() {
    var url = document.getElementById('la-server').value;
    var user = document.getElementById('la-user').value.trim();
    var pass = document.getElementById('la-pass').value;
    if (!url) { toast('先选一个皮肤站', 'error'); return; }
    if (!user || !pass) { toast('邮箱/用户名和密码都要填', 'error'); return; }
    hideModal('login-authlib');
    call('loginAuthlib', url, user, pass);
  }

  function addAuthlibServer() {
    var url = document.getElementById('la-url').value.trim();
    if (!url) { toast('填一下皮肤站的 API 根地址', 'error'); return; }
    var hint = document.getElementById('la-add-hint');
    hint.textContent = tr('正在读取皮肤站信息…');
    apiCall('addAuthlibServer', [url]).then(function () {
      // 结果由 onAuthlibServers 推回来，这里只兜住失败时把提示还原
      setTimeout(function () {
        if (hint.textContent === '正在读取皮肤站信息…') {
          hint.textContent = tr('名称等信息会自动从皮肤站读取');
        }
      }, 8000);
    });
  }

