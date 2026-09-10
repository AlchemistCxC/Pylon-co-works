/**
 * check-bundle-size — bundle budget 检查（报告 9A.5）。
 *
 * 读 dist/assets 的 js 产物：主应用 chunk（index-*.js，排除 vendor）与各 chunk
 * 大小对比 budget；超过则 exit 1。budget 以本轮拆包后结果定标（FE-AUD-016 lazy 生效）。
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
const TOTAL_GZIP_BUDGET = 1_600_000

if (!exists(distDir)) {
  console.error('dist/assets 不存在——请先 npm run build')
  process.exit(1)
}

const files = readdirSync(distDir).filter(name => name.endsWith('.js'))
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
report('总 gzip', totalGzip, TOTAL_GZIP_BUDGET)

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
