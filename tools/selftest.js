/* 发行包功能自检：CDP 驱动真实界面，逐项断言 + 截图。
 *
 * 前提：壳是 debug 构建（开了 9222），且已启动到首页。
 * 用法：node tools/selftest.js [--out tools/build/selftest] [--only 关键词]
 *
 * 退出码 0 = 全过；1 = 有用例失败（失败项会打出来，截图留在 --out 目录）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const CDP = 'http://127.0.0.1:9222';
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const OUT = path.resolve(argOf('--out', 'tools/build/selftest'));
const ONLY = argOf('--only', '');
/* 游戏目录：启动测试要读 versions/<id>/logs/latest.log */
const MC_DIR = path.resolve(argOf('--mc', 'dist-package/release/.minecraft'));

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get(CDP + p, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = []; }

  static async connect() {
    const targets = await getJson('/json');
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('没有找到页面 target（壳没起来或不是 debug 构建）');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const c = new Cdp(ws);
    await new Promise(r => ws.addEventListener('open', r));
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        c.errors.push('未捕获异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        c.errors.push('console.error: ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
    });
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    return c;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    return r.result.value;
  }

  /* 网络请求慢（Mojang 清单、Modrinth 搜索），固定 sleep 会误判，统一轮询 */
  async waitFor(expr, timeout = 25000, label = '') {
    const t0 = Date.now();
    for (;;) {
      let v = false;
      try { v = await this.eval(expr); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('等超时' + (label ? '：' + label : '') + '（' + timeout + 'ms）');
      await sleep(300);
    }
  }

  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }
}

/* 注入到页面里的抓手。只放纯函数，别碰业务状态。 */
const HELPERS = `
window.__st = {
  go(p) {
    const el = document.querySelector('[data-page="' + p + '"]');
    if (!el) throw new Error('导航里没有 ' + p);
    el.click();
    return true;
  },
  q(s) { return document.querySelector(s); },
  qa(s) { return [...document.querySelectorAll(s)]; },
  n(s) { return this.qa(s).length; },
  txt(s) { const e = this.q(s); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null; },
  click(s) { const e = this.q(s); if (!e) throw new Error('找不到 ' + s); e.click(); return true; },
  shown(s) {
    const e = this.q(s);
    if (!e) return false;
    if (e.hidden) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },
  rows(s) { return this.qa(s).map(e => e.textContent.replace(/\\s+/g, ' ').trim()); },
  openInst(n) {
    this.go('instances');
    const rows = this.qa('#instance-table > .table-row').filter(r => !r.classList.contains('head'));
    if (!rows[n || 0]) throw new Error('没有第 ' + (n || 0) + ' 个实例');
    rows[n || 0].click();
    return true;
  }
};
'ok'
`;

const steps = [];
const step = (name, fn) => steps.push({ name, fn });

/* ---------------- 首页 ---------------- */
step('首页渲染', async (c) => {
  await c.eval(HELPERS);
  await c.eval(`__st.go('home')`);
  await c.waitFor(`__st.n('#instance-grid .instance-card') > 0`, 8000, '实例卡片');
  const j = JSON.parse(await c.eval(`JSON.stringify({
    title: document.title,
    hero: __st.txt('#hero-name'),
    loader: __st.txt('#hero-loader'),
    cards: __st.n('#instance-grid .instance-card'),
    news: __st.n('#news-list > *')
  })`));
  if (j.title !== 'HopeStar-MCLab') throw new Error('窗口标题是 ' + j.title);
  if (!j.hero) throw new Error('主卡片没有实例名');
  return `标题 ${j.title} / 主卡片 ${j.hero}(${j.loader}) / ${j.cards} 个卡片 / ${j.news} 条动态`;
});

/* ---------------- 实例列表 ---------------- */
step('实例列表', async (c) => {
  await c.eval(`__st.go('instances')`);
  await c.waitFor(`__st.n('#instance-table > .table-row') >= 2`, 6000, '实例表格');
  const rows = await c.eval(`__st.n('#instance-table > .table-row')`);
  return `${rows} 行（含表头）`;
});

