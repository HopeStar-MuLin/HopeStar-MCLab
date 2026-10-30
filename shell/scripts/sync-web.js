/* 前端资源同步：HMCL 的 assets/web -> shell/web
   ─────────────────────────────────────────────────────────
   不复制不行：Tauri 的 frontendDist 要求资源在工程目录下，
   指向 HMCL 的 resources 目录会让 `tauri build` 把整个 resources 都打进去。

   故意保留单份源文件（HMCL 那边），这里只做镜像，改代码还是改 HMCL 那份。
   JavaFX 模式和 Tauri 模式共用同一套 HTML/CSS/JS，这是整套方案的前提。

   会递归子目录（vendor/ 放 skinview3d 这类第三方 bundle）。 */

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../HMCL/HMCL/src/main/resources/assets/web');
const DST = path.resolve(__dirname, '../web');

let copied = 0;
let skipped = 0;

function sync(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const s = path.join(srcDir, name);
    const d = path.join(dstDir, name);
    const st = fs.statSync(s);

    if (st.isDirectory()) {
      sync(s, d);
      continue;
    }
    if (!st.isFile()) continue;

    const b = fs.existsSync(d) ? fs.statSync(d) : null;
    // 大小和时间戳都没变就跳过，避免每次 dev 都重写文件
    if (b && b.size === st.size && b.mtimeMs === st.mtimeMs) {
      skipped++;
      continue;
    }
    fs.copyFileSync(s, d);
    copied++;
    console.log('[sync] ' + path.relative(SRC, s));
  }
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error('[sync] 源目录不存在: ' + SRC);
    process.exit(1);
  }
  sync(SRC, DST);
  console.log(`[sync] 完成：更新 ${copied} 个，跳过 ${skipped} 个 -> ${DST}`);
}

main();
