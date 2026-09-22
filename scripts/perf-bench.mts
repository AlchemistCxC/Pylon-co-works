// 产品路径性能基准（issue #233）——**绝对成本**口径，取代已废除的 wasm↔TS 对照跑器。
//
// 跑法（`bun` 直接跑；**不需要 vite-node**——那个包不在依赖里，旧跑器的「必须 vite-node」
// 注释是过期的，照它跑等于 `npx` 网络拉包）：
//   bun scripts/perf-bench.mts                    # 默认 m 档、5 轮取中位
//   PERF_SCALE=full bun scripts/perf-bench.mts    # 加 l 档极量级
//   PERF_ROUNDS=9 bun scripts/perf-bench.mts      # 更多采样轮
//   PERF_SCALE=xs bun scripts/perf-bench.mts      # 只跑最小档（跑得快，绝对 ms 只作参考）
//
// 口径与「为什么没有 TS 侧」见 `scripts/perf-bench/harness.ts` 头注。
// case 面与其接线点证据见 `scripts/perf-bench/index.ts`。
import { preloadComputeWasm } from './wasmPreload.ts'

// 计算核必须在套件模块图之前装好：产品出口（`streamingCompute()` / `loadMarkdownCompute()`）
// 的就绪检查发生在调用点，而调用点全是同步上下文。同 `scripts/vitest-wasm-setup.mts` 的理由。
preloadComputeWasm()

const { EXCLUDED_WASM_EXITS, buildPerfSuites } = await import('./perf-bench/index.ts')
const { formatPerfTable, frameBudgetNote, notesOf, resolveScale, runPerf, summarizePerf } = await import('./perf-bench/harness.ts')

const scale = resolveScale(process.env.PERF_SCALE)
const rounds = Number(process.env.PERF_ROUNDS ?? 5)

/** 各计算核的线性内存（测试侧装载前置把 memory 留在 globalThis 上，见 `wasmPreload.ts`）。 */
const ARTIFACT_MEMORY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['pylon-compute', '__pylon_compute_wasm_module__memory'],
  ['pylon-markdown', '__pylon_markdown_wasm_module__memory'],
]

function linearMemory(): Record<string, number> {
  const host = globalThis as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const [name, key] of ARTIFACT_MEMORY_KEYS) {
    const memory = host[key]
    if (memory instanceof WebAssembly.Memory) out[name] = memory.buffer.byteLength
  }
  return out
}

const before = linearMemory()
const suites = await buildPerfSuites()
const rows = await runPerf(suites, { scale, rounds, probe: { linearMemory } })

console.log(`产品路径性能基准（scale=${scale}，每 case 预热 1 轮 + ${rounds} 轮取中位）`)
console.log(`可用计算核：${Object.entries(before).map(([name, size]) => `${name} ${(size / 1024 / 1024).toFixed(2)}MiB`).join('，') || '（未装载）'}`)
console.log(`case 总数：${rows.length}`)
console.log(`\n${formatPerfTable(rows, { rounds, hasProbe: true })}`)

console.log(`\n${summarizePerf(rows)}`)

const frameNote = frameBudgetNote(rows)
if (frameNote) console.log(`\n${frameNote}`)

const notes = notesOf(suites)
if (notes) console.log(`\n${notes}`)

const after = linearMemory()
console.log('\n跑完全表后计算核线性内存（高水位；核不归还，故此值即本进程内核的占用峰值）')
for (const [name, size] of Object.entries(after)) {
  const start = before[name] ?? 0
  console.log(`  ${name.padEnd(16)} ${(size / 1024 / 1024).toFixed(2)}MiB（装载后 ${(start / 1024 / 1024).toFixed(2)}MiB，+${((size - start) / 1024 / 1024).toFixed(2)}MiB）`)
}

console.log('\n已排除的 wasm 计算出口（判据：src/ 内无调用方；逐条给理由）')
for (const exit of EXCLUDED_WASM_EXITS) console.log(`  ${exit.name.padEnd(34)} ${exit.reason}`)