/* ---------------- 首页卡片上的 ⚙ ---------------- */
step('首页卡片设置按钮进管理页', async (c) => {
  await c.eval(`__st.go('home')`);
  await c.waitFor(`__st.n('.instance-card .icon-manage') >= 2`, 6000, '卡片按钮');
  const name = await c.eval(`__st.qa('.instance-card .instance-name')[1].textContent.trim()`);
  await c.eval(`__st.qa('.instance-card .icon-manage')[1].click()`);
  await c.waitFor(`document.getElementById('page-instance').classList.contains('on')`, 8000, '实例页');
  const title = await c.eval(`__st.txt('#inst-title')`);
  const modal = await c.eval(`__st.shown('#loader-modal')`);
  if (modal) throw new Error('还是弹出了安装弹窗');
  if (title !== name) throw new Error('打开的是「' + title + '」，卡片是「' + name + '」');
  return `点「${name}」的 ⚙ → 进它的管理页，没弹安装窗`;
});

/* ---------------- 快速游玩存档下拉：不能被反复重建 ---------------- */
step('快速游玩存档下拉不重绘', async (c) => {
  await c.eval(`__st.openInst(0)`);
  await c.waitFor(`!!document.getElementById('inst-quick-sp')`, 10000, '存档下拉');
  await sleep(800);
  await c.eval(`window.__spNode = document.querySelector('#inst-quick-sp option')`);
  const boxBefore = await c.eval(`document.getElementById('inst-not-check-jvm').checked`);
  // 切一下无关开关，逼后端保存并回推一次状态（就是这条路径把下拉刷没了）
  await c.eval(`__st.click('#inst-not-check-jvm')`);
  await sleep(2200);
  const same = await c.eval(`(function(){
    var n = document.querySelector('#inst-quick-sp option');
    return { same: !!(window.__spNode && n && n === window.__spNode), connected: !!(window.__spNode && window.__spNode.isConnected) };
  })()`);
  const boxAfter = await c.eval(`document.getElementById('inst-not-check-jvm').checked`);
  await c.eval(`__st.click('#inst-not-check-jvm')`);
  await sleep(1200);
  const boxRestored = await c.eval(`document.getElementById('inst-not-check-jvm').checked`);
  if (boxAfter === boxBefore) throw new Error('测试用的开关没切换成功');
  if (boxRestored !== boxBefore) throw new Error('开关没还原');
  if (!same.same) throw new Error('状态回推后存档下拉被重建了（' + JSON.stringify(same) + '）');
  return '回推一次状态，option 节点没被替换';
});

/* ---------------- 实例详情：7 个 tab ---------------- */
step('实例详情 7 个 tab', async (c) => {
  await c.eval(`__st.openInst(0)`);
  await c.waitFor(`document.getElementById('page-instance').classList.contains('on')`, 8000);
  await c.waitFor(`!!__st.txt('#inst-version')`, 10000, '实例信息');
  const head = JSON.parse(await c.eval(`JSON.stringify({t:__st.txt('#inst-title'),v:__st.txt('#inst-version'),l:__st.txt('#inst-loader'),d:__st.txt('#inst-dir')})`));

  // 设置 / 加载器 各有一个独立面板，其余 5 个共用 #itab-content
  const bad = [];
  await c.eval(`__st.click('#inst-nav [data-itab="settings"]')`);
  await sleep(300);
  if (!await c.eval(`__st.shown('#itab-settings')`)) bad.push('settings');
  await c.eval(`__st.click('#inst-nav [data-itab="installers"]')`);
  await sleep(300);
  if (!await c.eval(`__st.shown('#itab-installers')`)) bad.push('installers');
  for (const t of ['mod', 'resourcepack', 'shader', 'world', 'screenshot']) {
    await c.eval(`__st.click('#inst-nav [data-itab="${t}"]')`);
    await sleep(500);
    const ok = await c.eval(`__st.shown('#itab-content') && document.querySelector('#inst-nav [data-itab="${t}"]').classList.contains('on')`);
    if (!ok) bad.push(t);
  }
  if (bad.length) throw new Error('这些 tab 点不亮: ' + bad.join(','));
  await c.shot('instance');
  return `${head.t} / ${head.v} / ${head.l} / 7 个 tab 都切得动`;
});

