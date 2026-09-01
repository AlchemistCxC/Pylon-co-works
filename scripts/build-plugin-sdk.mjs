/**
 * build-plugin-sdk.mjs — 构建发行包内插件开发 SDK。
 *
 * 产物（src-tauri/resources/sdk/，经 tauri resources + pack_release 进入 ZIP）：
 * - pylon-plugin-sdk.js        单文件 ESM——发行包内无构建插件开发的 import 目标
 * - pylon-plugin-manifest.schema.json  manifest 编辑器校验/补全
 *
 * 定位：发行包用户走纯 JS 无构建路径（复制 sdk 目录 → 相对 import）。
 * TS 作者仍走源码仓库（tsconfig paths）——类型声明树会把整个宿主闭包
 * 拖进发行包，不做发行。
 *
 * 依赖闭包纪律：src/sdk/index.ts 的运行时 import 必须保持零宿主依赖，
 * 否则 bundle 会把宿主代码打进去——体积守卫（64KB）守护这一点。
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'src-tauri', 'resources', 'sdk')
mkdirSync(outDir, { recursive: true })

// 1) 单文件 ESM bundle（浏览器目标；types 在编译期全部擦除）
await build({
  entryPoints: [join(repoRoot, 'src', 'sdk', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2021',
  legalComments: 'inline',
  outfile: join(outDir, 'pylon-plugin-sdk.js'),
  logLevel: 'info',
})

// 2) manifest schema 随包
cpSync(
  join(repoRoot, 'shared', 'pylon-plugin-manifest.schema.json'),
  join(outDir, 'pylon-plugin-manifest.schema.json'),
)

// 3) 体积守卫：bundle 若超过 64KB，说明运行时 import 泄漏了宿主代码
const size = statSync(join(outDir, 'pylon-plugin-sdk.js')).size
if (size > 64 * 1024) {
  console.error(`[build-plugin-sdk] bundle ${size} 字节超过 64KB 上限——检查 src/sdk 是否引入了宿主运行时依赖`)
  process.exit(1)
}
console.log(`[build-plugin-sdk] done: pylon-plugin-sdk.js ${size}B + manifest schema`)
