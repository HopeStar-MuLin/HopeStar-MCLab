/* 直接从 WebView2 抓图，不走系统截屏。
   好处：窗口被遮挡、最小化、屏幕锁掉都能抓到，而且只含页面内容不含桌面。

   用法：node cdp-shot.js out.png
*/
const http = require('http');
const fs = require('fs');

const CDP = 'http://127.0.0.1:9222';

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(CDP + path, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const out = process.argv[2] || 'shot.png';
  // 可选：只截某块区域 node cdp-shot.js out.jpg 100 200 300 400
  const clip = process.argv.length >= 7
    ? {
      x: +process.argv[3], y: +process.argv[4],
      width: +process.argv[5], height: +process.argv[6],
      scale: process.argv[7] ? +process.argv[7] : 2
    }
    : null;
  const targets = await getJson('/json');
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.error('没有找到页面 target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise(r => ws.addEventListener('open', r));

  const send = (method, params) => new Promise(resolve => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  // 带背景图 + 一堆 backdrop-filter 时整页 PNG 有 2~3MB，
  // captureScreenshot 偶尔会拖到超时（Promise 永不 resolve，node 静默退出）。
  // 改用 JPEG + 超时兜底。
  const timeout = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 20000));
  const res = await Promise.race([
    send('Page.captureScreenshot', clip
      ? { format: 'jpeg', quality: 92, clip }
      : { format: 'jpeg', quality: 88, captureBeyondViewport: false }),
    timeout
  ]);
  ws.close();

  if (res && res.timeout) {
    console.error('截图超时（20s）');
    process.exit(1);
  }

  const data = res.result && res.result.data;
  if (!data) {
    console.error('截图失败: ' + JSON.stringify(res).slice(0, 300));
    process.exit(1);
  }
  const buf = Buffer.from(data, 'base64');
  fs.writeFileSync(out, buf);
  console.log('saved ' + out + ' (' + buf.length + ' bytes)');
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
