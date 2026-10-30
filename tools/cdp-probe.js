/* 在真实 Tauri 壳里测滚动帧率。
   走 WebView2 的 CDP 接口（启动时带 --remote-debugging-port=9222），
   注入和 tools/chromium-probe/probe.js 完全同口径的采样逻辑，
   这样三组数据（JavaFX / Edge 独立进程 / Tauri 嵌入）可以直接对比。

   用法：node cdp-probe.js
*/
const http = require('http');

const CDP = 'http://127.0.0.1:9222';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(CDP + path, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// 注入到页面里执行的采样器。返回 Promise<string>，内容是 JSON
const EXPR = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const stats = g => {
    let sum = 0, worst = 0, long = 0;
    for (const v of g) { sum += v; if (v > worst) worst = v; if (v > 32) long++; }
    const mean = sum / g.length;
    return { avg: +(1000 / mean).toFixed(1), meanGap: +mean.toFixed(2),
             worst: Math.round(worst), long, frames: g.length };
  };

  // 1) 造 150 行 release 版本，保证和之前两组滚的是同一件事
  if (!window.__hmcl) return JSON.stringify({ error: 'no __hmcl (page not bridged)' });
  const versions = [];
  for (let i = 0; i < 150; i++) {
    versions.push({
      id: '1.' + (21 - (i % 15)) + '.' + (i + 1),
      type: 'release',
      date: Date.now() - i * 86400000 * 3,
      installed: i === 0
    });
  }
  window.__hmcl.onVersions(JSON.stringify({ versions }));

  // 2) 切到下载页
  const btn = document.querySelector('.rail-item[data-page="download"]');
  if (btn) btn.click();
  await sleep(600);

  const body = document.getElementById('page-body');
  const list = document.getElementById('dl-list');
  if (!body || !list) return JSON.stringify({ error: 'no scroll container' });

  const rows = list.querySelectorAll('.dl-row').length;
  const range = body.scrollHeight - body.clientHeight;
  body.scrollTop = 0;
  await sleep(1200);   // 静置，避开进场动画

  // 3) 空转基线：拿这块屏的刷新率上限
  const idle = await new Promise(resolve => {
    const gaps = []; let last = performance.now(), n = 0;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last); last = now;
      if (++n < 90) requestAnimationFrame(tick); else resolve(gaps.slice(1));
    };
    requestAnimationFrame(tick);
  });

  // 4) 滚动采样：滚到底就回头，整个 3 秒都在持续重绘
  const scroll = await new Promise(resolve => {
    const gaps = []; const t0 = performance.now(); let last = t0; let dir = 1;
    const tick = () => {
      const now = performance.now();
      gaps.push(now - last); last = now;
      body.scrollTop += 8 * dir;
      if (body.scrollTop + body.clientHeight >= body.scrollHeight - 1) dir = -1;
      else if (body.scrollTop <= 1) dir = 1;
      if (now - t0 < 3000) requestAnimationFrame(tick); else resolve(gaps.slice(1));
    };
    requestAnimationFrame(tick);
  });

  const a = stats(idle), b = stats(scroll);
  return JSON.stringify({
    where: 'tauri-webview2',
    dpr: window.devicePixelRatio,
    view: window.innerWidth + 'x' + window.innerHeight,
    phys: Math.round(window.innerWidth * window.devicePixelRatio) + 'x' +
          Math.round(window.innerHeight * window.devicePixelRatio),
    rows, range: Math.round(range),
    idleAvg: a.avg,
    scrollAvg: b.avg,
    scrollMeanGap: b.meanGap,
    worst: b.worst,
    long: b.long,
    frames: b.frames,
    slowdown: +(b.meanGap / a.meanGap).toFixed(2)
  });
})()`;

async function main() {
  let targets;
  for (let i = 0; i < 30; i++) {
    try {
      targets = await getJson('/json');
      if (Array.isArray(targets) && targets.length) break;
    } catch (e) { /* 壳还没起来 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  if (!targets || !targets.length) {
    console.error('连不上 CDP（127.0.0.1:9222），壳没带 --remote-debugging-port 启动？');
    process.exit(1);
  }

  const page = targets.find(t => t.type === 'page') || targets[0];
  console.log('target: ' + page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  await new Promise(r => ws.addEventListener('open', r));

  const send = (method, params) => new Promise(resolve => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  const res = await send('Runtime.evaluate', {
    expression: EXPR,
    awaitPromise: true,
    returnByValue: true
  });

  ws.close();

  if (res.result && res.result.exceptionDetails) {
    console.error('页面里抛错: ' + JSON.stringify(res.result.exceptionDetails, null, 2));
    process.exit(1);
  }

  const raw = res.result && res.result.result && res.result.result.value;
  console.log('RESULT ' + raw);
}

main().catch(e => { console.error(e); process.exit(1); });
