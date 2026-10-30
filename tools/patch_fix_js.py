import io, re

p = r'E:\MCLab\HMCL\HMCL\src\main\resources\assets\web\app.js'
s = io.open(p, encoding='utf-8').read()

# 1) 删掉重复的旧 initLoaderModal（带 lm-tabs 的那个）
old_dup = '''  function initLoaderModal() {
    var modal = document.getElementById('loader-modal');
    if (!modal) { return; }

    document.getElementById('lm-close').addEventListener('click', closeLoaderModal);
    document.getElementById('lm-cancel').addEventListener('click', closeLoaderModal);
    document.getElementById('lm-confirm').addEventListener('click', confirmInstall);

    document.getElementById('lm-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-loader]');
      if (b) { selectLoaderType(b.getAttribute('data-loader')); }
    });

    // 点遮罩关闭（点内容不关）
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeLoaderModal(); }
    });
  }

'''
assert old_dup in s, 'duplicate initLoaderModal not found'
s = s.replace(old_dup, '', 1)

# 新版加上「点遮罩关闭」
old_new_tail = '''    document.getElementById('ver-close').addEventListener('click', closeVersionPicker);
    document.getElementById('ver-cancel').addEventListener('click', closeVersionPicker);
  }'''
new_new_tail = '''    document.getElementById('ver-close').addEventListener('click', closeVersionPicker);
    document.getElementById('ver-cancel').addEventListener('click', closeVersionPicker);

    // 点遮罩关闭（点内容不关）
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeLoaderModal(); }
    });
    var ver = document.getElementById('ver-modal');
    if (ver) {
      ver.addEventListener('click', function (e) {
        if (e.target === ver) { closeVersionPicker(); }
      });
    }
  }'''
assert old_new_tail in s, 'new initLoaderModal tail not found'
s = s.replace(old_new_tail, new_new_tail, 1)

# 2) onLoaderVersions 改成填版本小窗
old_cb = '''      if (data.error) {
        lmVersions = [];
        renderLoaderVersions();
        document.getElementById('lm-list').innerHTML = '';
        document.getElementById('lm-list').appendChild(
          el('div', 'lm-empty', '加载器版本拉取失败：' + data.error));
        return;
      }
      lmVersions = data.versions || [];
      // 默认选最新一个，省一次点击
      lmVersion = lmVersions.length ? lmVersions[0] : null;
      renderLoaderVersions();
      if (lmVersion) { document.getElementById('lm-confirm').disabled = false; }'''
new_cb = '''      if (data.error) {
        lmVersions = [];
        var failList = document.getElementById('ver-list');
        if (failList) {
          failList.innerHTML = '';
          failList.appendChild(el('div', 'lm-empty', '加载器版本拉取失败：' + data.error));
        }
        return;
      }
      lmVersions = data.versions || [];
      // 默认高亮最新一个，用户点一下即选中
      lmVersion = lmVersions.length ? lmVersions[0] : null;
      renderVersionPicker();'''
assert old_cb in s, 'onLoaderVersions body not found'
s = s.replace(old_cb, new_cb, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('cleaned')
