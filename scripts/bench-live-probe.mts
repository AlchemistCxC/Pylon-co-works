// live 逐事件折叠的单事件成本分段（一进程一段，避免 wasm 堆增长污染）。
//
// 为什么单独有这条：生产 live 是**一事件一次 fold**（`agentWorkbenchSession.foldPage`），
// 与冷装载按页合批的成本结构完全不同——冷装载一次过界摊到上千事件上，live 每个事件都要
// 付一次「编码 + 过界 + patch 序列化 + 解析 + 应用」。
//
// 跑法（每段一个进程）：
//   for s in encode append parse live ts; do \
//     npx vite-node scripts/bench-live-probe.mts --segment=$s --n=2000; done
import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

import { createWorkbenchEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchEventEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import { createWorkbenchDocument as createTsDocument, reduceWorkbenchEvent as reduceTs } from '../src/domains/workbench/__baselineOldProjector.ts'
import { createProjector, encodeProjectorFrame, foldIntoProjector } from '../src/infrastructure/compute/projectorCompute.ts'

const SESSION_ID = 'bench-live'
const RECORDED_AT = '2026-09-21T00:00:00.000Z'

function journal(total: number): WorkbenchEventEnvelope[] {
  const events: WorkbenchEventEnvelope[] = [createWorkbenchEnvelope({
    sessionId: SESSION_ID,
    sequence: 1,
    recordedAt: RECORDED_AT,
    source: { provider: 'peri', sourceId: 'wire-1' },
    identity: { messageId: 'user-perf' },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'message.started', role: 'user', parts: [{ kind: 'text', text: '长思考' }] },
  }) as WorkbenchEventEnvelope]
  for (let index = 0; index < total; index += 1) {
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

const arg = (name: string, fallback: string): string =>
  process.argv.find(item => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

const segment = arg('segment', 'live')
const total = Number(arg('n', '2000'))
const events = journal(total)
const head = events[0]!
const per = (ms: number) => `${(ms / events.length * 1000).toFixed(2)}us/event`

if (segment === 'encode') {
  encodeProjectorFrame([head])
  const started = performance.now()
  let bytes = 0
  for (const event of events) bytes += encodeProjectorFrame([event]).length
  const ms = performance.now() - started
  console.log(`[encode-only]   ${ms.toFixed(1)}ms  ${per(ms)}  (frame ${bytes}B total)`)
} else if (segment === 'append') {
  const frames = events.map(event => encodeProjectorFrame([event]))
  const projector = createProjector(SESSION_ID)
  projector.appendBatch(frames[0]!)
  const started = performance.now()
  let bytes = 0
  for (const frame of frames) bytes += projector.appendBatch(frame).length
  const ms = performance.now() - started
  console.log(`[append-only]   ${ms.toFixed(1)}ms  ${per(ms)}  (patch ${(bytes / 1024 / 1024).toFixed(1)}MiB total)`)
} else if (segment === 'parse') {
  const projector = createProjector(SESSION_ID)
  const patches: string[] = []
  for (const event of events) patches.push(projector.appendBatch(encodeProjectorFrame([event])))
  const started = performance.now()
  let upserts = 0
  for (const text of patches) upserts += (JSON.parse(text) as { timelineUpserts: unknown[] }).timelineUpserts.length
  const ms = performance.now() - started
  console.log(`[parse-only]    ${ms.toFixed(1)}ms  ${per(ms)}  (${upserts} upserts)`)
} else if (segment === 'live') {
  const state = { projector: createProjector(SESSION_ID) } as Parameters<typeof foldIntoProjector>[0]
  foldIntoProjector(state, [head] as never)
  const started = performance.now()
  for (const event of events) foldIntoProjector(state, [event] as never)
  const ms = performance.now() - started
  console.log(`[live=prod]     ${ms.toFixed(1)}ms  ${per(ms)}`)
} else if (segment === 'ts') {
  let document = reduceTs(createTsDocument(SESSION_ID) as never, head)
  const started = performance.now()
  for (const event of events) document = reduceTs(document, event)
  const ms = performance.now() - started
  console.log(`[pre-migration TS] ${ms.toFixed(1)}ms  ${per(ms)}`)
} else {
  throw new Error(`unknown segment: ${segment}`)
}
