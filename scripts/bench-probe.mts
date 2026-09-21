// 一进程一配置的性能探针（issue #220 调查用）。
//
// **为什么要单独一个脚本**：同一个进程里反复折叠大批量会让 wasm 线性内存持续增长，
// 每次 `memory.grow` 代价随堆上升，后面的采样会被前面污染（实测同一段代码的「5 轮中位数」
// 被抬到 2718ms，而首轮约 200ms）。所以这里的契约是：**一次调用只跑一个 case**，
// 多次取样靠重跑整个进程。
//
// 用法：
//   node scripts/bench-probe.mts --case=cold-ts   --n=20000
//   node scripts/bench-probe.mts --case=cold-wasm --n=20000 [--page=1000]
//   node scripts/bench-probe.mts --case=live-ts   --n=2000
//   node scripts/bench-probe.mts --case=live-wasm --n=2000

import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

import { createWorkbenchEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchEventEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import {
  createProjector,
  encodeProjectorFrame,
  foldIntoProjector,
  readProjectorBoundaryCrossings,
  resetProjectorBoundaryCrossings,
} from '../src/infrastructure/compute/projectorCompute.ts'
import { projectWorkbench as projectWasm, reduceWorkbenchEvent as reduceWasm } from '../src/domains/workbench/workbenchProjector.ts'
import {
  projectWorkbench as projectTs,
  reduceWorkbenchEvent as reduceTs,
} from '../src/domains/workbench/__baselineOldProjector.ts'

const arg = (name: string, fallback: number): number => {
  const found = process.argv.find(item => item.startsWith(`--${name}=`))
  return found ? Number(found.slice(name.length + 3)) : fallback
}
const caseName = process.argv.find(item => item.startsWith('--case='))?.slice('--case='.length) ?? 'cold-ts'
const total = arg('n', 20_000)
const pageSize = arg('page', 1000)

const SESSION_ID = 'bench-probe'
const RECORDED_AT = '2026-09-21T00:00:00.000Z'

function journal(size: number): WorkbenchEventEnvelope[] {
  const events: WorkbenchEventEnvelope[] = [
    createWorkbenchEnvelope({
      sessionId: SESSION_ID,
      sequence: 1,
      recordedAt: RECORDED_AT,
      source: { provider: 'peri', sourceId: 'wire-1' },
      identity: { messageId: 'user-perf' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.started', role: 'user', parts: [{ kind: 'text', text: '长思考' }] },
    }),
  ]
  for (let index = 0; index < size; index += 1) {
    events.push(createWorkbenchEnvelope({
      sessionId: SESSION_ID,
      sequence: index + 2,
      recordedAt: RECORDED_AT,
      source: { provider: 'peri', sourceId: `wire-${index + 2}` },
      identity: { messageId: 'thought-perf' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      coverage: [index + 2, index + 2],
      event: { type: 'reasoning.delta', parts: [{ kind: 'thinking', text: `第${index}段` }] },
    }))
  }
  return events
}

/** 时间 + 两侧结果形状（等量工作先验）。 */
function measure(body: () => { timeline: number, messages: string }): { ms: number, shape: string } {
  const started = performance.now()
  const shape = body()
  const ms = performance.now() - started
  return { ms, shape: JSON.stringify(shape) }
}

const shapeOf = (document: { timeline: readonly unknown[], messages: readonly { role: string, content: string }[] }) =>
  ({ timeline: document.timeline.length, messages: document.messages.map(message => `${message.role}:${message.content.length}`) })

const events = journal(total)
let result: { ms: number, shape: string }

if (caseName === 'cold-ts') {
  result = measure(() => shapeOf(projectTs(events).document as never))
} else if (caseName === 'cold-wasm') {
  resetProjectorBoundaryCrossings()
  const pages: WorkbenchEventEnvelope[][] = []
  for (let at = 0; at < events.length; at += pageSize) pages.push(events.slice(at, at + pageSize))
  const started = performance.now()
  let document = undefined as unknown as { timeline: readonly unknown[], messages: readonly { role: string, content: string }[] }
  let state = { projector: createProjector(SESSION_ID) } as never
  for (const page of pages) {
    document = foldIntoProjector(state, page).document as never
  }
  result = { ms: performance.now() - started, shape: JSON.stringify(shapeOf(document)) }
  const phases = JSON.parse((state as { projector: { foldPhases(): string } }).projector.foldPhases()) as
    { decodeMs: number, projectMs: number, patchJsonMs: number }
  console.log(`[phases 末页] decode ${phases.decodeMs.toFixed(1)}ms / project ${phases.projectMs.toFixed(1)}ms / patch ${phases.patchJsonMs.toFixed(1)}ms`)
  console.log(`[crossings] ${readProjectorBoundaryCrossings()}`)
} else if (caseName === 'live-ts') {
  const head = events.slice(0, 1)
  const tail = events.slice(1)
  const started = performance.now()
  let document = projectTs(head).document
  for (const event of tail) document = reduceTs(document, event)
  result = { ms: performance.now() - started, shape: JSON.stringify(shapeOf(document)) }
} else if (caseName === 'live-wasm') {
  const head = events.slice(0, 1)
  const tail = events.slice(1)
  resetProjectorBoundaryCrossings()
  const started = performance.now()
  let document = projectWasm(head).document
  for (const event of tail) document = reduceWasm(document, event)
  result = { ms: performance.now() - started, shape: JSON.stringify(shapeOf(document)) }
  console.log(`[crossings] ${readProjectorBoundaryCrossings()}`)
} else if (caseName === 'doc-loop') {
  // 消融：先把 N 条一次性折进核，再单独量「每事件一次全量 document()」的代价。
  // 用来证明 live 路径的成本落点——`reduceWorkbenchFold` 每次都走
  // appendBatch + document() + materializePage，也就是每事件一次全量文档读。
  let state = { projector: createProjector(SESSION_ID) } as never
  foldIntoProjector(state, events)
  const projector = (state as { projector: { document(): string } }).projector
  const started = performance.now()
  for (let index = 0; index < total; index += 1) {
    const text = projector.document()
    JSON.parse(text)
  }
  result = { ms: performance.now() - started, shape: 'doc-loop' }
} else if (caseName === 'encode-loop') {
  // 消融：基线——只有帧编码与 appendBatch（不读文档），用来分离「每事件过界」的固定成本。
  let state = { projector: createProjector(SESSION_ID) } as never
  const projector = (state as { projector: { appendBatch(frame: Uint8Array): string } }).projector
  const { encodeProjectorFrame } = await import('../src/infrastructure/compute/projectorCompute.ts')
  const frames = events.slice(1).map(event => encodeProjectorFrame([event]))
  const started = performance.now()
  for (const frame of frames) projector.appendBatch(frame)
  result = { ms: performance.now() - started, shape: 'encode-loop' }
} else if (caseName === 'fold-only') {
  // 单帧折入 N 条，只读 wasm 内部分段（decode / project / patch 序列化）——
  // 用来判断剩余时间有多少在折叠本体、多少在 JS 侧编组与物化。
  const projector = createProjector(SESSION_ID)
  const frame = encodeProjectorFrame(events)
  const started = performance.now()
  projector.appendBatch(frame)
  const total = performance.now() - started
  const phases = JSON.parse(projector.foldPhases()) as { decodeMs: number, projectMs: number, patchJsonMs: number }
  console.log(`[fold-only n=${total && events.length}] appendBatch 合计 ${total.toFixed(1)}ms = decode ${phases.decodeMs.toFixed(1)} + project ${phases.projectMs.toFixed(1)} + patch ${phases.patchJsonMs.toFixed(1)}`)
  result = { ms: total, shape: 'fold-only' }
} else {
  throw new Error(`未知 case：${caseName}`)
}

console.log(`[${caseName} n=${total}${caseName === 'cold-wasm' ? ` page=${pageSize}` : ''}] ${result.ms.toFixed(1)}ms  shape=${result.shape}`)
