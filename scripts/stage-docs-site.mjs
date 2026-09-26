/**
 * stage-docs-site.mjs — 离线文档站构建 + 暂存进 Tauri 资源树（#371）。
 *
 * 以 `PYLON_DOCS_OFFLINE=1` 构建 docs/（base 回根、裁 Web 字体——系统衬线回退
 * 在 theme/custom.css），产物整体拷入 src-tauri/resources/docs-site/，随后由
 * `tauri build` 经 bundle.resources 带进发行包、`pylon-docs://` scheme 消费。
 * 暂存形态沿用 build-plugin-sdk.mjs 的离线版先例（rm + cpSync）。
 *
 * 三条构建期守卫把「离线形态走样」挡在打包前，不拖到用户打开 Sheet 才暴露：
 * index.html 必须存在、不得再发大体积字体分块、不得残留 GitHub Pages 前缀。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vitepressBin = join(repoRoot, 'node_modules', 'vitepress', 'bin', 'vitepress.js')
const distDir = join(repoRoot, 'docs', '.vitepress', 'dist')
const stagedDir = join(repoRoot, 'src-tauri', 'resources', 'docs-site')
const PAGES_PREFIX = '/Pylon-co-works/'
// 守卫口径：目标是裁掉 fontsource 的 22MB 大字体（CJK 分块 MB 级、西文全套多字重）。
// VitePress 默认主题自带的 Inter UI 子集（每个 KB 级）属主题一部分，保留不算走样——
// 判定按单文件体积而非扩展名，避免把守卫写成对 vitepress 内部实现的耦合。
const MAX_FONT_BYTES = 512 * 1024
const MAX_DIST_BYTES = 8 * 1024 * 1024

if (!existsSync(vitepressBin)) {
  console.error('[stage-docs-site] 缺少 vitepress，请先 bun install --frozen-lockfile')
  process.exit(1)
}

execFileSync(process.execPath, [vitepressBin, 'build', 'docs'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, PYLON_DOCS_OFFLINE: '1' },
})

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`[stage-docs-site] 离线构建产物缺 index.html: ${distDir}`)
  process.exit(1)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

let totalBytes = 0
for (const path of walk(distDir)) {
  const size = statSync(path).size
  if (/\.woff2?$/.test(path) && size > MAX_FONT_BYTES) {
    console.error(`[stage-docs-site] 离线产物携带超阈值字体分块 ${path}（${size}B > ${MAX_FONT_BYTES}B）——fontsource 裁除失效，检查 config.ts 的 stripWebfonts`)
    process.exit(1)
  }
  totalBytes += size
}
if (totalBytes > MAX_DIST_BYTES) {
  console.error(`[stage-docs-site] 离线产物总体积 ${(totalBytes / 1024 / 1024).toFixed(2)} MB 超过 ${MAX_DIST_BYTES / 1024 / 1024} MB 上限——字体或资产裁除失效`)
  process.exit(1)
}
const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8')
if (indexHtml.includes(PAGES_PREFIX)) {
  console.error(`[stage-docs-site] 离线产物残留 GitHub Pages 前缀 ${PAGES_PREFIX}（base 未回根，检查 PYLON_DOCS_OFFLINE 是否生效）`)
  process.exit(1)
}

rmSync(stagedDir, { recursive: true, force: true })
cpSync(distDir, stagedDir, { recursive: true })

console.log(`[stage-docs-site] offline dist: ${distDir}`)
console.log(`[stage-docs-site] staged: ${stagedDir} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`)
