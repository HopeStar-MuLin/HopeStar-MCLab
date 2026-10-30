/* 用真实鼠标事件点某个元素（Input.dispatchMouseEvent），
   而不是 el.click()。

   区别很重要：el.click() 不经过命中测试，点不到「被覆盖层挡住」这类问题。
   下载按钮上盖了一层进度填充，怀疑就是那层吃掉了点击。

   用法：node cdp-click.js "#btn-refresh"
        node cdp-click.js ".ad-card" [序号]
*/
const http = require('http');

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
  const selector = process.argv[2];
  const index = parseInt(process.argv[3] || '0', 10);
  if (!selector) { console.error('用法: node cdp-click.js <selector> [index]'); process.exit(1); }

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

  // 先问元素在哪
  const box = await send('Runtime.evaluate', {
    expression: `(function(){
      var list = document.querySelectorAll(${JSON.stringify(selector)});
      var el = list[${index}];
      if (!el) { return null; }
      var r = el.getBoundingClientRect();
      return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height});
    })()`,
    returnByValue: true
  });

  const raw = box.result && box.result.result && box.result.result.value;
  if (!raw) { console.error('找不到元素: ' + selector + ' [' + index + ']'); ws.close(); process.exit(1); }
  const pos = JSON.parse(raw);
  if (!pos.w || !pos.h) { console.error('元素尺寸为 0: ' + selector); ws.close(); process.exit(1); }

  const base = { x: Math.round(pos.x), y: Math.round(pos.y), button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
  await new Promise(r => setTimeout(r, 40));
  await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));

  // 顺带把命中测试结果报出来：这一层到底是谁接的点击
  const hit = await send('Runtime.evaluate', {
    expression: `(function(){
      var el = document.elementFromPoint(${Math.round(pos.x)}, ${Math.round(pos.y)});
      if (!el) { return 'null'; }
      return el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ').join('.') : '');
    })()`,
    returnByValue: true
  });
  const hitVal = hit.result && hit.result.result && hit.result.result.value;
  console.log('clicked ' + selector + '[' + index + '] at ' + base.x + ',' + base.y + ' → 命中 ' + hitVal);
  ws.close();
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
