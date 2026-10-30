// 把 skinview3d（带盔甲层）打成一个自包含的 IIFE，
// 全局名仍是 `skinview3d`，替换掉前端 vendor 目录里那份即可。
import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'skinview3d',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  outfile: 'dist/skinview3d.bundle.js',
  legalComments: 'none',
  banner: {
    js: '/* skinview3d 3.4.2 + armor layer (local patch). Upstream: MIT, (c) Haowei Wen & contributors. */'
  }
})
console.log('built dist/skinview3d.bundle.js')
