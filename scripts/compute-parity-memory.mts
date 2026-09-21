// 内存对照：计算纯函数 TS 原生 vs wasm 的每调用内存足迹（issue #220 配套，与速度表同源套件）。
//
// 跑法（**必须 vite-node**，同 `compute-parity-bench.mts`）：
//   npx vite-node scripts/compute-parity-memory.mts
//   npx --expose-gc node_modules/vite-node/vite-node.mjs scripts/compute-parity-memory.mts   # 精确保留量
//   COMPUTE_PARITY_SCALE=full npx vite-node scripts/compute-parity-memory.mts
//
// 口径见 `scripts/compute-parity/harness.ts` 的「内存跑器」节：
// - 结果字节数与核线性内存都是**确定性**读数（与 GC 无关）；
// - 宿主保留增量在没有 `--expose-gc` 时是**上限**，输出头会点明状态。
import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

const { buildAllSuites, loadComputeContext, missingCoverage } = await import('./compute-parity/index.ts')
const { formatMemoryTable, resolveScale, runMemory, summarizeMemory } = await import('./compute-parity/harness.ts')

const scale = resolveScale(process.env.COMPUTE_PARITY_SCALE)
const repeats = Number(process.env.COMPUTE_PARITY_REPEATS ?? 8)

/** Node 宿主探针。wasm 线性内存由测试前置留在 globalThis 上（见 `wasmPreload.ts`）。 */
function nodeProbe(): import('./compute-parity/harness.ts').MemoryProbe {
  const memoryUsage = process.memoryUsage.bind(process)
  const forced: () => void = typeof (globalThis as { gc?: () => void }).gc === 'function'
    ? () => (globalThis as unknown as { gc: () => void }).gc()
    : () => {}
  const canCollect = typeof (globalThis as { gc?: () => void }).gc === 'function'
  const host = globalThis as Record<string, unknown>
  const linearMemory = (): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const name of ['pylon-compute']) {
      const key = `__${name.replace('-', '_')}_wasm_module__memory`
      const memory = host[key]
      if (memory instanceof WebAssembly.Memory) out[name] = memory.buffer.byteLength
    }
    return out
  }
  return {
    retained: () => {
      const usage = memoryUsage()
      return usage.heapUsed + usage.external + usage.arrayBuffers
    },
    collect: forced,
    canCollect,
    linearMemory,
  }
}

const ctx = await loadComputeContext()
const suites = buildAllSuites(ctx)

const uncovered = missingCoverage(suites)
if (uncovered.length > 0) {
  console.error(`覆盖门未过：以下 wasm 计算出口没有对照 pair：${uncovered.join(', ')}`)
  process.exit(1)
}

const probe = nodeProbe()
const before = probe.linearMemory()
console.log(`内存对照（scale=${scale}，保留增量取 ${repeats} 次调用的平均）`)
console.log(`装载后线性内存：${Object.entries(before).map(([name, size]) => `${name} ${(size / 1024 / 1024).toFixed(2)}MiB`).join('，') || '（未装载）'}`)

const rows = await runMemory(suites, { scale, probe, repeats })
console.log(`\n${formatMemoryTable(rows, probe)}`)
console.log(`\n${summarizeMemory(rows)}`)

const after = probe.linearMemory()
console.log('\n跑完全表后线性内存（高水位；计算核不归还，故此值即本进程内核的占用峰值）')
for (const [name, size] of Object.entries(after)) {
  const start = before[name] ?? 0
  console.log(`  ${name.padEnd(16)} ${(size / 1024 / 1024).toFixed(2)}MiB（装载后 ${(start / 1024 / 1024).toFixed(2)}MiB，+${((size - start) / 1024 / 1024).toFixed(2)}MiB）`)
}
