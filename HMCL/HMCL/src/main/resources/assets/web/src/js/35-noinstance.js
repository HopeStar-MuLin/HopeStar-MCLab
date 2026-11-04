  // ---------------- 无实例引导 ----------------
  //
  // 没有实例时点「启动游戏 / 打开目录」不静默失败、也不是把按钮灰掉就完事：
  // 弹一个三选一。第三条是重点——很多人电脑上已经有 PCL2 / HMCL 的 .minecraft，
  // 指过去就能用，不用重下十几个 G。

  function openNoInstance() {
    var modal = document.getElementById('noinst-modal');
    if (modal) { modal.classList.remove('hidden'); }
  }

  function closeNoInstance() {
    var modal = document.getElementById('noinst-modal');
    if (modal) { modal.classList.add('hidden'); }
  }

  function initNoInstanceModal() {
    var modal = document.getElementById('noinst-modal');
    if (!modal) { return; }

    var close = document.getElementById('noinst-close');
    if (close) { close.addEventListener('click', closeNoInstance); }
    var cancel = document.getElementById('noinst-cancel');
    if (cancel) { cancel.addEventListener('click', closeNoInstance); }
    // 点遮罩关闭，和别的弹窗一致
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeNoInstance(); }
    });

    var items = modal.querySelectorAll('.noinst-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var kind = this.getAttribute('data-noinst');
        if (kind === 'dir') {
          closeNoInstance();
          // 原生目录选择框在 Java 侧弹，选完由 onGameDirectoryImported 回调
          call('chooseGameDirectory');
          return;
        }
        closeNoInstance();
        go('download');
        switchDownloadTab(kind === 'modpack' ? 'modpack' : 'game');
      });
    }
  }

