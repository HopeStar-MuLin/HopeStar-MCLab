  // ---------------- 百宝箱 ----------------
  //
  // 两个功能：自定义下载（分段并发）+ 清理垃圾文件。
  // 下载进度由 Java 侧每 200ms 推一次，这里只负责画。

  var tbState = { running: false, done: 0, total: 0, fileName: '' };

  function fmtBytes(n) {
    if (!(n > 0)) { return '0 B'; }
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    var v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function renderToolboxProgress(d) {
    var fill = document.getElementById('tb-fill');
    var stage = document.getElementById('tb-stage');
    var pct = document.getElementById('tb-percent');
    if (!fill) { return; }

    if (d.error) {
      fill.style.width = '100%';
      fill.style.background = 'var(--danger)';
      if (stage) { stage.textContent = tr('下载失败：') + d.error; }
      if (pct) { pct.textContent = ''; }
      tbState.running = false;
      return;
    }

    fill.style.background = '';
    var percent = d.total > 0 ? Math.min(100, (d.done / d.total) * 100) : 0;
    fill.style.width = Math.max(d.done > 0 ? 2 : 0, percent) + '%';

    if (stage) {
      if (d.finished) {
        stage.textContent = tr('已保存 ') + (d.fileName || '文件') + '（' + fmtBytes(d.done || d.total) + '）';
      } else if (d.total > 0) {
        stage.textContent = fmtBytes(d.done) + ' / ' + fmtBytes(d.total);
      } else {
        stage.textContent = fmtBytes(d.done) + tr(' 已下载');
      }
    }
    if (pct) {
      pct.textContent = d.total > 0 ? Math.round(percent) + '%' : '';
    }
    if (d.finished) { tbState.running = false; }
  }

  function initToolbox() {
    var start = document.getElementById('tb-start');
    if (start) { start.addEventListener('click', startDownload); }

    var pick = document.getElementById('tb-pick-dir');
    if (pick) {
      pick.addEventListener('click', function () {
        // 后端只会把选中的路径用 toast 报出来（它在 Java 侧拿不到输入框），
        // 所以这里直接弹系统目录选择器并把结果回填到输入框
        apiCall('chooseDownloadFolder', []).then(function (raw) {
          var path = typeof raw === 'string' ? raw : '';
          if (path) { document.getElementById('tb-dir').value = path; }
        });
      });
    }

    var openFolder = document.getElementById('tb-open-folder');
    if (openFolder) {
      openFolder.addEventListener('click', function () {
        var dir = document.getElementById('tb-dir').value.trim();
        call('openPath', dir);
      });
    }

    var clean = document.getElementById('tb-clean');
    if (clean) {
      clean.addEventListener('click', function () {
        var out = document.getElementById('tb-clean-result');
        if (out) { out.textContent = tr('正在清理…'); }
        call('cleanupJunk');
      });
    }

    initMirrorPanel();
  }

