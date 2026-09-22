/**
 * check-bundle-size — bundle budget 检查（报告 9A.5）。
 *
 * 读 dist/assets 的产物：主应用 chunk（index-*.js，排除 vendor）与各 chunk
 * 大小对比 budget；**wasm 产物单独记账**（#220）。超过则 exit 1。
 * budget 以本轮拆包后结果定标（FE-AUD-016 lazy 生效）。
 * 用法：先 `npm run build` 再 `node scripts/check-bundle-size.mjs`。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/assets')

// 预算（字节）：主 chunk 上限、任意单 chunk 上限、总 gzip 上限
const MAIN_BUDGET = 400_000
const CHUNK_BUDGET = 450_000
// 阶段 13 将 24 个产品 CSS 从独立静态 CSS 产物迁入可回收的第一方插件
// style assets；对应 gzip 现在计入 JS 总量。按 fresh build 606,709 B 重定标，
// P0-P3 新增 File Workbench、消息 renderer host 与 Agent detector 设置 UI，且把
// 产品组合根恢复为独立 lazy chunk 后，fresh build 为 624,088 B；保留约 0.9%。
// 2026-09-05 重定标：P30–P45（插件化设置系统、插件 runtime、错误中心、字体体系、
// 流式终态一致性等）落地后 fresh build 为 1,577,822 B；旧预算 630,000 自 P0-P3
// 后未随版重定（本门禁不在 check:frontend/CI 链内）。保留约 1.4% 余量。
// 2026-09-19 重定标：#154 阶段 4（设置迁入 sheet 体系：新 settings sheet kind、
// 左栏导航组件、导航状态模块；同轮删除设置覆盖层 shell CSS）后 fresh build 为
// 1,600,220 B，旧预算仅超 220 B（0.014%）。按 1,615,000 定标，保留约 0.9% 余量。
// 注意：本总额**只算 js**，不含 wasm（见下方 WASM_TOTAL_GZIP_BUDGET）——把 wasm
// 折进来会让一个 161 kB 的既存产物变成总额超限，与 JS 预算的定标史无关。
const TOTAL_GZIP_BUDGET = 1_615_000

// #220：wasm 产物独立预算。此前 dist/assets 里的 .wasm 完全无人记账
// （starry-night 的 onig 473,151 B raw / 161,144 B gzip 一直静默躺在总额之外）。
// 定标依据（2026-09-21 **scope 收窄后**实测，`node scripts/build-wasm.mjs` + gzip(9)）：
//   pylon_compute_bg.wasm        119,788 B raw /  53,238 B gzip（只剩 WP3 流式核）
//   pylon_markdown_bg.wasm     2,873,113 B raw / 909,563 B gzip（WP4 comrak + vendored 语法）
//   （收窄前同一门禁读到 841,273 / 307,257 与 1,216,820 总额；投影与 events 的回退
//     使 wasm 总额降 254 KB gzip ≈ 21%。见 ADR-0018 修订。）
//   两侧 glue JS                                                 /  12,240 B gzip
// 合计约 1,375,363 B gzip。按 1,450,000 定标，留约 5% 余量。
//
// **这一档值得单独盯**：wasm 总量仍接近 js 总额（1,615,000）的量级，而其中 909,563 B
// 是 pylon-markdown 的 vendored tmLanguage 语法（14 份，压缩前 711,931 B minified）。
// 降体积的正路是**按语言惰性取语法**（首次高亮某语言时才加载该语言的语法资产），
// 那需要把高亮路径改成「语法就绪后再整块过界」的两段式；本 WP 未做，故先如实记账。
// 若后续不接受这个量级，请以惰性语法为方向立项，而不是继续抬预算。
// 2026-09-21 随 scope 收窄重定标：现行实测 962,801 B（markdown 909,563 + compute 53,238），
// 留约 15% 余量 —— 原 1,450,000 是对「投影 + events 也在包里」定标的，不重定标就等于
// 把这一档放空 50%，回归将无法被发现。
const WASM_TOTAL_GZIP_BUDGET = 1_110_000

if (!exists(distDir)) {
  console.error('dist/assets 不存在——请先 npm run build')
  process.exit(1)
}

const allFiles = readdirSync(distDir)
const files = allFiles.filter(name => name.endsWith('.js'))
const wasmFiles = allFiles.filter(name => name.endsWith('.wasm'))
const entries = files
  .map(name => {
    const path = resolve(distDir, name)
    const raw = statSync(path).size
    const gz = gzipSync(readFile(path)).length
    return { name, raw, gz }
  })
  .sort((a, b) => b.raw - a.raw)

// 主 chunk：**入口**（`index.html` 里 `<script type="module" src>` 指向的那个）。
//
// 为什么不再用 `index-*.js` 通配挑（#241 修正）：Vite 也会把**懒加载的共享 chunk** 命名成
// `index-*`（本次高亮引擎 chunk 就是），一旦出现第二个匹配，`find` 会按 readdir 顺序挑中
// 懒 chunk，于是「主应用 chunk」这个读数**量错了文件**且无人察觉。从 index.html 解析入口是
// 确定性的，语义也对得上「主应用」。
function resolveEntryChunk() {
  try {
    const html = readFileSync(resolve(distDir, '..', 'index.html'), 'utf8')
    const match = html.match(/<script[^>]*type="module"[^>]*src="[^"]*?([^/"]+\.js)"/)
    if (match) {
      const found = entries.find(e => e.name === match[1])
      if (found) return found
    }
  } catch {
    /* 退通配兜底 */
  }
  return entries.find(e => /^index-.*\.js$/.test(e.name) && !e.name.startsWith('vendor-'))
}
const main = resolveEntryChunk()
const totalGzip = entries.reduce((sum, e) => sum + e.gz, 0)

// #220：wasm 产物按 raw + gzip 记账（此前完全不进本门禁）。
const wasmEntries = wasmFiles
  .map(name => {
    const path = resolve(distDir, name)
    const raw = statSync(path).size
    const gz = gzipSync(readFile(path)).length
    return { name, raw, gz }
  })
  .sort((a, b) => b.raw - a.raw)
const totalWasmGzip = wasmEntries.reduce((sum, e) => sum + e.gz, 0)

let failed = false
const report = (label, value, budget, unit = 'bytes') => {
  const ok = value <= budget
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${value.toLocaleString()} ${unit} (budget ${budget.toLocaleString()})`)
}

console.log('── bundle budget ──')
for (const entry of entries.slice(0, 8)) {
  console.log(`  ${entry.name}  ${entry.raw.toLocaleString()} B (gzip ${entry.gz.toLocaleString()} B)`)
}
if (main) report('主应用 chunk', main.raw, MAIN_BUDGET)
const largest = entries[0]
if (largest) report('最大单 chunk', largest.raw, CHUNK_BUDGET)
report('总 gzip（js）', totalGzip, TOTAL_GZIP_BUDGET)

console.log('── wasm budget（#220） ──')
if (wasmEntries.length === 0) {
  console.log('  （dist/assets 无 wasm 产物）')
} else {
  for (const entry of wasmEntries) {
    console.log(`  ${entry.name}  ${entry.raw.toLocaleString()} B (gzip ${entry.gz.toLocaleString()} B)`)
  }
}
report('总 gzip（wasm）', totalWasmGzip, WASM_TOTAL_GZIP_BUDGET)

if (failed) {
  console.error('bundle budget 超限')
  process.exit(1)
}
console.log('bundle budget 通过')

function exists(path) {
  try { statSync(path); return true } catch { return false }
}
function readFile(path) {
  return readFileSync(path)
}