/* ---------------- 实例：各页内容 ---------------- */
step('实例模组与各页内容', async (c) => {
  const out = {};
  for (const t of ['mod', 'resourcepack', 'shader', 'world', 'screenshot']) {
    await c.eval(`__st.click('#inst-nav [data-itab="${t}"]')`);
    await sleep(700);
    out[t] = { rows: await c.eval(`__st.n('#inst-content-list > *')`), txt: (await c.eval(`__st.txt('#itab-content')`)) || '' };
  }
  const empty = Object.entries(out).filter(([, v]) => v.rows < 1);
  if (empty.length) throw new Error('这些页没渲染出内容: ' + empty.map(e => e[0]).join(','));
  return Object.entries(out).map(([k, v]) => `${k}:${v.rows}行`).join(' ') + `｜模组页「${out.mod.txt.slice(0, 24)}」`;
});

/* ---------------- 实例：管理菜单 ---------------- */
step('实例管理菜单', async (c) => {
  await c.eval(`__st.click('#inst-manage')`);
  await c.waitFor(`__st.n('.ctx-menu .ctx-item') >= 1`, 5000, '管理菜单');
  const items = JSON.parse(await c.eval(`JSON.stringify(__st.rows('.ctx-menu .ctx-item'))`));
  // 菜单的「点空白收起」挂在 document 的 mousedown 上（capture），
  // 合成 click 不会触发；得补一个 mousedown，否则菜单会一路挂到后面的截图里
  await c.eval(`document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:5, clientY:5}))`);
  await sleep(300);
  const left = await c.eval(`__st.n('.ctx-menu')`);
  if (left) throw new Error('点空白处菜单没收起来');
  return items.join(' / ').slice(0, 80);
});

