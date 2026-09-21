// 迁移前 TS 折叠 vs 迁移后 wasm 折叠的同形态对照（issue #220）。
//
// 用户的完工要求里有「不得出现用了 wasm 计算核还不如原生 TypeScript 的情况」，
// 因此必须有这个同 harness 对照，而不是拿两处不同环境的数字互比。
//
// 迁移前的实现从 git 历史取出，临时落在 `src/domains/workbench/__baselineOldProjector.ts`
// （只用于本次对照，跑完即删；它不进任何生产路径）。
//
// 跑法：node scripts/bench-ts-vs-wasm.mts

import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

import { createWorkbenchEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchEventEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench as projectWasm } from '../src/domains/workbench/workbenchProjector.ts'
import { projectWorkbench as projectTs } from '../src/domains/workbench/__baselineOldProjector.ts'

const SESSION_ID = 'bench-compare'
const RECORDED_AT = '2026-09-21T00:00:00.000Z'

function journal(total: number): WorkbenchEventEnvelope[] {
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
  for (let index = 0; index < total; index += 1) {
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

function median(runs: number, body: () => number): number {
  const samples: number[] = []
  for (let round = 0; round < runs; round += 1) samples.push(body())
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]!
}

const total = 20_000
const events = journal(total)
// 预热两条路径（1/10 规模），再取中位数——否则先跑的那条会带着 JIT 冷启动。
const warm = events.slice(0, total / 10)
projectTs(warm)
projectWasm(warm)

const tsMs = median(3, () => {
  const started = performance.now()
  const result = projectTs(events)
  const elapsed = performance.now() - started
  if (result.document.timeline.length !== total + 1) throw new Error('TS 基线结果形状异常')
  return elapsed
})
const wasmMs = median(3, () => {
  const started = performance.now()
  const result = projectWasm(events)
  const elapsed = performance.now() - started
  if (result.document.timeline.length !== total + 1) throw new Error('wasm 结果形状异常')
  return elapsed
})

// 先验：两侧必须做了等量的工作，否则比值没有意义。
const tsDoc = projectTs(events).document
const wasmDoc = projectWasm(events).document
const shape = (doc: { timeline: readonly unknown[], messages: readonly { role: string, content: string }[] }) => ({
  timeline: doc.timeline.length,
  messages: doc.messages.map(message => `${message.role}:${message.content.length}`),
})
const tsShape = shape(tsDoc as never)
const wasmShape = shape(wasmDoc as never)
console.log(`形状先验：TS ${JSON.stringify(tsShape)} / wasm ${JSON.stringify(wasmShape)}`)
if (JSON.stringify(tsShape) !== JSON.stringify(wasmShape)) {
  throw new Error('两侧工作不等量：比值不成立，先修对照再谈数字')
}

// ── 边界分段：把迁移后那 315ms 按阶段切开 ─────────────────────────────────────
// 只用已导出的原语复刻 `foldIntoProjector` 的步骤，逐段计时，避免「整体一个数」。
{
  const {
    createProjector,
    encodeProjectorFrame,
    foldIntoProjector,
    resetProjectorBoundaryCrossings,
    readProjectorBoundaryCrossings,
  } = await import('../src/infrastructure/compute/projectorCompute.ts') as typeof import('../src/infrastructure/compute/projectorCompute.ts')

  const timeIt = <T,>(body: () => T): [T, number] => {
    const started = performance.now()
    const value = body()
    return [value, performance.now() - started]
  }

  // 单轮在这个量级上噪声可达 ±20%（同一段代码 consecutive 跑出 194/197/211/225ms），
  // 所以每段都取多轮中位数——否则「优化有没有效」根本判不出来。
  // 只能 1 轮：每轮都新建投影核并折 20k，多轮会让 wasm 堆持续增长，后面的轮次被
  // 内存增长污染（实测 5 轮中位数把 project 抬到 2718ms，而首轮约 200ms）。
  // 要多次采样请重跑整个脚本（每进程一次），不要在一进程里叠轮次。
  const ROUNDS = 1
  const medians = (pick: (sample: ReturnType<typeof sample>) => number): number => {
    const values: number[] = []
    for (let round = 0; round < ROUNDS; round += 1) values.push(pick(sample()))
    values.sort((left, right) => left - right)
    return values[Math.floor(values.length / 2)]!
  }
  const sample = () => {
    resetProjectorBoundaryCrossings()
    const projector = createProjector(SESSION_ID)
    const [frame, encodeMs] = timeIt(() => encodeProjectorFrame(events))
    const [patchText, appendMs] = timeIt(() => projector.appendBatch(frame))
    const [, patchParseMs] = timeIt(() => JSON.parse(patchText))
    const [documentText, documentMs] = timeIt(() => projector.document())
    const [, documentParseMs] = timeIt(() => JSON.parse(documentText))
    const phases = JSON.parse(projector.foldPhases()) as { decodeMs: number, projectMs: number, patchJsonMs: number }
    return {
      encodeMs,
      appendMs,
      patchParseMs,
      documentMs,
      documentParseMs,
      phases,
      crossings: readProjectorBoundaryCrossings(),
      frameBytes: frame.length,
      documentBytes: documentText.length,
      patchBytes: patchText.length,
    }
  }
  sample() // 预热
  const encodeMs = medians(s => s.encodeMs)
  const appendMs = medians(s => s.appendMs)
  const patchParseMs = medians(s => s.patchParseMs)
  const documentMs = medians(s => s.documentMs)
  const documentParseMs = medians(s => s.documentParseMs)
  const decodeMs = medians(s => s.phases.decodeMs)
  const projectMs = medians(s => s.phases.projectMs)
  const patchJsonMs = medians(s => s.phases.patchJsonMs)
  const frameBytes = sample().frameBytes
  const documentBytes = sample().documentBytes
  const patchBytes = sample().patchBytes
  const crossings = sample().crossings

  console.log(`边界分段（20k 事件，单帧；每段 ${ROUNDS} 轮中位数）`)
  console.log(`  JS 帧编码            : ${encodeMs.toFixed(0)}ms（帧 ${(frameBytes / 1024 / 1024).toFixed(2)}MB）`)
  console.log(`  wasm appendBatch     : ${appendMs.toFixed(0)}ms（含 Rust decode + project + patch 序列化；patch ${patchBytes}B）`)
  console.log(`  JS JSON.parse(patch) : ${patchParseMs.toFixed(1)}ms`)
  console.log(`  wasm document()      : ${documentMs.toFixed(0)}ms（文档 ${(documentBytes / 1024 / 1024).toFixed(2)}MB）`)
  console.log(`  JS JSON.parse(doc)   : ${documentParseMs.toFixed(0)}ms`)
  console.log(`  过界次数             : ${crossings}`)
  console.log(`  ↳ wasm 内部分段      : decode ${decodeMs.toFixed(0)}ms / project ${projectMs.toFixed(0)}ms / patch 序列化 ${patchJsonMs.toFixed(0)}ms`)

  // materializePage 是 foldIntoProjector 里除上面四步之外的那部分，用差值估出来。
  const foldMs = medians(() => timeIt(() => foldIntoProjector({ projector: createProjector(SESSION_ID) } as never, events))[1])
  console.log(`  foldIntoProjector 合计: ${foldMs.toFixed(0)}ms → materializePage 差值 ≈ ${(foldMs - encodeMs - appendMs - documentMs).toFixed(0)}ms`)
}

console.log(`同形态对照（${total} 条 reasoning delta + 1 条 user，同一 Node harness，3 轮中位数）`)
console.log(`  迁移前 TS 折叠 : ${tsMs.toFixed(0)}ms`)
console.log(`  迁移后 wasm 折叠: ${wasmMs.toFixed(0)}ms`)
console.log(`  比值           : ${(wasmMs / tsMs).toFixed(2)}×（<1 表示 wasm 更快）`)
