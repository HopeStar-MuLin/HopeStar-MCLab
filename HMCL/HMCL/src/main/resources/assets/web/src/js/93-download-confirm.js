  // ---------------- 下载确认 ----------------
  //
  // 两件事合在一个弹窗里：文件名可改；有实例就直接进它的 mods 目录，
  // 没实例就当场让用户挑一个目录。

  var dlcItem = null;
  var dlcVersion = null;

  function openDownloadConfirm(item, version) {
    if (!item || !version) { return; }
    dlcItem = item;
    dlcVersion = version;

    var isPack = adType === 'modpack';
    // 世界是 zip，进来要解压成 saves/<名字>/。让用户改 zip 文件名没有意义，
    // 目录名由压缩包里的存档名决定（AddonService.uniqueSaveName 处理重名）。
    var isWorld = adType === 'world';
    document.getElementById('dlc-name-field').hidden = isPack || isWorld;
    document.getElementById('dlc-name2-field').hidden = !isPack;
    document.getElementById('dlc-dir-field').hidden = isPack;

    var sum = document.getElementById('dlc-summary');
    sum.innerHTML = '';
    if (item.iconUrl) {
      var img = document.createElement('img');
      img.src = item.iconUrl;
      sum.appendChild(img);
    }
    var main = el('div', 'dlc-sum-main');
    main.appendChild(el('strong', null, item.title || ''));
    var sub = [version.name || version.version || ''];
    if (version.loaders && version.loaders.length) {
      sub.push(version.loaders.map(loaderLabel).join(' / '));
    }
    if (version.size > 0) { sub.push(fmtSize(version.size)); }
    main.appendChild(el('span', null, sub.join(' · ')));
    sum.appendChild(main);

    if (isPack) {
      // 默认填整合包的名字，不要留空。
      // 留空时后端会退回到 version.name —— 而 Modrinth 的 version.name 经常就是
      // "1.0.4" 这样的纯版本号，装完实例列表里一排数字，根本看不出是哪个整合包。
      document.getElementById('dlc-name2').value = item.title || '';
    } else {
      document.getElementById('dlc-name').value = version.filename || '';
      var instId = AD_INSTANCE_TYPES[adType] ? adInstId() : '';
      var browse = document.getElementById('dlc-browse');

      if (instId) {
        // 有实例：默认落到实例目录，用户不用自己挑；但按钮照样给——
        // 「先下到桌面、回头自己拷」是真实需求，锁死位置只会逼人绕一圈。
        setDlcDir('');
        browse.hidden = false;
        browse.textContent = tr('更改…');
        apiCall('addonTargetDirectory', [adType, instId]).then(function (dir) {
          if (dlcItem === item && typeof dir === 'string' && dir) {
            setDlcDir(dir);
          }
        });
      } else {
        // 没实例：位置留空让用户自己挑。
        // 不在这里自动弹选择框——一进来就跳一个系统窗口太打扰，
        // 而且用户可能想先改文件名。点「浏览…」或「开始下载」时再弹。
        browse.hidden = false;
        browse.textContent = tr('浏览…');
        setDlcDir('');
      }
    }

    document.getElementById('dlc-modal').classList.remove('hidden');
    setTimeout(function () {
      var f = isPack ? document.getElementById('dlc-name2') : document.getElementById('dlc-name');
      if (f) { f.focus(); }
    }, 50);
  }

  /// 路径中间省略。
  ///
  /// <p>头尾都比中间有用：开头是盘符（判断落在哪个盘），结尾是最后一级目录
  /// （mods / shaderpacks / 实例名）。只截尾部的话，用户永远看不到自己下到哪儿。
  function middleEllipsis(text, head, tail) {
    var s = String(text || '');
    if (s.length <= head + tail + 1) { return s; }
    return s.slice(0, head) + '…' + s.slice(s.length - tail);
  }

  /// 写保存位置。值存在隐藏 input 里（提交时要原始路径），显示的是省略过的版本。
  function setDlcDir(dir) {
    var value = dir ? String(dir) : '';
    var input = document.getElementById('dlc-dir');
    if (input) { input.value = value; }
    var view = document.getElementById('dlc-path');
    if (view) {
      view.textContent = value ? middleEllipsis(value, 20, 34) : tr('还没选保存位置');
      view.title = value;
      view.classList.toggle('empty', !value);
    }
  }

  function getDlcDir() {
    var input = document.getElementById('dlc-dir');
    return input ? input.value.trim() : '';
  }

  function closeDownloadConfirm() {
    document.getElementById('dlc-modal').classList.add('hidden');
    dlcItem = null;
    dlcVersion = null;
  }

  /// 打开系统目录选择框，选中后写回保存位置。
  function chooseSaveDirectory() {
    if (!apiBase()) {
      toast(tr('壳模式下才能弹目录选择框'));
      return;
    }
    apiCall('chooseDirectory', ['选择保存位置']).then(function (value) {
      var dir = value ? String(value) : '';
      if (dir) { setDlcDir(dir); }
    });
  }

  function confirmDownload() {
    var item = dlcItem;
    var v = dlcVersion;
    if (!item || !v) { return; }

    if (adType === 'modpack') {
      var name = document.getElementById('dlc-name2').value.trim();
      closeDownloadConfirm();
      closeAddonVersions();
      call('installModpackRemote', item.slug, v.versionId, item.iconUrl || '', name);
      toast(tf('开始下载整合包「{0}」', item.title));
      return;
    }

    var dir = getDlcDir();
    var fileName = document.getElementById('dlc-name').value.trim();
    var instId = AD_INSTANCE_TYPES[adType] ? adInstId() : '';

    if (!dir) {
      // 没选位置就别开始：默认落到游戏根目录会让人找不到下到哪儿去了
      chooseSaveDirectory();
      return;
    }

    closeDownloadConfirm();
    closeAddonVersions();
    // 传填在框里的那个目录。有实例时它就是实例目录（后端算好推过来的），
    // 用户点「更改…」换过之后也能生效——原来这里写的是 instId ? '' : dir，
    // 把用户的更改直接丢掉了。
    call('addonInstall', adType, item.slug, v.versionId, instId, fileName, dir);
    toast(tf('开始下载「{0}」', item.title + ' ' + (v.version || v.versionId)));
  }

  /// 本地导入：File 对象直接当 fetch 的 body 传上去，Java 侧流式落盘。
  /// 不走 base64 —— 几百 MB 的整合包转成字符串会把内存吃光。
  function importLocalAddon() {
    // 整合包走「系统对话框 + 直接给后端路径」：不要经过 HTTP 上传，
    // 一个几百 MB 的包上传等于白拷两份。装完由后端推任务进度。
    if (adType === 'modpack') {
      call('pickModpackFile');
      return;
    }
    var kind = adType === 'world' ? 'world'
      : adType === 'shader' ? 'shader'
        : adType === 'resourcepack' ? 'resourcepack' : 'modpack';

    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,.mrpack';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) { return; }
      uploadLocalAddon(kind, f);
    });
    input.click();
  }

  function uploadLocalAddon(kind, file) {
    if (!apiBase()) {
      toast(tr('本地导入只在壳模式可用'));
      return;
    }

    var url = apiEndpoint('/api/upload/' + kind, {
      name: file.name,
      instanceId: adInstId()
    });

    toast(tr('正在上传 ') + file.name + '（' + Math.round(file.size / 1048576) + ' MB）…');

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { toast(tr('上传失败：') + ((j && j.error) || '未知错误'), 'error'); }
      })
      .catch(function (e) { toast(tr('上传失败：') + e, 'error'); });
  }

