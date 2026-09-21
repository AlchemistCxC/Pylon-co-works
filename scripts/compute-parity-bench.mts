// node 性能对照：计算纯函数 TS 原生 vs wasm（同一套套件定义，issue #220 配套）。
//
// 跑法（**必须 vite-node**：套件 import 的 src 模块链里有无扩展名相对 import，
// 裸 node 的类型剥离解析不了；vite-node 与 vitest 同一套解析器）：
//   npx vite-node scripts/compute-parity-bench.mts                    # 默认 m 档、3 轮取中位数
//   COMPUTE_PARITY_SCALE=full npx vite-node scripts/...               # 加 l 档极量级
//   COMPUTE_PARITY_ROUNDS=5 npx vite-node scripts/...                 # 更多采样轮
//
// 口径：每 case 两侧各预热 1 轮（JIT/wasm 装载不进样本），再各跑 R 轮取中位数；
// ratio = wasm/ts，<1 表示 wasm 更快。stateful pair（预算引擎）的输入是驱动脚本，
// 每次计时都在新鲜实例上完整回放。
import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

const { buildAllSuites, loadComputeContext, missingCoverage } = await import('./compute-parity/index.ts')
const { formatBenchTable, resolveScale, runBench, summarizeParity, runParity } = await import('./compute-parity/harness.ts')

const scale = resolveScale(process.env.COMPUTE_PARITY_SCALE)
const rounds = Number(process.env.COMPUTE_PARITY_ROUNDS ?? 3)

const ctx = await loadComputeContext()
const suites = buildAllSuites(ctx)

const uncovered = missingCoverage(suites)
if (uncovered.length > 0) {
  console.error(`覆盖门未过：以下 wasm 计算出口没有对照 pair：${uncovered.join(', ')}`)
  process.exit(1)
}

// 性能表之前先做一次快速 parity 自检：比值只在「两侧做同一件事」时才有意义。
const parityRows = await runParity(suites, { scale })
const mismatches = parityRows.filter(row => row.outcome === 'mismatch')
console.log(summarizeParity(parityRows))
if (mismatches.length > 0) {
  console.error('\nparity 未绿，比值不成立——先修对照再谈数字。')
  process.exit(1)
}

console.log(`\n性能对照（scale=${scale}，每侧 ${rounds} 轮取中位数；ratio < 1 表示 wasm 更快）`)
const started = performance.now()
const rows = await runBench(suites, { scale, rounds })
console.log(formatBenchTable(rows))

const byDomain = new Map<string, { faster: number, slower: number, total: number }>()
for (const row of rows) {
  const entry = byDomain.get(row.domain) ?? { faster: 0, slower: 0, total: 0 }
  entry.total += 1
  if (row.ratio < 1) entry.faster += 1
  else entry.slower += 1
  byDomain.set(row.domain, entry)
}
console.log('\n分域小结（wasm 占优 / ts 占优 / case 总数）')
for (const [domain, entry] of byDomain) {
  console.log(`  ${domain.padEnd(18)} ${entry.faster} / ${entry.slower} / ${entry.total}`)
}
console.log(`\n总耗时 ${(performance.now() - started).toFixed(0)}ms`)
