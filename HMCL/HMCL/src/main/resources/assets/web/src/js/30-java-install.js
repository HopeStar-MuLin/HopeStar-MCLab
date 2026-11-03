  // ---------------- 下载 Java ----------------
  //
  // 后端一条龙：foojay 拿当前平台可装的版本 → FileDownloadTask 下载（带 sha256）
  // → JavaInstallTask 解压成托管 Java 并注册。前端只管列出来、点一下、看进度。

  /// 最近一次列表，装完要把对应那条标成「已安装」
  var javaDlData = null;

  function openJavaDownload() {
    openModal('java-dl-modal');
    var box = document.getElementById('java-dl-list');
    if (box) {
      box.innerHTML = '';
      var load = el('div', 'loading-block small');
      load.appendChild(loadingRow('正在获取可安装的版本…'));
      box.appendChild(load);
    }
    call('listInstallableJava');
  }

  function renderJavaDownloadList(data) {
    var box = document.getElementById('java-dl-list');
    if (!box) { return; }
    box.innerHTML = '';
    javaDlData = data;

    var hint = document.getElementById('java-dl-hint');
    if (hint && data && data.warning) {
      hint.textContent = data.warning;
    }

    var list = (data && data.list) || [];
    if (!list.length) {
      box.appendChild(el('div', 'empty', '没拿到可安装的版本。检查网络后重开这个窗口。'));
      return;
    }

    list.forEach(function (it) {
      var row = el('div', 'java-dl-item');

      var main = el('div', 'java-dl-main');
      var title = el('div', 'java-dl-title');
      title.appendChild(el('span', null, 'Java ' + it.jdkVersion));
      if (it.lts) { title.appendChild(el('span', 'java-dl-badge lts', 'LTS')); }
      if (it.distro === 'temurin') { title.appendChild(el('span', 'java-dl-badge rec', '推荐')); }
      main.appendChild(title);
      main.appendChild(el('div', 'java-dl-sub',
        (it.vendor || '') + ' · ' + (it.javaVersion || '') + (it.sizeText ? ' · ' + it.sizeText : '')));
      row.appendChild(main);

      var btn = el('button', 'btn ghost small', it.installed ? '已安装' : '安装');
      btn.type = 'button';
      if (it.installed) {
        btn.disabled = true;
        btn.title = tr('这个版本已经在列表里了');
      } else {
        btn.addEventListener('click', function () { installJavaItem(it); });
      }
      row.appendChild(btn);

      box.appendChild(row);
    });
  }

  /// 点「安装」：交给后端跑，进度进右上角的下载任务列表，
  /// 窗口直接关掉 —— 几百 MB 的东西没必要占着一个弹窗等。
  function installJavaItem(item) {
    call('installJava', item.id);
    closeModal('java-dl-modal');
    toast(tr('已加入下载任务：Java ') + item.jdkVersion + tr('，进度看右上角'));
  }

