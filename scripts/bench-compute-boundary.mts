#!/usr/bin/env bun
// bench-compute-boundary — 计算核边界的喂法基准（issue #220，用户 2026-09-21 裁决要求）。
//
// 目的：边界纪律（「回放按页合批」「热边界禁 JSON 串行」「禁止每拍全文过界」）是**假设**，
// 本脚本用 mock 数据把三种喂法的**过界次数、编组耗时、端到端耗时**测出来，
// 以数字决定喂法，而不是靠感觉。
//
// 场景：
//   A · 冷装载   —— ~1 万 / ~10 万 canonical 事件的合成 journal，对照
//                   「页级 batch」vs「逐事件」两种喂法
//   B · 直播突刺 —— 单拍灌入数百事件（模拟 gap 回填），同上对照
//   C · 边界放大 —— 同一份页级 batch，对照「每页 document() 全量读」vs「末尾读一次」
//                   （后者量化「全量过界」的代价）
//
// 用法（mock 路径，无需真 agent / IPC）：
//   node scripts/build-wasm.mjs        # 前置：确保产物存在
//   bun scripts/bench-compute-boundary.mts [--quick]

// 本脚本不经 vitest（`bun scripts/...` 直跑），因此自己完成测试侧预初始化：
// 产品源码只保留浏览器那条 fetch 路径，Node 侧读盘 + initSync 在 wasmPreload 里。
import { preloadComputeWasm } from './wasmPreload.ts'

preloadComputeWasm()

import {
  createProjector,
  encodeProjectorFrame,
  readProjectorBoundaryCrossings,
  resetProjectorBoundaryCrossings,
} from '../src/infrastructure/compute/projectorCompute.ts'
import { createWorkbenchEnvelope } from '../src/domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchEventEnvelope, WorkbenchSemanticEvent } from '../src/domains/workbench/events/workbenchEventSchema.ts'

const SESSION_ID = 'bench-session'
const RECORDED_AT = '2026-09-21T00:00:00.000Z'

type Envelope = WorkbenchEventEnvelope

