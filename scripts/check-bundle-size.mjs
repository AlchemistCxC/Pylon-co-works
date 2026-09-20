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
// （starry-night 的 onig 473,155 B raw / 161,144 B gzip 一直静默躺在总额之外）。
// 定标依据（2026-09-21 实测，`#220` 施工期）：
//   onig-CwjCXqnP.wasm          473,155 B raw / 161,144 B gzip（既存）
//   pylon_compute_bg-*.wasm      50,939 B raw /  22,790 B gzip（计算核，WP2 接线后才进产物）
// 合计 183,934 B gzip。按 200,000 定标，留约 8% 余量。
// WP4（comrak + syntect 高亮）预计显著抬高这一项，届时按实产物重定标。
const WASM_TOTAL_GZIP_BUDGET = 200_000

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

// 主 chunk：index-*.js（非 vendor）
const main = entries.find(e => /^index-.*\.js$/.test(e.name) && !e.name.startsWith('vendor-'))
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