/* ---------------- 下载：游戏版本 ---------------- */
step('下载页游戏版本列表', async (c) => {
  await c.eval(`__st.go('download')`);
  await c.eval(`(function(){var s=document.getElementById('dl-search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await c.eval(`__st.click('#dl-tabs [data-dltab="game"]')`);
  await c.waitFor(`__st.n('#dl-list > .dl-row') > 5`, 25000, '版本清单');
  const n = await c.eval(`__st.n('#dl-list > .dl-row') - 1`);
  const count = await c.eval(`__st.txt('#dl-count')`);
  await c.shot('download-game');
  return `${n} 个版本（${count}）`;
});

step('下载页搜索过滤', async (c) => {
  await c.eval(`(function(){var s=document.getElementById('dl-search');s.value='1.21.1';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await c.waitFor(`__st.n('#dl-list > .dl-row') > 1 && __st.n('#dl-list > .dl-row') < 20`, 15000, '过滤结果');
  const rows = JSON.parse(await c.eval(`JSON.stringify(__st.rows('#dl-list > .dl-row').slice(1,4))`));
  const n = await c.eval(`__st.n('#dl-list > .dl-row') - 1`);
  if (!rows.every(r => r.includes('1.21.1'))) throw new Error('结果里混进了别的版本: ' + rows.join('|'));
  return `${n} 条，全是 1.21.1`;
});

/* ---------------- 安装弹窗与加载器卡片 ---------------- */
step('安装弹窗与加载器卡片', async (c) => {
  await c.eval(`(function(){
    var row=[...document.querySelectorAll('#dl-list > .dl-row')].slice(1).find(r=>r.textContent.includes('1.21.1'));
    if(!row) throw new Error('列表里没有 1.21.1');
    row.querySelector('button').click(); return true;
  })()`);
  await c.waitFor(`__st.shown('#loader-modal')`, 12000, '安装弹窗');
  await c.waitFor(`__st.n('#im-grid .im-card') >= 5`, 12000, '加载器卡片');
  const cards = JSON.parse(await c.eval(`JSON.stringify(__st.rows('#im-grid .im-card .im-title'))`));
  const ver = await c.eval(`__st.txt('#im-version')`);
  await c.shot('install-modal');
  return `版本 ${ver}，卡片 ${cards.join('/')}`;
});

step('加载器版本选择窗', async (c) => {
  const clicked = await c.eval(`(function(){
    var card=[...document.querySelectorAll('#im-grid .im-card')].find(e=>/Fabric(?! API)/i.test(e.textContent));
    if(!card) return 'no-card';
    card.click(); return card.textContent.replace(/\\s+/g,' ').trim().slice(0,24);
  })()`);
  if (clicked === 'no-card') throw new Error('卡片里没有 Fabric');
  const shown = await c.eval(`(function(){
    return new Promise(function(res){
      var t=setTimeout(function(){res(false)},6000);
      var iv=setInterval(function(){
        if(document.getElementById('ver-modal') && !document.getElementById('ver-modal').hidden){clearTimeout(t);clearInterval(iv);res(true)}
      },150);
    });
  })()`);
  const rows = await c.eval(`__st.n('#ver-list > *')`);
  await c.shot('loader-versions');
  // 取消选择，别把状态留在「已选 Fabric」
  await c.eval(`__st.click('#ver-close')`);
  await sleep(300);
  await c.eval(`__st.click('#im-close')`);
  await sleep(200);
  if (!shown) throw new Error('版本选择窗没打开（点了「' + clicked + '」）');
  if (rows < 1) throw new Error('版本列表是空的');
  return `点「${clicked}」→ 版本列表 ${rows} 行`;
});

/* ---------------- 1.12.2 的 Cleanroom 三卡 ---------------- */
step('Cleanroom 三卡（1.12.2）', async (c) => {
  await c.eval(`(function(){var s=document.getElementById('dl-search');s.value='1.12.2';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await c.waitFor(`[...document.querySelectorAll('#dl-list > .dl-row')].slice(1).some(r=>r.textContent.includes('1.12.2'))`, 15000, '1.12.2 行');
  await c.eval(`(function(){
    var row=[...document.querySelectorAll('#dl-list > .dl-row')].slice(1).find(r=>r.textContent.includes('1.12.2'));
    row.querySelector('button').click(); return true;
  })()`);
  await c.waitFor(`__st.shown('#loader-modal')`, 12000, '安装弹窗');
  await c.waitFor(`__st.n('#im-grid .im-card') >= 3`, 15000, '卡片');
  const cards = JSON.parse(await c.eval(`JSON.stringify(__st.rows('#im-grid .im-card .im-title'))`));
  const hit = cards.filter(t => /Cleanroom|Fugue|Scalar/i.test(t));
  await c.shot('install-1122');
  await c.eval(`__st.click('#im-close')`);
  await sleep(200);
  if (hit.length < 3) throw new Error('Cleanroom 相关卡片只有 ' + hit.length + ' 张: ' + JSON.stringify(cards));
  return `${cards.length} 张卡片，含 ${hit.join('/')}`;
});

/* ---------------- 其它下载分类 ---------------- */
step('整合包 / 模组 / 资源包 / 光影 / 世界列表', async (c) => {
  const out = {};
  for (const t of ['modpack', 'mod', 'resourcepack', 'shader', 'world']) {
    await c.eval(`__st.click('#dl-tabs [data-dltab="${t}"]')`);
    await c.waitFor(`__st.n('#ad-grid .ad-card') > 0`, 25000, t + ' 列表');
    out[t] = await c.eval(`__st.n('#ad-grid .ad-card')`);
  }
  await c.shot('download-modrinth');
  return Object.entries(out).map(([k, v]) => `${k}:${v}`).join(' ');
});

/* ---------------- 切分类要清掉搜索词 ---------------- */
step('切换分类清空搜索词', async (c) => {
  await c.eval(`__st.click('#dl-tabs [data-dltab="mod"]')`);
  await c.waitFor(`__st.n('#ad-grid .ad-card') > 0`, 25000, '模组列表');
  await c.eval(`(function(){var s=document.getElementById('ad-search');s.value='sodium';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(1500);
  await c.waitFor(`__st.n('#ad-grid .ad-card') > 0`, 25000, 'sodium 结果');
  await c.eval(`__st.click('#dl-tabs [data-dltab="modpack"]')`);
  await sleep(400);
  const left = await c.eval(`document.getElementById('ad-search').value`);
  if (left) throw new Error('切到整合包后搜索框还留着「' + left + '」');
  await c.waitFor(`__st.n('#ad-grid .ad-card') > 0`, 25000, '整合包列表');
  const n = await c.eval(`__st.n('#ad-grid .ad-card')`);
  return `搜索词已清空，整合包列表 ${n} 个`;
});

/* ---------------- 内容详情与版本窗 ---------------- */
step('内容详情与版本窗', async (c) => {
  await c.eval(`__st.click('#dl-tabs [data-dltab="mod"]')`);
  await c.waitFor(`__st.n('#ad-grid .ad-card') > 0`, 20000);
  await c.eval(`(function(){var s=document.getElementById('ad-search');s.value='sodium';s.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(1200);
  await c.waitFor(`__st.n('#ad-grid .ad-card') > 0`, 25000, 'sodium 结果');
  const n = await c.eval(`__st.n('#ad-grid .ad-card')`);
  await c.eval(`__st.qa('#ad-grid .ad-card')[0].click()`);
  await c.waitFor(`__st.shown('#adver-modal')`, 15000, '版本窗');
  await c.waitFor(`__st.n('#adver-list > *') > 0`, 15000, '版本行');
  const rows = await c.eval(`__st.n('#adver-list > *')`);
  const title = await c.eval(`__st.txt('#adver-title')`);
  await c.shot('addon-versions');
  await c.eval(`__st.click('#adver-close')`);
  return `${title}：${n} 个搜索结果，版本窗 ${rows} 行`;
});

/* ---------------- 外观 ---------------- */
step('外观：皮肤渲染与披风', async (c) => {
  await c.eval(`__st.go('appearance')`);
  await sleep(1500);
  const info = JSON.parse(await c.eval(`JSON.stringify({
    canvases: __st.n('#page-appearance canvas'),
    size: (function(){var c=__st.q('#page-appearance canvas');return c?c.width+'x'+c.height:'-'})(),
    tabs: __st.rows('#page-appearance .tab').slice(0,4)
  })`));
  if (!info.canvases) throw new Error('没有 canvas');
  await c.shot('appearance');
  return `${info.canvases} 个 canvas（${info.size}），tab: ${info.tabs.join('/')}`;
});

step('外观：盔甲开关与四部位', async (c) => {
  await c.eval(`__st.go('appearance')`);
  await sleep(600);
  const offHidden = await c.eval(`document.getElementById('ap-armor-row').hidden`);
  if (!offHidden) throw new Error('盔甲默认就是打开的（应该是关着，等用户勾选）');

  // 开关是 seg（不显示 / 显示），和上面三组同一套样式
  await c.eval(`__st.click('#armor-seg button[data-armor="on"]')`);
  await sleep(500);
  const shown = await c.eval(`!document.getElementById('ap-armor-row').hidden`);
  if (!shown) throw new Error('切到「显示」后盔甲格子没出现');
  const segOn = await c.eval(`document.querySelector('#armor-seg button[data-armor="on"]').classList.contains('active')`);
  if (!segOn) throw new Error('「显示」按钮没有选中态');

  const slots = await c.eval(`__st.n('#ap-armor-row .armor-cell')`);
  if (slots !== 4) throw new Error('盔甲格子是 ' + slots + ' 个（应为 4）');
  // 格子里的 <img> 一直存在，不穿时只是 hidden —— 只看 hidden 才算真实状态
  const cellIcon = () => c.eval(`(function(){
    var c = document.querySelectorAll('#ap-armor-row .armor-cell')[0];
    var i = c.querySelector('img');
    return (i && !i.hidden) ? (i.getAttribute('src') || '') : '';
  })()`);
  const openPicker = async () => {
    if (!await c.eval(`__st.shown('#armor-picker')`)) {
      await c.eval(`__st.qa('#ap-armor-row .armor-cell')[0].click()`);
      await c.waitFor(`__st.shown('#armor-picker')`, 5000, '图标弹窗');
    }
  };

  await openPicker();
  const items = await c.eval(`__st.n('#armor-pick-grid .armor-pop-item')`);
  if (items < 5) throw new Error('弹窗里只有 ' + items + ' 个选项');
  await c.shot('armor-popover');

  const cur = await cellIcon();
  let picked = '';
  for (let idx = 1; idx < items; idx++) {
    await openPicker();
    await c.eval(`__st.qa('#armor-pick-grid .armor-pop-item')[${idx}].click()`);
    await sleep(420);
    const now = await cellIcon();
    if (now && now !== cur) { picked = now; break; }
  }
  if (!picked) throw new Error('逐个点材质都没换上新图标');

  // 切回「不显示」：格子收起（身上的甲也一起摘掉）
  await c.eval(`__st.click('#armor-seg button[data-armor="off"]')`);
  await sleep(500);
  const hiddenAgain = await c.eval(`document.getElementById('ap-armor-row').hidden`);
  if (!hiddenAgain) throw new Error('关掉开关后盔甲格子还露着');
  // 再打开，选择应该还在（开关只控制渲不渲染）
  await c.eval(`__st.click('#armor-seg button[data-armor="on"]')`);
  await sleep(400);
  const kept = await cellIcon();
  if (!kept) throw new Error('重新打开开关后之前选的材质丢了');
  await c.shot('armor-on');
  // 还原成默认的「不显示」，否则下一次跑这条会撞上「默认就是打开的」
  await c.eval(`__st.click('#armor-seg button[data-armor="off"]')`);
  await sleep(300);
  return `默认关；打开后 4 个部位 / ${items} 个材质；关掉收起、再打开选择还在`;
});

step('外观：站立/行走动画', async (c) => {
  const before = fs.readFileSync(await c.shot('anim-before')).toString('base64').slice(0, 2000);
  const clicked = await c.eval(`(function(){
    var b=[...document.querySelectorAll('#anim-seg button, #anim-seg label')].find(e=>/行走/.test(e.textContent));
    if(!b) return 'none'; b.click(); return b.textContent.trim();
  })()`);
  await sleep(900);
  const after = fs.readFileSync(await c.shot('anim-after')).toString('base64').slice(0, 2000);
  if (clicked === 'none') throw new Error('没有行走/站立切换');
  if (before === after) throw new Error('切到行走后画面没变化');
  // 切回站立
  await c.eval(`(function(){
    var b=[...document.querySelectorAll('#anim-seg button, #anim-seg label')].find(e=>/站立/.test(e.textContent));
    if(b) b.click();
  })()`);
  await sleep(400);
  return `切到「${clicked}」后画面有变化`;
});

/* ---------------- 百宝箱 ---------------- */
step('百宝箱：清理', async (c) => {
  await c.eval(`__st.go('toolbox')`);
  await sleep(300);
  await c.eval(`__st.click('#tb-clean')`);
  await c.waitFor(`(__st.txt('#tb-clean-result')||'').length > 2`, 20000, '清理结果');
  const r = await c.eval(`__st.txt('#tb-clean-result')`);
  return r;
});

/* 起个本地 HTTP 服务，验证自定义下载能真的把文件拉下来 */
step('百宝箱：自定义下载', async (c) => {
  const dir = path.join(OUT, 'dl');
  fs.mkdirSync(dir, { recursive: true });
  const payload = path.join(dir, 'probe.bin');
  fs.writeFileSync(payload, Buffer.alloc(2 * 1024 * 1024, 7));
  try { fs.unlinkSync(path.join(dir, 'probe.bin.downloading')); } catch (_) {}

  const port = 18765;
  const srv = spawn('python', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
  await sleep(1500);
  try {
    await c.eval(`__st.go('toolbox')`);
    await c.eval(`(function(){
      document.getElementById('tb-url').value = 'http://127.0.0.1:${port}/probe.bin';
      document.getElementById('tb-name').value = 'probe-download.bin';
      document.getElementById('tb-dir').value = ${JSON.stringify(dir)};
      return true;
    })()`);
    // 目标文件先删掉，否则测不出「下载成功」
    try { fs.unlinkSync(path.join(dir, 'probe-download.bin')); } catch (_) {}
    await c.eval(`__st.click('#tb-start')`);
    const done = await c.eval(`(function(){
      return new Promise(function(res){
        var t0 = Date.now();
        var iv = setInterval(function(){
          var p = (document.getElementById('tb-percent')||{}).textContent || '';
          var s = (document.getElementById('tb-stage')||{}).textContent || '';
          if (/100%/.test(p) || /完成|已保存/.test(s)) { clearInterval(iv); res(s + ' ' + p); }
          else if (Date.now() - t0 > 25000) { clearInterval(iv); res('TIMEOUT ' + s + ' ' + p); }
        }, 250);
      });
    })()`);
    const got = path.join(dir, 'probe-download.bin');
    const ok = fs.existsSync(got) && fs.statSync(got).size === 2 * 1024 * 1024;
    if (String(done).startsWith('TIMEOUT')) throw new Error('下载没完成：' + done);
    if (!ok) throw new Error('文件没落盘或大小不对：' + (fs.existsSync(got) ? fs.statSync(got).size : '缺失'));
    return `2MB 文件下载完成（${String(done).trim().slice(0, 30)}）`;
  } finally {
    try { srv.kill(); } catch (_) {}
  }
});

/* ---------------- 真实启动一次游戏 ---------------- */
step('启动游戏（真启动 + 关闭）', async (c) => {
  const mc = MC_DIR;
  await c.eval(`__st.go('instances')`);
  await c.waitFor(`__st.n('#instance-table > .table-row') >= 2`, 6000);
  // 挑原版实例（Fabric 那个也行，但原版最不容易被模组干扰）
  const name = await c.eval(`(function(){
    var rows = [...document.querySelectorAll('#instance-table > .table-row')].filter(r=>!r.classList.contains('head'));
    var row = rows.find(r=>/原版/.test(r.textContent)) || rows[0];
    row.click();
    return row.querySelector('.col-name').textContent.replace('当前','').trim();
  })()`);
  await c.waitFor(`document.getElementById('page-instance').classList.contains('on')`, 8000);
  await sleep(1200);
  await c.eval(`__st.click('#inst-launch')`);

  // 等 javaw 出现：首次要补资源/库，给到 3 分钟
  const listJava = () => {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq javaw.exe" /FO CSV /NH', { encoding: 'utf8' });
      const line = out.split(/\r?\n/).find(l => l.includes('javaw.exe'));
      return line ? line.split(',')[1].replace(/"/g, '') : '';
    } catch (e) { return ''; }
  };
  let pid = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    pid = listJava();
    if (pid) break;
    await sleep(2000);
  }
  if (!pid) throw new Error('3 分钟内没起来 javaw（' + name + '）');

  // 等渲染线程把贴图集建出来 = 真的进了主界面，不是黑屏卡住。
  // 日志位置跟隔离策略有关：没隔离的实例写在 <mc>/logs，隔离的写在 versions/<id>/logs
  const logFiles = [
    path.join(mc, 'logs', 'latest.log'),
    path.join(mc, 'versions', name, 'logs', 'latest.log'),
  ];
  let reached = false;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    for (const lf of logFiles) {
      try {
        const txt = fs.readFileSync(lf, 'utf8');
        if (/Render thread\/INFO\]: Created: .*atlas/.test(txt)) { reached = true; break; }
      } catch (_) {}
    }
    if (reached) break;
  }
  if (!reached) {
    try { execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' }); } catch (_) {}
    throw new Error('游戏起来了但没进主界面（日志里没有 Render thread 贴图集）');
  }
  await c.shot('game-launched');
  // 先礼后兵
  try { execSync('taskkill /PID ' + pid, { stdio: 'ignore' }); } catch (_) {}
  await sleep(3000);
  if (listJava()) {
    try { execSync('taskkill /PID ' + pid + ' /F', { stdio: 'ignore' }); } catch (_) {}
  }
  await sleep(1500);
  if (listJava()) throw new Error('游戏进程关不掉');
  return `${name} 启动到主界面，进程已退出`;
});

/* ---------------- 设置 ---------------- */
step('设置：各 tab 与默认隔离策略', async (c) => {
  await c.eval(`__st.go('settings')`);
  await sleep(600);
  const iso = await c.eval(`document.getElementById('set-isolation').value`);
  const tabs = JSON.parse(await c.eval(`JSON.stringify(__st.rows('#page-settings .settings-nav button').slice(0,8))`));
  await c.shot('settings');
  if (iso !== 'ALWAYS') throw new Error('默认隔离策略是 ' + iso + '（应为 ALWAYS）');
  return `隔离策略 ${iso}；tab: ${tabs.join('/')}`;
});

step('设置：主题切换', async (c) => {
  await c.eval(`__st.go('settings')`);
  await sleep(300);
  const before = await c.eval(`document.body.getAttribute('data-theme')`);
  await c.eval(`__st.click('button[data-theme-set="dark"]')`);
  await sleep(700);
  const dark = await c.eval(`document.body.getAttribute('data-theme')`);
  await c.shot('theme-dark');
  await c.eval(`__st.click('button[data-theme-set="light"]')`);
  await sleep(700);
  const light = await c.eval(`document.body.getAttribute('data-theme')`);
  if (dark !== 'dark') throw new Error('切到深色失败（现在是 ' + dark + '）');
  if (light !== 'light') throw new Error('切回浅色失败（现在是 ' + light + '）');
  return `${before} → dark → light`;
});

step('设置：Java 列表', async (c) => {
  await c.eval(`__st.go('settings')`);
  await sleep(600);
  const rows = await c.eval(`__st.n('#java-list > *')`);
  if (rows < 1) throw new Error('Java 列表是空的');
  const first = await c.eval(`__st.txt('#java-list > *')`);
  return `${rows} 个 Java（${(first || '').slice(0, 40)}）`;
});

/* ---------------- 跑 ---------------- */
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const c = await Cdp.connect();
  const list = ONLY ? steps.filter(s => s.name.includes(ONLY)) : steps;
  await c.eval(HELPERS);   // --only 时第一个用例可能不跑，抓手得在这里装
  const results = [];
  console.log(`\n功能自检（${list.length} 项）→ ${OUT}\n`);
  for (const s of list) {
    const t0 = Date.now();
    try {
      const note = await s.fn(c);
      const ms = Date.now() - t0;
      results.push({ ok: true, name: s.name, note, ms });
      console.log(`  ✓ ${s.name} — ${note}  [${ms}ms]`);
    } catch (e) {
      const ms = Date.now() - t0;
      results.push({ ok: false, name: s.name, note: e.message, ms });
      console.log(`  ✗ ${s.name} — ${e.message}  [${ms}ms]`);
      try { await c.shot('FAIL-' + s.name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')); } catch (_) {}
    }
  }
  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n结果：${passed} 过 / ${failed} 败`);
  if (c.errors.length) {
    console.log('\n页面异常：');
    c.errors.slice(0, 12).forEach(e => console.log('  ! ' + e));
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), results, pageErrors: c.errors }, null, 2));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('自检起不来：' + e.message); process.exit(2); });
