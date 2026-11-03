  // 构建探针：确认页面跑的是这一版脚本（排查缓存问题时一眼定位）
  window.__buildProbe = 'no-autofill-v1';

  // 关掉输入框的「保存的信息」下拉。
  //
  // Chromium 对 autocomplete="off" 经常不理，照样按 name/id 记输入历史，
  // 搜索框一点下去就弹一个盖住半屏的候选框（sodium / Mine in Abyss 那种）。
  // 把 name 换成每次加载都不同的随机值，历史键对不上，候选框就不会再出现。
  function __killAutofill() {
    ['dl-search', 'ad-search'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('name', id + '-' + Math.random().toString(36).slice(2, 8));
      }
    });
  }
  __killAutofill();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', __killAutofill);
  }

  // ---------------- Java 回调入口 ----------------

  window.__hmcl = {
    /// 检查更新的结果：打开弹窗列出可更新项。
    onAddonUpdates: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      finishUpdateCheck();
      if (!d || !d.ok) {
        toast((d && d.error) || tr('检查更新失败'), 'error');
        return;
      }
      showUpdateModal(d);
    },

    /// 批量更新完成：刷新当前标签页的内容列表。
    onAddonUpdatesApplied: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d) { return; }
      if (d.failed) {
        toast(tf('{0} 个已更新，{1} 个失败', d.updated, d.failed), 'error');
      } else {
        toast(tf('{0} 个资源已更新', d.updated), 'ok');
      }
      if (instTab === 'mod' || instTab === 'resourcepack' || instTab === 'shader') {
        // 刚更新过文件，缓存必过期
        loadInstContent(instTab, true);
      }
      if (typeof scanInstanceMods === 'function') { scanInstanceMods(); }
    },

    /// 游戏文件修复完成。
    onGameIntegrityFixed: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || !d.ok) { return; }
      toast(tr('游戏文件已补全'), 'ok');
    },

    /// 系统拖放的三条回调，故意留空。
    ///
    /// 壳模式下 Tauri 自己会发一套拖放事件（60-theme.js 的 initDragDrop），
    /// Java 这边再转发一套，两边同时响应就会让一次拖放走两遍：
    /// 先「正在识别 1 个文件」，再「认不出的格式」，最后才真导入 —— 三个提示。
    /// 统一由 Tauri 那套处理（它带页面判断，能区分纹理和资源）。
    onDragEnter: function (paths) { },

    onDragLeave: function () { },

    onDragDrop: function (paths) { },

    /// 拖放导入的汇总结果
    onDropResult: function (json) { handleDropResult(json); },

    /// 单个镜像测完：只更新那一格，不重排，避免列表来回跳。
    onMirrorProgress: function (json) {
      var r = null;
      try { r = JSON.parse(json); } catch (e) { return; }
      if (!r || !r.id) { return; }
      mirrorResults[r.id] = r;
      mirrorDone++;
      updateMirrorCell(r);
      updateMirrorCount();
      updateFoldSub();
    },

    /// 整轮测速结束：重排、记下最优、刷新提示。
    onMirrorStatus: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || d.busy) { return; }
      mirrorData = d;
      mirrorResults = {};
      (d.results || []).forEach(function (r) { mirrorResults[r.id] = r; });
      mirrorTesting = false;
      mirrorDone = (d.results || []).length;
      renderMirrorGrid();
      updateMirrorCount();
      updateFoldSub();
      updateUrlHint();
      var state = document.getElementById('mirror-state');
      if (state) { state.textContent = ''; }
      toast(tr('测速完成'), 'ok');
    },

    /// 压缩包导入完成（含部分失败）。结果留在弹窗里，用户可以逐条看。
    onArchiveImported: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d) { return; }

      if (d.delegated) {
        importBusy = false;
        closeModal('import-modal');
        toast(tf('已开始安装整合包：{0}', d.name || d.file || ''), 'ok');
        return;
      }

      renderImportResult(d);

      if (d.ok) {
        toast(d.kind === 'instance'
          ? tf('实例「{0}」已导入', d.name || '')
          : tr('导入完成'), 'ok');
        // 内容变了就把当前内容页刷一下（force：刚导入了整包）
        if (INST_KIND_NAMES[instTab]) { loadInstContent(instTab, true); }
      } else {
        toast((d.errors && d.errors[0]) || tr('导入失败'));
      }
    },

    /// 导出完成：把保存路径告诉用户。
    onExportDone: function (json) {
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || !d.ok) { return; }
      toast(tf('{0}已导出到 {1}', tr(d.what || ''), d.path || ''), 'ok');
    },

    /// 整合包更新状态。批量查是全量覆盖，手动检查是单条合并 ——
    /// 手动那条只带一个实例，直接覆盖会把别的实例的角标抹掉。
    onModpackUpdates: function (json) {
      var list = null;
      try { list = JSON.parse(json); } catch (e) { return; }
      if (!list || !list.length) { return; }
      var manual = false;
      list.forEach(function (u) { if (u && u.manual) { manual = true; } });
      if (!manual) { modpackUpdates = {}; }
      list.forEach(function (u) {
        if (!u || !u.instanceId) { return; }
        modpackUpdates[u.instanceId] = u;
        if (!u.manual) { return; }
        if (!u.ok) {
          var reason = u.reason === 'no-source'
            ? '这个实例没有记录安装来源（手动导入或从别处拷来的），没法自动检查更新'
            : (u.reason === 'unknown-version'
              ? '这个实例是本地导入的整合包，不知道当初装的是哪个版本，没法比对'
              : (u.reason || '查不到这个实例的更新信息'));
          toast(tr(reason), 'error');
        } else if (u.hasUpdate) {
          toast(tf('有新版本 {0}', u.latestVersion || ''));
        } else {
          toast(tr('已经是最新版本'));
        }
      });
      renderInstanceGrid();
      renderInstUpdateBar();
    },

    onState: function (json) {
      try { state = JSON.parse(json); } catch (e) { console.error('bad state', e); return; }
      // 动画偏好要在第一次 render 之前生效，否则首屏那次过渡还是全速
      applyAnimSpeed(state.animationSpeed || 'fast');
      document.body.classList.toggle('no-anim', !!state.animationDisabled);
      // 只在用户没手动选过主题时跟随 Java 侧（跟随系统/启动器设置）
      if (state.theme && !savedTheme()) { applyTheme(state.theme, false); }
      render();
      // 选中实例变了，启动器主题也要跟着换
      refreshInstanceThemeIfNeeded();
      // 更新状态单独拉：它要打平台接口，不能挡住首屏。
      // 后端有十分钟缓存，重复调不会一直发请求。
      refreshModpackUpdates(false);
    },
    /// 扫完旧启动器目录：有东西就开弹窗让用户勾选
    onLegacyScanned: function (json) {
      var btn = document.getElementById('set-migrate');
      if (btn) { btn.disabled = false; btn.textContent = tr('选个旧目录'); }
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.cancel) { return; }
      if (!data.ok) { toast(data.error || '这个目录不像启动器的数据目录', 'error'); return; }
      if (!data.accounts && !data.gameDirs && !data.appearance && !data.backgrounds) {
        toast('这里没有账号、皮肤或游戏目录', 'error');
        return;
      }
      legacyScan = data;
      renderLegacy();
      openModal('legacy-modal');
    },
    /// 迁移结果：搬了多少，然后重启。
    ///
    /// 必须重启：账号和游戏目录是启动时读进内存的，而且核心退出时会用内存里那份
    /// 回写文件 —— 不重启的话，导入的内容下次保存就被盖掉了。
    onLegacyImported: function (json) {
      var doBtn = document.getElementById('legacy-do');
      if (doBtn) { doBtn.disabled = false; doBtn.textContent = tr('导入'); }
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      if (!data.ok) { toast(tr('没搬成：') + (data.error || '未知错误'), 'error'); return; }
      closeModal('legacy-modal');

      var bits = [];
      if (data.accounts) { bits.push(data.accounts + tr(' 个账号')); }
      if (data.gameDirs) { bits.push(data.gameDirs + tr(' 个游戏目录')); }
      if (data.appearance) { bits.push(data.appearance + tr(' 张皮肤')); }
      if (data.backgrounds) { bits.push(data.backgrounds + tr(' 张背景图')); }
      var summary = (bits.length ? bits.join('、') + tr('搬过来了') : '选中的东西都搬过来了');

      var tauri = window.__TAURI__;
      if (tauri && tauri.core && tauri.core.invoke) {
        toast(summary + tr('，重启一下'));
        // 只停 250ms：让 toast 有机会画出来就够。
        // 停久了有风险 —— 这段时间里核心要是触发一次保存，会用内存里的旧账号
        // 把刚写进去的文件盖掉。
        setTimeout(function () {
          tauri.core.invoke('restart_app').catch(function () {
            toast(summary + tr('，关掉重开才生效'), 'error');
          });
        }, 250);
      } else {
        toast(summary + tr('，关掉重开才生效'));
      }
    },
    /// 导入已有游戏目录的结果（Java 侧目录选择框选完之后回调）
    onGameDirectoryImported: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      if (!data.ok) {
        toast(tr('导入失败：') + (data.error || '未知错误'), 'error');
        return;
      }
      if (data.versions > 0) {
        toast((data.added ? '已导入 ' : '已切换到 ') + (data.name || data.path)
          + ' · ' + data.versions + tr(' 个版本'));
        // 目录已经切成当前目录，回主页就能看到实例卡片
        go('home');
      } else {
        toast('这个目录里没找到可用的版本，确认选的是 .minecraft 目录', 'error');
      }
    },
    /// 检查更新的结果：有新版就展开更新卡片，没有就一句 toast
    onLauncherUpdate: function (json) {
      var check = document.getElementById('check-update');
      if (check) { check.disabled = false; check.textContent = tr('检查更新'); }
      var payload = null;
      try { payload = JSON.parse(json); } catch (e) { return; }
      if (!payload || !payload.ok) {
        setUpdateStatus('检查失败');
        toast(tr('检查更新失败：') + ((payload && payload.error) || '网络错误'), 'error');
        return;
      }
      var d = payload.data || {};
      updateState.info = d;
      updateState.ready = false;
      var card = document.getElementById('update-card');
      if (!d.hasUpdate) {
        if (card) { card.hidden = true; }
        toast(tr('已经是最新版本 ') + (d.current || ''));
        return;
      }
      var ver = document.getElementById('update-version');
      if (ver) { ver.textContent = tr('当前 ') + (d.current || '?') + tr(' → 最新 ') + (d.latest || '?'); }
      var notes = document.getElementById('update-notes');
      if (notes) { notes.textContent = d.notes || '这次更新没有附说明。'; }
      var now = document.getElementById('update-now');
      if (now) { now.disabled = false; now.textContent = tr('下载更新'); }
      setUpdateBar(null);
      setUpdateStatus('');
      if (card) { card.hidden = false; }
    },

    onLauncherUpdateProgress: function (percent) {
      setUpdateBar(percent);
      setUpdateStatus(tr('正在下载… ') + percent + '%');
    },

    onLauncherUpdateReady: function () {
      updateState.ready = true;
      var now = document.getElementById('update-now');
      if (now) { now.disabled = false; now.textContent = tr('重启并安装'); }
      setUpdateStatus('下载完成，点右边重启安装');
    },

    onNewsDetail: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderNewsDetail(data);
    },

    onNews: function (json) {
      try { news = JSON.parse(json); } catch (e) { news = { error: String(e) }; }
      renderNews();
    },
    onToast: function (text) {
      // Java 侧的 Controllers.showToast 会落到这里
      toast(text);
    },
    onAddonSearch: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.type !== adType) { return; }
      // 过期响应（用户已经又点了别的类别 / 又翻了一页）直接丢弃
      if (data.reqId != null && String(data.reqId) !== String(adReqSeq)) { return; }
      // 成功的结果才缓存，报错（网络/限流）下次还要重试
      if (!data.error) { cachePut(adSearchCache, addonSearchKey(), data); }
      applyAddonSearch(data);
    },

    onAddonCategories: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.type) { return; }
      // 缓存按「类型|平台」分开：两家的分类表不是一套东西
      var key = data.type + '|' + (data.source || 'modrinth');
      // 报错不缓存，下次切回来还会重试（网络抖动时不该永久空着）
      if (!data.error) { adCatCache[key] = data.groups || []; }
      // 回来的是别的类型/平台的表就丢掉：连点切页时会有好几个请求在飞
      if (key !== adCatKey()) { return; }
      adCatGroups = adCatCache[key] || [];
      renderAddonCategories();
    },

    /// 实例被改名了（from / to 都是实例 id）。
    ///
    /// 实例 id 就是目录名，改名之后旧 id 立刻失效。前端如果还停在那个实例页上，
    /// 必须换成新 id 重进一次，否则页面会一直显示一个已经不存在的实例。
    /// 百宝箱下载进度（Java 侧每 200ms 推一次）
    onToolboxProgress: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      renderToolboxProgress(data);
    },

    /// 清理结果：删了多少个文件、释放了多少空间
    onCleanupResult: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      var out = document.getElementById('tb-clean-result');
      if (!out || !data) { return; }
      if (!data.count) {
        out.textContent = tr('没有可清理的内容');
      } else {
        out.textContent = tr('清掉 ') + data.count + tr(' 个文件，释放 ') + fmtBytes(data.freed);
      }
    },

    onInstanceRenamed: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.to) { return; }
      if (instId === data.from) {
        showInstancePage(data.to);
      }
    },

    onInstanceDetail: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.error) { return; }
      if (data.id && instId && data.id !== instId) { return; }
      instData = data;
      renderInstanceDetail(data);
    },

    onInstanceAddons: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderAddons(data);
    },

    /// 依赖检查点「安装」时，mod id 解析成 Modrinth 项目之后回到这里。
    /// 直接把模组页那套版本弹窗打开，选哪个版本、装到哪，行为和手动装模组完全一样。
    onAddonResolved: function (json) {
      var dep = pendingDep;
      pendingDep = null;
      if (dep && dep.btn) {
        dep.btn.disabled = false;
        dep.btn.textContent = tr('安装');
      }
      var d = null;
      try { d = JSON.parse(json); } catch (e) { return; }
      if (!d || !d.ok) {
        toast(tf('没找到「{0}」，去模组页搜一下', d && d.modId ? d.modId : ''), 'error');
        return;
      }
      adType = 'mod';
      if (instId) { adInstPicked['mod'] = instId; }
      openAddonVersions({ slug: d.slug, title: d.title || d.modId, icon: d.icon });
    },
    onLoginStage: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.flow !== 'microsoft') { return; }
      document.getElementById('lm-stage').textContent = data.stage || '';
    },

    /// 微软设备码：用户码 + 验证地址。
    /// 壳里没有 MicrosoftAccountLoginPane，事件没人订阅，所以由 Java 侧补了一次
    /// （WebBridge.hookMicrosoftDeviceCode），这里负责把它显示出来。
    onMicrosoftCode: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || data.flow !== 'microsoft') { return; }
      var box = document.getElementById('lm-code-box');
      var code = document.getElementById('lm-code');
      var url = document.getElementById('lm-url');
      var open = document.getElementById('lm-open');
      if (code) { code.textContent = data.code || '----'; }
      if (url && data.url) {
        url.textContent = data.url;
        url.setAttribute('href', data.url);
      }
      if (box) { box.hidden = false; }
      if (open) {
        open.hidden = false;
        open.onclick = function () {
          if (data.url) { call('openLink', data.url); }
        };
      }
      var stage = document.getElementById('lm-stage');
      if (stage) { stage.textContent = tr('在浏览器打开下面的地址，输入这个代码：'); }
    },

    onLoginResult: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      // 走到这里说明这次登录已经结束（不论成败），再点关闭就不该发取消指令了
      if (data.flow === 'microsoft') { msLoginActive = false; }
      if (data.ok) {
        hideModal('login-offline');
        hideModal('login-ms');
        hideModal('login-authlib');
        toast(tr('已登录：') + (data.message || ''));
        return;
      }
      // 失败：外置认证重新打开弹窗，让用户改完直接重试
      toast(data.flow === 'offline' ? (tr('离线登录失败：') + data.message)
        : data.flow === 'microsoft' ? (tr('微软登录失败：') + data.message)
          : (tr('外置认证失败：') + data.message), 'error');
      if (data.flow === 'microsoft') {
        document.getElementById('lm-stage').textContent = data.message || '登录失败';
      }
    },

    onAuthlibServers: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }
      var list = [];
      try { list = typeof data.servers === 'string' ? JSON.parse(data.servers) : (data.servers || []); } catch (e) { list = []; }
      renderAuthlibServers(list);
      var hint = document.getElementById('la-add-hint');
      if (data.ok) {
        if (hint) { hint.textContent = tr('名称等信息会自动从皮肤站读取'); }
        document.getElementById('la-url').value = '';
        document.getElementById('la-add').hidden = true;
      } else if (data.error && hint) {
        hint.textContent = data.error;
      }
    },

    onAppearance: function (json) {
      try {
        var data = JSON.parse(json);
        // Gson 默认不输出 null 字段，`pendingServerCape` 是 null 时整条就没了，
        // 前端读出来是 undefined，而下面各处判的是 `=== null`：
        // 结果「无披风」和「已装备」都不高亮，一个 current 都没有。这里补回 null。
        if (data && data.pendingServerCape === undefined) { data.pendingServerCape = null; }
        // 换账号了：上一个账号的服务器披风列表和图片全部作废。
        // 不清的话切到另一个号会先闪一排别人的披风，图还是错的那种。
        var uuid = (data && data.accountId) || '';
        if (uuid !== apAccountUuid) {
          apAccountUuid = uuid;
          serverCapes = null;
        }
        renderAppearance(data);
      } catch (e) { console.error(e); }
    },
    onInstanceInstallers: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !imInstanceId) { return; }
      // 标题上的版本号用 manifest 里真实的游戏版本，
      // 实例列表里的 gameVersion 字段偶尔是空的（比如手动放进 versions 目录的）
      if (data.gameVersion) {
        lmGame = data.gameVersion;
        document.getElementById('im-version').textContent = data.gameVersion;
      }
      imInstalled = {};
      (data.installed || []).forEach(function (it) {
        if (it && it.id) { imInstalled[it.id] = it.version || ''; }
      });
      renderInstallerCards();
    },
    onJavaList: function (json) {
      var list = null;
      try { list = JSON.parse(json); } catch (e) { return; }
      renderJavaList(list);
    },

    /// 可安装的 Java 列表（foojay）
    onJavaInstallable: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      renderJavaDownloadList(data);
    },

    onSettings: function (json) {
      try { renderSettings(JSON.parse(json)); } catch (e) { console.error('bad settings', e); }
    },
    onPreview: function (dataUrl) {
      // 壳模式下 3D 由前端 skinview3d 接管，后端那张 PNG 直接丢掉
      if (viewer) { return; }
      var img = document.getElementById('ap-preview');
      if (img && dataUrl) { img.src = dataUrl; }
    },
    onCapePreview: function (id, dataUrl, raw) {
      if (!serverCapes || !dataUrl) { return; }
      var hit = null;
      for (var i = 0; i < serverCapes.length; i++) {
        if (serverCapes[i].id === id) {
          serverCapes[i].preview = dataUrl;
          // 展开图给 3D 用：缩略图是拼好的正面剪影，贴不到模型上
          if (raw) { serverCapes[i].raw = raw; }
          hit = serverCapes[i];
          break;
        }
      }
      if (!hit) { return; }
      // 图到手了，重跑一次 3D 同步——正版账号当前装备的那件披风全靠这张图
      syncViewer();
      // 只换这一张卡的图，不重建整个网格，避免列表在眼前闪一下
      var cards = document.querySelectorAll('#asset-grid .asset-card');
      for (var k = 0; k < cards.length; k++) {
        if (cards[k].getAttribute('data-asset-id') === id) {
          var img = cards[k].querySelector('.asset-well img');
          if (img) { img.src = dataUrl; img.classList.remove('asset-placeholder'); }
          break;
        }
      }
    },
    onVersions: function (json) {
      try { dlVersions = JSON.parse(json); } catch (e) { console.error('bad versions', e); return; }
      dlLoadError = '';
      // 新清单到了就回第一页：刷新后还停在旧页码上，用户会以为列表没更新
      dlPage = 0;
      renderDownloadList();
    },
    /// 某个加载器在当前游戏版本下有没有可安装的版本。
    /// 打开安装弹窗时后端会为每个类型推一条，卡片按它决定能不能点。
    onInstallerSupport: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.type || data.game !== lmGame) { return; }
      onInstallerSupport(data.type, data.state || 'ok');
    },
    onLoaderVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      // 用户可能已经切到别的类型或别的版本，过期响应直接丢掉
      if (!data || data.game !== lmGame || data.type !== verTargetType) { return; }
      if (data.error) {
        // 明确失败：清空列表并让底部出现「重新拉取」。这里不能退化成空列表，
        // 否则界面上显示「这个游戏版本没有可用的 X 版本」，用户会以为真没有。
        lmVersions = null;
        lmVersionRows = [];
        verLoadError = fetchErrorMessage(data.error);
        renderVersionPicker();
        return;
      }
      verLoadError = '';
      lmVersionRows = normalizeVersionRows(data.versions);
      lmVersions = lmVersionRows.map(function (row) { return row.v; });
      // 不再在这里写 lmVersion：静默预选一个版本、用户直接点「安装」
      // 会把一个他从没确认过的版本装上。预选高亮交给 renderVersionPicker，
      // 真正落盘只发生在 commitVersionPick。
      renderVersionPicker();
    },
    /// 附属组件的版本清单到了。结构比加载器那条多一个 type，
    /// 复用同一个版本弹窗渲染。
    /// 版本清单到了。**两个弹窗共用这一个回调**，靠载荷形状分流：
    /// 下载页的「选择版本」带 `items`，实例页的附属组件（加载器 / 附属）带 `versions`。
    ///
    /// 以前这里写了两份同名的 `onAddonVersions`，对象字面量后定义的覆盖前面那份，
    /// 结果下载页点开版本列表永远停在「正在拉取版本…」—— 回调被另一个弹窗的分支吃掉了。
    onAddonVersions: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }

      // 下载页：选版本 → 下载
      if (data.items && data.type === adType) {
        if (data.error) {
          var list = document.getElementById('adver-list');
          list.innerHTML = '';
          list.appendChild(el('div', 'adver-empty', friendlyError(data.error)));
          return;
        }
        var items = data.items;
        if (adTarget) { cachePut(adVersionCache, addonVersionKey(adTarget.slug), items); }
        setAdverVersions(items, data.total || items.length);
        return;
      }

      // 实例页：给加载器 / 附属组件挑版本
      if (data.type === verTargetType && verTargetIsAddon) {
        if (data.error) {
          lmVersions = null;
          lmVersionRows = [];
          verLoadError = fetchErrorMessage(data.error);
          renderVersionPicker();
          return;
        }
        verLoadError = '';
        lmVersionRows = normalizeVersionRows((data.versions || []).map(function (v) {
          return { v: v.version, date: v.date || 0 };
        }));
        lmVersions = lmVersionRows.map(function (row) { return row.v; });
        renderVersionPicker();
      }
    },
    /// 启动进度。壳模式下看不到 JavaFX 的启动对话框，靠这条通道把阶段画出来。
    /// 具体处理在 87b-launch-progress.js，这里只做转发，避免加载顺序问题。
    onLaunchProgress: function (json) {
      if (window.__launchProgress) { window.__launchProgress(json); }
    },

    /// 游戏进程退出。启动器如果因为「隐藏，游戏退出后再打开」被收起来了，这里恢复。
    onGameExit: function () {
      if (window.__launchShowWindow) { window.__launchShowWindow(); }
    },

    onInstallTitle: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data || !data.id || !data.title) { return; }
      if (!dlTasks[data.id]) {
        dlTasks[data.id] = { title: data.title, stage: '', percent: -1 };
      } else {
        dlTasks[data.id].title = data.title;
      }
      updateDownloadButton();
      if (dlPopoverOpen) { renderDownloadPopover(); }
    },

    /// 任务进度。所有下载 / 安装都走这一条，统一进右上角的任务列表。
    ///
    /// 以前还有一条「下载页顶部进度条」，两条通道各写各的，于是出现
    /// 「任务没进列表、只在页面顶上漂一行红字」这种割裂感。现在只有列表。
    onInstallStage: function (json) {
      var data = null;
      try { data = JSON.parse(json); } catch (e) { return; }
      if (!data) { return; }

      // 拉版本清单结束也走这个通道，但它不是一次下载。
      // 失败必须在这里处理：只 return 的话页面会永远停在「正在拉取版本清单…」，
      // 用户看不到任何原因，也没有重试入口。
      if (data.kind === 'versions') {
        // 不看 done：后端最后一轮失败时会把 done 置 true，但只要有 error 就说明
        // 这一轮没成，界面就该给出重试入口
        if (data.error) {
          dlLoadError = String(data.error);
          renderDownloadList();
        }
        return;
      }

      if (!data.id) {
        updateDownloadButton();
        return;
      }

      var id = data.id;
      var prev = dlTasks[id];

      if (data.done) {
        if (data.error) {
          // 失败：留在列表里让用户看清原因，带 ✕ 手动移除
          // 后端有时给的是已经带了「安装失败：」前缀的文案，有时是裸异常。
          // 裸异常（NullPointerException 之类）直接甩给用户没意义，前面补一句人话
          var msg = String(data.error);
          if (msg === 'cancelled' || msg === '已取消') {
            // 用户自己点的取消，不算失败
            msg = '已取消';
          } else if (!/^(安装|下载|创建)?失败/.test(msg.slice(0, 12))) {
            msg = tr('下载失败：') + msg;
          }
          dlTasks[id] = {
            title: (prev && prev.title) || id,
            stage: '',
            percent: -1,
            kind: prev && prev.kind,
            paused: false,
            error: msg
          };
          dlInstalling = null;
        } else {
          // 成功：先把进度推满，900ms 后移除——直接删会让人看不到条走完
          var doneTitle = (prev && prev.title) || id;
          if (prev) { prev.percent = 1; prev.stage = '已完成'; }
          dlInstalling = null;
          notifyDone(doneTitle);
          setTimeout(function () {
            delete dlTasks[id];
            renderDownloadPopover();
            updateDownloadButton();
          }, 900);
        }
      } else {
        // 先判断「是不是新任务」再动 prev：下面 next 和 prev 是同一个对象，
        // 改完 stage 再判断就永远是 false，列表也就永远不自动弹出
        var isNew = !prev || (!prev.stage && prev.percent < 0);
        var next = prev || { title: '', stage: '', percent: -1, filesDone: -1, filesTotal: -1 };
        // 进度条只许向前。后端已经把子任务的抽搐百分比聚合成一条单调进度，
        // 这里再兜一道：任何回退（重连、乱序到达）都丢掉，条永远不会倒着走。
        if (typeof data.percent === 'number' && data.percent >= 0) {
          var last = typeof next.percent === 'number' ? next.percent : -1;
          next.percent = data.percent > last ? data.percent : last;
        }
        // 大批量拉取的文件计数。total 为 -1/0 表示这一段没有总数，不显示分母。
        var fd = typeof data.filesDone === 'number' ? data.filesDone : -1;
        var ft = typeof data.filesTotal === 'number' ? data.filesTotal : -1;
        if (ft > 0) {
          next.filesDone = fd;
          next.filesTotal = ft;
        } else {
          next.filesDone = -1;
          next.filesTotal = -1;
        }
        if (data.stage) { next.stage = data.stage; }
        // kind 决定任务行给不给暂停按钮；paused 决定按钮画 ⏸ 还是 ▶
        if (data.kind) { next.kind = data.kind; }
        next.paused = !!data.paused;
        next.error = null;
        dlTasks[id] = next;
        dlInstalling = id;

        // 新任务：自动把列表弹出来，否则点完安装只有一个按钮在动，看不出发生了什么
        if (isNew && !dlPopoverOpen) { setDownloadPopover(true); }
      }

      updateDownloadButton();
      // 关着也刷新一遍：下次点开就是最新状态，不会先闪一帧旧的
      renderDownloadPopover();

      if (!data.done && dlVersions) {
        // 装到一半时把列表里那一行标成「安装中…」
        renderDownloadList();
      }
      if (data.done && !data.error && dlVersions) {
        (dlVersions.versions || []).forEach(function (v) {
          if (v.id === id) { v.installed = true; }
        });
        renderDownloadList();
      }
    },
    onInstallFinished: function (id) {
      dlInstalling = null;
      renderDownloadList();
      call('refresh');
    },

    /// 启动前检查的结果。有问题的实例才会走到这里 —— 没问题的后端直接启动。
    /// 前端不做二次判断，弹窗内容就是后端给的那两条列表。
    onLaunchCheck: function (json) {
      // 后端约定传 JSON 文本，但收到对象时也认（推送格式改过一次，别再踩）
      var d = null;
      try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
      if (d) { openLaunchCheck(d); }
    },

    /// 游戏退出。自动备份和时长统计都在后端做完了，这里只负责说一句
    /// 并刷新状态（首页的「上次启动」和时长变了）。
    onGameExited: function (json) {
      var d = null;
      try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { return; }
      if (!d) { return; }

      var n = (d.backups || []).length;
      var skipped = (d.skipped || []).length;
      if (d.backupError) {
        toast(tf('存档备份失败：{0}', d.backupError), 'error');
      } else if (d.crashed) {
        toast(n ? tf('游戏异常退出，已备份 {0} 个存档', n) : tr('游戏异常退出'), 'error');
      } else if (n) {
        toast(tf('已自动备份 {0} 个存档', n), 'ok');
      }
      if (skipped) {
        toast(tf('{0} 个存档超过大小限制，未备份', skipped), 'error');
      }
      call('refresh');
    },
    onServerCapes: function (json) {
      var fresh = null;
      try { fresh = JSON.parse(json || '[]'); } catch (e) { fresh = []; }
      if (!Array.isArray(fresh)) { fresh = []; }

      // 后端那份列表缓存只存 id / name / url / active，**不含 preview**。
      // 切标签、切账号回来时走的是缓存分支，只推这个列表、不重推图片，
      // 直接赋值的话整排卡片立刻变紫块（图是异步一张张到的，早丢了）。
      // 手里已有的图按 id 接回去，图还在就不用重下。
      var keep = {};
      (serverCapes || []).forEach(function (c) {
        if (c && c.preview) { keep[c.id] = c; }
      });
      fresh.forEach(function (c) {
        var old = keep[c.id];
        if (old) {
          c.preview = old.preview;
          if (old.raw) { c.raw = old.raw; }
        }
      });

      serverCapes = fresh;
      if (apData) { renderAppearance(apData); }
    }
  };

  // ---------------- 启动 ----------------

  document.addEventListener('native-ready', function () {
    initUi();
    var raw = call('getState');
    if (raw) { window.__hmcl.onState(raw); }
    call('requestNews');
  });

  // 没有 Java 桥时（直接用浏览器打开调样式）用兜底数据
  setTimeout(function () {
    if (bridge()) { return; }
    initUi();
    window.__hmcl.onState(JSON.stringify({
      account: { uuid: 'demo', name: 'Steve', channel: '微软登录', avatar: null },
      accounts: [
        { uuid: 'demo', name: 'Steve', channel: '微软登录', avatar: null, selected: true },
        { uuid: 'demo2', name: 'Alex', channel: 'LittleSkin', avatar: null, selected: false }
      ],
      selected: '1.21.1-fabric',
      instances: [
        { id: '1.21.1-fabric', name: '1.21.1-Fabric', gameVersion: '1.21.1', loader: 'Fabric', loaderVersion: '0.16.5', java: '21', size: 1288490188, lastLaunch: Date.now() - 3600e3, isModpack: false },
        { id: '1.20.1-forge', name: '1.20.1-Forge', gameVersion: '1.20.1', loader: 'Forge', loaderVersion: '47.2.0', java: '17', size: 1027604480, lastLaunch: Date.now() - 86400e3, isModpack: false },
        { id: 'gtnh', name: 'GTNH 2.7', gameVersion: '1.7.10', loader: 'Forge', loaderVersion: '10.13.4', java: '8', size: 6657199308, lastLaunch: Date.now() - 5 * 86400e3, isModpack: true },
        { id: '1.21.4-neoforge', name: '1.21.4-NeoForge', gameVersion: '1.21.4', loader: 'NeoForge', loaderVersion: '21.4.20', java: '21', size: 734003200, lastLaunch: 0, isModpack: false }
      ],
      iconTypes: [],
      theme: 'light',
      env: 'standalone preview'
    }));
    window.__hmcl.onNews(JSON.stringify({ items: [
      { title: 'Minecraft 26.4 Snapshot 6', summary: 'Kai is ice fishing, sitting on a light blue cushion…', date: Date.now() - 7200e3 },
      { title: 'Minecraft 1.21.10', summary: 'Stability fixes and a new block variant.', date: Date.now() - 3 * 86400e3 }
    ] }));
  }, 60);
})();
