/* 往运行中的 Tauri 壳里塞一段 JS，把结果打出来。
   调试用：看 DOM、验状态、抓某个元素的实际尺寸，比截图精确。

   用法：node cdp-eval.js "document.title"
        node cdp-eval.js --file snippet.js
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
  const args = process.argv.slice(2);
  let expr;
  if (args[0] === '--file') {
    expr = fs.readFileSync(args[1], 'utf8');
  } else {
    expr = args.join(' ');
  }
  if (!expr) {
    console.error('用法: node cdp-eval.js "<js expression>" | --file <path>');
    process.exit(1);
  }

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

  const res = await new Promise(resolve => {
    const myId = ++id;
    pending.set(myId, resolve);
    ws.send(JSON.stringify({
      id: myId,
      method: 'Runtime.evaluate',
      params: { expression: expr, awaitPromise: true, returnByValue: true }
    }));
  });
  ws.close();

  const r = res.result;
  if (r && r.exceptionDetails) {
    console.error('EXCEPTION ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails, null, 2));
    process.exit(1);
  }
  const v = r && r.result && r.result.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
