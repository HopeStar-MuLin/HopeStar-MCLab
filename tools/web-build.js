#!/usr/bin/env node
/* 前端资源拼接：src/js/*.js -> app.js，src/css/*.css -> app.css
 *
 * 为什么是「拼接」而不是 ES module：
 * 同一份前端要同时跑在 JavaFX WebEngine 和 WebView2 里。JavaFX 至今不支持
 * <script type="module">，拆成模块会在 JavaFX 模式下直接白屏。而拼接不改变
 * 执行语义——所有源码仍然落在同一个 IIFE 里，变量作用域和拆之前一模一样。
 *
 * 约定：
 *   - 文件按文件名排序拼接，前缀数字决定顺序（00- / 10- / ... / 99-）
 *   - 只有 00 开头那份带 IIFE 开头，99 开头那份带结尾；中间的文件不能自成作用域
 *   - app.js / app.css 是产物，不要手改（CI 会用 --check 拦住直接改产物的提交）
 *
 * 用法：
 *   node tools/web-build.js            # 生成
 *   node tools/web-build.js --check    # 只校验产物是否最新，不写文件（CI 用）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'HMCL', 'HMCL', 'src', 'main', 'resources', 'assets', 'web');
const SRC_JS = path.join(WEB, 'src', 'js');
const SRC_CSS = path.join(WEB, 'src', 'css');

const BANNER_JS = [
  '/* 自动生成，不要直接改这个文件。',
  '   源码在 src/js/ 下（按文件名顺序拼接），改完执行：node tools/web-build.js */',
  '',
].join('\n');

const BANNER_CSS = [
  '/* 自动生成，不要直接改这个文件。',
  '   源码在 src/css/ 下（按文件名顺序拼接），改完执行：node tools/web-build.js */',
  '',
].join('\n');

function listSources(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`找不到源码目录：${path.relative(ROOT, dir)}`);
  }
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.js') || n.endsWith('.css'))
    .sort()
    .map((n) => path.join(dir, n));
}

/// 拼接时逐文件校验结尾换行：少了会把下一份的首行接在上一份末行后面，
/// 这种错误在编辑器里看不出来，只有跑起来才炸（`}function` 之类）。
function concat(files, banner) {
  const parts = [banner];
  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8');
    if (!text.endsWith('\n')) {
      text += '\n';
    }
    parts.push(text);
  }
  return parts.join('');
}

function build() {
  const js = concat(listSources(SRC_JS), BANNER_JS);
  const css = concat(listSources(SRC_CSS), BANNER_CSS);
  return [
    { out: path.join(WEB, 'app.js'), text: js },
    { out: path.join(WEB, 'app.css'), text: css },
  ];
}

/// 给 index.html 里的 app.js / app.css 引用打上内容哈希。
///
/// WebView2 会缓存 `tauri.localhost/app.js`：改完前端、重新构建、壳也重建了，
/// 页面上跑的仍然是上一次的脚本 —— 表现就是「代码明明改了，界面一点没变」，
/// 排查起来极浪费时间。带上内容哈希，脚本一变 URL 就变，缓存自然失效。
///
/// 用内容哈希而不是时间戳：内容没变时 URL 不变，index.html 不会每次构建都变脏。
function stampAssets(js, css) {
  const hash = require('crypto').createHash('sha1').update(js).update(css).digest('hex').slice(0, 10);
  const file = path.join(WEB, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const next = html
    .replace(/(href="app\.css)(\?v=[0-9a-f]+)?(")/g, `$1?v=${hash}$3`)
    .replace(/(src="app\.js)(\?v=[0-9a-f]+)?(")/g, `$1?v=${hash}$3`);
  if (next !== html) {
    fs.writeFileSync(file, next, 'utf8');
    console.log(`[web] index.html  app.js?v=${hash}`);
  }
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;

  const outputs = build();
  if (!check) {
    stampAssets(outputs[0].text, outputs[1].text);
  }

  for (const { out, text } of outputs) {
    const rel = path.relative(ROOT, out).replace(/\\/g, '/');
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (check) {
      if (current !== text) {
        console.error(`[x] ${rel} 与 src/ 不一致，跑一次 node tools/web-build.js`);
        stale++;
      } else {
        console.log(`[ok] ${rel}`);
      }
      continue;
    }
    if (current !== text) {
      fs.writeFileSync(out, text, 'utf8');
      console.log(`[web] ${rel}  ${(text.length / 1024).toFixed(1)} KB`);
    } else {
      console.log(`[web] ${rel}  无变化`);
    }
  }

  if (check && stale > 0) {
    process.exit(1);
  }
}

main();
