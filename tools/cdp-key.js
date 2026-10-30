/* 给运行中的壳发一个键盘事件，用来验证「浏览器快捷键已被屏蔽」。
   走 CDP 的 Input.dispatchKeyEvent —— 它和真实按键走同一条输入管线，
   页面里的 preventDefault 也会照常生效（不像 Runtime.evaluate 直接调事件）。

   用法：node cdp-key.js F5
        node cdp-key.js F5 ctrl
        node cdp-key.js r ctrl
*/
const http = require('http');

const CDP = 'http://127.0.0.1:9222';

// 常用键的虚拟键码。不全，够测刷新/开发工具/缩放这些。
const VK = {
  F3: 114, F5: 116, F7: 118, F12: 123,
  r: 82, R: 82, u: 85, U: 85, p: 80, P: 80, s: 83, S: 83,
  i: 73, I: 73, j: 74, J: 74, c: 67, C: 67,
  '0': 48, '-': 189, '=': 187, '+': 187
};

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
  const key = args[0];
  if (!key) {
    console.error('用法: node cdp-key.js <key> [ctrl] [shift]');
    process.exit(1);
  }
  const mods = args.slice(1).map(s => s.toLowerCase());
  // CDP 的 modifiers 是位掩码：1=Alt 2=Ctrl 4=Meta 8=Shift
  let modifiers = 0;
  if (mods.includes('alt')) modifiers |= 1;
  if (mods.includes('ctrl')) modifiers |= 2;
  if (mods.includes('meta')) modifiers |= 4;
  if (mods.includes('shift')) modifiers |= 8;

  const targets = await getJson('/json');
  const page = targets.find(t => t.type === 'page');
  if (!page) { console.error('没有找到页面 target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  function send(method, params) {
    return new Promise(resolve => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }

  const base = {
    key,
    code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
    windowsVirtualKeyCode: VK[key] || 0,
    nativeVirtualKeyCode: VK[key] || 0,
    modifiers
  };
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base));
  await send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
  ws.close();
  console.log('sent ' + key + (mods.length ? ' +' + mods.join('+') : ''));
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