function envelope(sequence: number, event: WorkbenchSemanticEvent, identity: Envelope['identity'] = {}): Envelope {
  return createWorkbenchEnvelope({
    sessionId: SESSION_ID,
    sequence,
    recordedAt: RECORDED_AT,
    source: { provider: 'peri', sourceId: `wire-${sequence}` },
    identity,
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

/**
 * 合成一份**贴近真实流式形态**的 journal：回合 = 用户消息 + 一串文本 delta
 * （+ 偶发工具往返）+ 终态。delta 密度按「一拍一小段」取，这正是折叠热路径的形状。
 */
function synthesizeJournal(totalEvents: number): Envelope[] {
  const envelopes: Envelope[] = []
  let sequence = 0
  let turn = 0
  while (envelopes.length < totalEvents) {
    turn += 1
    const turnId = `turn-${turn}`
    const boundedPush = (event: WorkbenchSemanticEvent, identity: Envelope['identity'] = {}) => {
      if (envelopes.length < totalEvents) {
        sequence += 1
        envelopes.push(envelope(sequence, event, identity))
      }
    }
    boundedPush({ type: 'message.started', role: 'user', parts: [{ kind: 'text', text: `问题 ${turn}` }] }, { turnId, messageId: `user-${turn}` })
    boundedPush({ type: 'message.completed', role: 'user' }, { turnId, messageId: `user-${turn}` })
    boundedPush({ type: 'message.started', role: 'assistant' }, { turnId, messageId: `asst-${turn}` })
    // 每个回合 24 段 delta：文本 + 少量思考段，模拟流式正文。
    for (let chunk = 0; chunk < 24; chunk += 1) {
      boundedPush({ type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: `第 ${chunk} 段回答文本，长度约三十个字符。` }] }, { turnId, messageId: `asst-${turn}` })
      if (chunk % 8 === 3) {
        boundedPush({ type: 'reasoning.delta', parts: [{ kind: 'thinking', text: `推敲 ${chunk}` }] }, { turnId, messageId: `asst-${turn}` })
      }
    }
    boundedPush({ type: 'tool.started', tool: { toolCallId: `tool-${turn}`, title: 'Read', kind: 'read' } }, { turnId, toolCallId: `tool-${turn}` })
    boundedPush({ type: 'tool.completed', result: { ok: true } }, { turnId, toolCallId: `tool-${turn}` })
    boundedPush({ type: 'message.completed', role: 'assistant' }, { turnId, messageId: `asst-${turn}` })
  }
  return envelopes
}

/** 用现成的事件复刻一帧（场景 B 复用 A 的前缀，避免把合成成本算进被测项）。 */
function pageOf(all: readonly Envelope[], from: number, size: number): Envelope[] {
  return all.slice(from, Math.min(from + size, all.length))
}

interface Measurement {
  readonly label: string
  readonly crossings: number
  readonly marshallMs: number
  readonly foldMs: number
  readonly materializeMs: number
  readonly totalMs: number
  readonly eventCount: number
}

function time<T>(fn: () => T): [T, number] {
  const started = performance.now()
  const value = fn()
  return [value, performance.now() - started]
}

/**
 * 取多轮中位数。单轮结果在本机被 JIT 预热与 GC 主导（实测同一形态先后跑差 4.8×），
 * 不重复取中位数就分不清「喂法的代价」和「谁先跑」。
 */
function median(label: string, repeats: number, run: () => Measurement): Measurement {
  const runs: Measurement[] = []
  for (let round = 0; round < repeats; round += 1) runs.push({ ...run(), label })
  runs.sort((left, right) => left.totalMs - right.totalMs)
  return runs[Math.floor(runs.length / 2)]!
}

/** 页级 batch：一页一次编码 + 一次过界。materializePerPage 决定是否每页读一次全量文档。 */
function runPageBatch(
  label: string,
  pages: readonly Envelope[][],
  { materializePerPage }: { materializePerPage: boolean },
): Measurement {
  const eventCount = pages.reduce((sum, page) => sum + page.length, 0)
  resetProjectorBoundaryCrossings()
  const projector = createProjector(SESSION_ID)
  let marshallMs = 0
  let foldMs = 0
  let materializeMs = 0
  const started = performance.now()
  for (const page of pages) {
    const [frame, encodeMs] = time(() => encodeProjectorFrame(page))
    marshallMs += encodeMs
    const [, appendMs] = time(() => projector.appendBatch(frame))
    foldMs += appendMs
    if (materializePerPage) {
      const [, documentMs] = time(() => projector.document())
      materializeMs += documentMs
    }
  }
  if (!materializePerPage) {
    const [, documentMs] = time(() => projector.document())
    materializeMs += documentMs
  }
  return { label, crossings: readProjectorBoundaryCrossings(), marshallMs, foldMs, materializeMs, totalMs: performance.now() - started, eventCount }
}

/** 逐事件：每个事件一帧一次过界——纪律明令禁止的形态，作为对照基线。 */
function runPerEvent(label: string, envelopes: readonly Envelope[]): Measurement {
  resetProjectorBoundaryCrossings()
  const projector = createProjector(SESSION_ID)
  let marshallMs = 0
  let foldMs = 0
  const started = performance.now()
  for (const item of envelopes) {
    const [frame, encodeMs] = time(() => encodeProjectorFrame([item]))
    marshallMs += encodeMs
    const [, appendMs] = time(() => projector.appendBatch(frame))
    foldMs += appendMs
  }
  const [, materializeMs] = time(() => projector.document())
  return { label, crossings: readProjectorBoundaryCrossings(), marshallMs, foldMs, materializeMs, totalMs: performance.now() - started, eventCount: envelopes.length }
}

function report(measurements: readonly Measurement[]): void {
  const header = ['形态', '事件数', '过界次数', '编组 ms', '折叠 ms', '物化 ms', '端到端 ms', '每事件 µs']
  const rows = measurements.map(m => [
    m.label,
    String(m.eventCount),
    String(m.crossings),
    m.marshallMs.toFixed(1),
    m.foldMs.toFixed(1),
    m.materializeMs.toFixed(1),
    m.totalMs.toFixed(1),
    ((m.totalMs * 1000) / Math.max(1, m.eventCount)).toFixed(2),
  ])
  const widths = header.map((title, column) => Math.max(title.length * 2, ...rows.map(row => row[column]!.length)))
  const line = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ')
  console.log(line(header))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
}

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick')
  const PAGE_SIZE = 1000
  const REPEATS = quick ? 3 : 5
  const coldSizes = quick ? [10_000] : [10_000, 100_000]
  const burstSize = quick ? 400 : 500

  console.log(`（每形态取 ${REPEATS} 轮中位数；过界次数由边界包装层计数）`)
  // 预热必须**按测量尺度**做：200 事件的预热不足以为 1 万规模的折叠路径定型，
  // 首轮形态曾因此虚高 6×（同一形态先后跑出 3223ms / 518ms）。这里把两条批量路径
  // 与逐事件路径都在 2000 事件规模上先跑一遍，再开始计量。
  {
    const warmJournal = pageOf(synthesizeJournal(2000), 0, 2000)
    const warmPages: Envelope[][] = []
    for (let index = 0; index < warmJournal.length; index += PAGE_SIZE) {
      warmPages.push(pageOf(warmJournal, index, PAGE_SIZE))
    }
    runPageBatch('warmup-batch', warmPages, { materializePerPage: false })
    runPageBatch('warmup-batch-page-materialize', warmPages, { materializePerPage: true })
    runPerEvent('warmup-per-event', warmJournal)
    resetProjectorBoundaryCrossings()
  }

  console.log('\n── 场景 A · 冷装载：页级 batch vs 逐事件 ──')
  const all = synthesizeJournal(Math.max(...coldSizes) + burstSize)
  const cold = coldSizes.map(size => {
    const journal = all.slice(0, size)
    const pages: Envelope[][] = []
    for (let index = 0; index < journal.length; index += PAGE_SIZE) pages.push(pageOf(journal, index, PAGE_SIZE))
    const rows: Measurement[] = [
      median(`${size} · 页级 batch（${PAGE_SIZE}/页，末尾物化一次）`, REPEATS, () =>
        runPageBatch('cold-batch', pages, { materializePerPage: false })),
      median(`${size} · 页级 batch（每页物化一次）`, REPEATS, () =>
        runPageBatch('cold-batch-page-materialize', pages, { materializePerPage: true })),
    ]
    // 逐事件只在小规模上跑：它的每次过界都要整份 clone + diff（Θ(N²)），
    // 10 万规模下实测需要数小时——这个「跑不完」本身就是纪律 1 的论据。
    if (size === Math.min(...coldSizes)) {
      rows.push(median(`${size} · 逐事件（纪律禁止，作对照）`, REPEATS, () => runPerEvent('cold-per-event', journal)))
    }
    return rows
  }).flat()
  report(cold)
  const coldBatch = cold[0]!
  const coldPerEvent = cold[2]!
  console.log(
    `  冷装载 ${coldBatch.eventCount} 事件：页级 batch 端到端 ${coldBatch.totalMs.toFixed(1)}ms / ` +
      `逐事件 ${coldPerEvent.totalMs.toFixed(1)}ms（${(coldPerEvent.totalMs / coldBatch.totalMs).toFixed(2)}×），` +
      `过界次数 ${coldBatch.crossings} vs ${coldPerEvent.crossings}（${(coldPerEvent.crossings / Math.max(1, coldBatch.crossings)).toFixed(1)}×）`,
  )

  console.log('\n── 场景 B · 直播突刺：单拍灌入数百事件 ──')
  const burst = all.slice(0, burstSize)
  const burstBatch = median(`突刺 ${burstSize} · 单帧 batch`, REPEATS, () => {
    resetProjectorBoundaryCrossings()
    const projector = createProjector(SESSION_ID)
    const started = performance.now()
    const [frame, encodeMs] = time(() => encodeProjectorFrame(burst))
    const [, appendMs] = time(() => projector.appendBatch(frame))
    return {
      label: `突刺 ${burstSize} · 单帧 batch`,
      crossings: readProjectorBoundaryCrossings(),
      marshallMs: encodeMs,
      foldMs: appendMs,
      materializeMs: 0,
      totalMs: performance.now() - started,
      eventCount: burst.length,
    }
  })
  const burstPerEvent = median(`突刺 ${burstSize} · 逐事件`, REPEATS, () => runPerEvent('burst-per-event', burst))
  report([burstBatch, burstPerEvent])
  console.log(
    `  突刺 ${burstSize} 事件：单帧 batch ${burstBatch.totalMs.toFixed(1)}ms / ` +
      `逐事件 ${burstPerEvent.totalMs.toFixed(1)}ms（${(burstPerEvent.totalMs / burstBatch.totalMs).toFixed(2)}×）`,
  )

  console.log('\n── 场景 C · 边界放大：全量 document() 每页一次 vs 末尾一次 ──')
  report([cold[0]!, cold[1]!])
  const perPageMaterialize = cold[1]!
  const onceMaterialize = cold[0]!
  console.log(
    `  物化耗时：每页一次 ${perPageMaterialize.materializeMs.toFixed(1)}ms / 末尾一次 ${onceMaterialize.materializeMs.toFixed(1)}ms` +
      `（${(perPageMaterialize.materializeMs / Math.max(1, onceMaterialize.materializeMs)).toFixed(2)}×）`,
  )

  console.log('\n── 场景 D · 性能护栏的形态（#205 的规模护栏用例） ──')
  {
    // 复刻 `src/__tests__/replay/projectionLinearization.test.ts` 的护栏输入：
    // 一条用户消息 + N 条带 coverage 的 reasoning delta（全折进同一条 reasoning 消息）。
    // 该测试的预算写死在测试里（20k 必须 < 2.5s），所以这里按**分段计时**定位成本落点。
    const total = 20_000
    const journal: Envelope[] = [envelope(1, { type: 'message.started', role: 'user', parts: [{ kind: 'text', text: '长思考' }] }, { messageId: 'user-perf' })]
    for (let index = 0; index < total; index += 1) {
      journal.push(createWorkbenchEnvelope({
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
    // 规模曲线：同一形状按批大小递进。**必须是 Node 宿主跑**
    // （`node scripts/bench-compute-boundary.mts`；vitest 也是 Node）。
    // 2026-09-21 实测对照：
    //   Node  ：5k:30ms  10k:202ms  12k:262ms  14k:269ms —— 线性，堆 209→279MB
    //   Bun   ：5k:34ms  10k:56ms   12k:11997ms 14k:37808ms —— 11k 之后进入悬崖
    // 差异在 wasm 线性内存增长：Bun 在堆约 270MB 处每次 `memory.grow` 都要搬运整块
    // 线性内存，代价按秒计。**这不是计算核的问题**（Rust 单测 `project_batch(20000)`
    // 只要 0.37s），测试与生产都不在 Bun 上跑；本脚本此前用 `bun` 跑出的 60s+ 数字
    // 是宿主假象，别据此改计算核。
    {
      const curve = [5000, 10_000, 12_000, 14_000]
      const points: string[] = []
      for (const size of curve) {
        const slice = journal.slice(0, size)
        const probe = createProjector(SESSION_ID)
        const [probeFrame] = time(() => encodeProjectorFrame(slice))
        const [, probeFold] = time(() => probe.appendBatch(probeFrame))
        const memory = (globalThis as Record<string, unknown>).__pylon_compute_wasm_module__memory as
          | WebAssembly.Memory
          | undefined
        const heapMb = memory ? (memory.buffer.byteLength / 1024 / 1024).toFixed(1) : '?'
        points.push(`${size}:${probeFold.toFixed(0)}ms(帧${probeFrame.length}B/堆${heapMb}MB)`)
      }
      console.log(`  [诊断] 批大小 → appendBatch 耗时: ${points.join('  ')}`)
    }
    resetProjectorBoundaryCrossings()
    const projector = createProjector(SESSION_ID)
    const [frame, encodeMs] = time(() => encodeProjectorFrame(journal))
    const [, foldMs] = time(() => projector.appendBatch(frame))
    const [, documentMs] = time(() => projector.document())
    console.log(`  编码 ${encodeMs.toFixed(1)}ms / 折叠 ${foldMs.toFixed(1)}ms / 物化 ${documentMs.toFixed(1)}ms / 过界 ${readProjectorBoundaryCrossings()} 次`)
    console.log(`  护栏预算 2500ms（测试写死）→ 本核折算 ${(encodeMs + foldMs + documentMs).toFixed(1)}ms`)
  }

  console.log('\n判据：')
  console.log('  · 「页级 batch」是否显著优于「逐事件」——若否，纪律 1 需要按数字修订。')
  console.log('  · 「每页全量物化」的物化耗时是否随事件数超线性增长——若是，即纪律 3 的')
  console.log('    「旧病在边界层复发」，patch DTO 必须补齐切片而不能靠全量 document()。')
}

await main()
