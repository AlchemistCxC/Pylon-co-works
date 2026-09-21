// 「同一份文档，TS 实现 vs wasm 计算核，谁占内存多」——issue #220 的直接对照。
//
// 用户问的是「计算核的内存占用不算低吧？直接用 TS 实现会不会更低」。
// 要回答它必须比**同一样东西的持有成本**，不是比「一次调用的瞬时分配」：
//
// - TS 侧：折叠出的 WorkbenchDocument 是一棵普通 JS 对象树，只有它一份。
// - wasm 侧：**两份**——Rust 核里那份（serde_json::Value 树，随核常驻、不归还）
//   + 消费方拿到的那份 JS 文档（`document()` / patch 物化出来的对象树）。
//   这就是迁移的固有代价：文档在两个语言堆里各存一份，中间靠 JSON/patch 同步。
//
// 口径（一进程一配置，`--expose-gc` 强制回收后再量）：
//   持有成本 = 建好文档、强制 GC 后的 retained − 建之前、强制 GC 后的 retained
//   其中 wasm 侧的 retained 含 WebAssembly.Memory（Node 把它记在 external/arrayBuffers）。
//
// 跑法：`NODE_OPTIONS=--expose-gc npx vite-node scripts/bench-memory-hold.mts --n=2000`
import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

import { createWorkbenchEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchEventEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument as createTsDocument, projectWorkbench as projectTs } from '../src/domains/workbench/__baselineOldProjector.ts'
import { createProjector, encodeProjectorFrame, whenProjectorComputeReady } from '../src/infrastructure/compute/projectorCompute.ts'
import { mixedJournal } from './compute-parity/fixtures/envelopes.ts'

const SESSION_ID = 'bench-hold'
const RECORDED_AT = '2026-09-21T00:00:00.000Z'
const arg = (name: string, fallback: string): string =>
  process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const total = Number(arg('n', '2000'))

/** 与 `bench-ts-vs-wasm.mts` 同形的 journal：一条 user + N 条 reasoning delta 折进一条消息。 */
function journal(count: number): WorkbenchEventEnvelope[] {
  const events: WorkbenchEventEnvelope[] = [createWorkbenchEnvelope({
    sessionId: SESSION_ID,
    sequence: 1,
    recordedAt: RECORDED_AT,
    source: { provider: 'peri', sourceId: 'wire-1' },
    identity: { messageId: 'user-perf' },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'message.started', role: 'user', parts: [{ kind: 'text', text: '长思考' }] },
  }) as WorkbenchEventEnvelope]
  for (let index = 0; index < count; index += 1) {
    events.push(createWorkbenchEnvelope({
      sessionId: SESSION_ID,
      sequence: index + 2,
      recordedAt: RECORDED_AT,
      source: { provider: 'peri', sourceId: `wire-${index + 2}` },
      identity: { messageId: 'thought-perf' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      coverage: [index + 2, index + 2],
      event: { type: 'reasoning.delta', parts: [{ kind: 'thinking', text: `第${index}段思考内容` }] },
    }) as WorkbenchEventEnvelope)
  }
  return events
}

// 形状敏感度：delta 形（1 条大消息 + N 个小 timeline 条目）vs mixed 形（每块 11 个事件、
// 大量不同 id 的消息/活动/交互对象）——后者才是 serde_json Value 的「对象多」压力面。
const shape = arg('shape', 'delta')
const events = shape === 'mixed' ? (mixedJournal(Number(arg('blocks', '200'))) as unknown as WorkbenchEventEnvelope[]) : journal(total)
await whenProjectorComputeReady()

const gc = (globalThis as { gc?: () => void }).gc
if (typeof gc !== 'function') {
  console.error('需要 --expose-gc（NODE_OPTIONS=--expose-gc）；否则持有成本读不准。')
  process.exit(1)
}
const collect = () => { gc(); gc(); gc() }
const retained = (): number => {
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.external + usage.arrayBuffers
}
const heapOnly = (): number => process.memoryUsage().heapUsed
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)}MiB`
const kib = (bytes: number): string => `${(bytes / 1024).toFixed(0)}KiB`

const pad = (text: string, width: number) => String(text).padEnd(width)

// ── TS 侧：建文档 → 强制 GC → 量 ────────────────────────────────────────────
projectTs(events.slice(0, Math.max(1, Math.floor(events.length / 10)))) // 预热
collect()
const tsBaseline = retained()
const tsHeapBaseline = heapOnly()
const tsDocument = projectTs(events).document
collect()
const tsRetained = retained() - tsBaseline
const tsHeap = heapOnly() - tsHeapBaseline
if (tsDocument.timeline.length !== events.length) throw new Error(`TS 形状异常：${tsDocument.timeline.length}`)

// ── wasm 侧：折进核（保住核句柄）→ 物化 JS 文档 → 强制 GC → 量 ────────────
collect()
const wasmBaseline = retained()
const wasmHeapBaseline = heapOnly()
const projector = createProjector(SESSION_ID)
projector.appendBatch(encodeProjectorFrame(events))
const wasmDocument = JSON.parse(projector.document()) as { timeline: unknown[] }
collect()
const wasmBothRetained = retained() - wasmBaseline
const wasmBothHeap = heapOnly() - wasmHeapBaseline
// 核线性内存：高水位、常驻不归还（装载基线 1.13MiB 是核自身代码+静态数据）。
const wasmLinear = (() => {
  const memory = (globalThis as Record<string, unknown>)['__pylon_compute_wasm_module__memory']
  return memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0
})()
if (wasmDocument.timeline.length !== events.length) throw new Error(`wasm 形状异常：${wasmDocument.timeline.length}`)

console.log(`持有成本对照（shape=${shape}，${events.length} 个信封）`)
console.log(`  两侧文档形状：TS timeline ${tsDocument.timeline.length} / wasm ${wasmDocument.timeline.length}（等量工作）\n`)
console.log('  ' + pad('量', 40) + pad('retained 合计', 16) + 'heapUsed')
console.log('  ' + pad('① TS：文档（JS 对象树，只有一份）', 40) + pad(mib(tsRetained), 16) + mib(tsHeap))
console.log('  ' + pad('② wasm：核内文档 + JS 物化文档', 40) + pad(mib(wasmBothRetained), 16) + mib(wasmBothHeap))
console.log('  ' + pad('③ wasm：其中核线性内存（常驻不归还）', 40) + pad(mib(wasmLinear), 16) + '—')
console.log(`\n  ② / ① = ${(wasmBothRetained / tsRetained).toFixed(2)}×    ③ / ① = ${(wasmLinear / tsRetained).toFixed(2)}×`)
console.log(`  核线性内存里 1.13MiB 是装载基线，本 workload 净增 ${kib(wasmLinear - 1179648)}`)
