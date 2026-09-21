// streaming-budget 域套件：揭示预算引擎（wasm `StreamingRevealEngine` vs
// 雕刻基线 `OldStreamingRevealEngine`）。输入是**驱动脚本**（reset/feed/
// noteBacklog/tick 的操作序列），两侧各自在新鲜实例上回放并收集逐拍结果——
// stateful 函数的对照单位是「同一事件流、同一观测序列」。

import type { Suite } from '../harness.ts'
import type { ComputeContextLike } from '../index.ts'
import { OldStreamingRevealEngine } from '../baselines/oldRevealEngine.ts'

type Op =
  | { op: 'reset', rows: ReadonlyArray<{ key: string, text: string }>, at: number }
  | { op: 'feed', key: string, delta: string }
  | { op: 'backlog', now: number }
  | { op: 'tick', now: number }

interface EngineObservation {
  readonly kind: string
  readonly budget: number
  readonly backlogUnits: number
  readonly advancedMaxUnits: number
  readonly advancedTotalUnits: number
  readonly rows: ReadonlyArray<{ key: string, value: string, consumedUnits: number }>
  readonly catchUpWindows: number
  readonly revealedTextByKey: Record<string, string | undefined>
  readonly mirrorTextByKey: Record<string, string | undefined>
}

/** wasm 侧逐拍行决策的 wire 形状：增量尾巴 + 拍后揭示位（#220 边界收口）。 */
interface WasmRevealRow {
  readonly key: string
  readonly tail: string
  readonly revealedLength: number
  readonly consumedUnits: number
}

function replayTs(script: ReadonlyArray<Op>, options?: Record<string, number>): EngineObservation[] {
  const engine = new OldStreamingRevealEngine(options)
  const observations: EngineObservation[] = []
  for (const step of script) {
    if (step.op === 'reset') engine.reset(step.rows, step.at)
    else if (step.op === 'feed') engine.feed(step.key, step.delta)
    else if (step.op === 'backlog') engine.noteBacklog(step.now)
    else {
      const outcome = engine.tick(step.now)
      observations.push({
        kind: outcome.kind,
        budget: outcome.budget,
        backlogUnits: outcome.backlogUnits,
        advancedMaxUnits: outcome.advancedMaxUnits,
        advancedTotalUnits: outcome.advancedTotalUnits,
        rows: outcome.rows.map(row => ({ key: row.key, value: row.value, consumedUnits: row.consumedUnits })),
        catchUpWindows: outcome.catchUpWindows,
        revealedTextByKey: { m1: engine.revealedText('m1'), m2: engine.revealedText('m2') },
        mirrorTextByKey: { m1: engine.mirrorText('m1'), m2: engine.mirrorText('m2') },
      })
    }
  }
  return observations
}

/**
 * 把 wasm 的 tail 形态归一成与 TS 基线可比的整条前缀：按 key 累积已揭示文本，
 * `value = 拍前已揭示 + tail`，同时断言 `revealedLength` 与累计 UTF-16 长度一致
 * ——这正是生产消费方（调度器 `resolveTailValue`）的追加语义，归一即验证。
 */
function replayWasm(
  engine: { reset(rows: ReadonlyArray<{ key: string, text: string }>, at: number): void, feed(key: string, delta: string): void, noteBacklog(now: number): void, tick(now: number): Record<string, unknown>, revealedText(key: string): string | undefined, mirrorText(key: string): string | undefined },
  script: ReadonlyArray<Op>,
): EngineObservation[] {
  const observations: EngineObservation[] = []
  const revealed = new Map<string, string>()
  for (const step of script) {
    if (step.op === 'reset') {
      engine.reset(step.rows, step.at)
      for (const row of step.rows) revealed.set(row.key, row.text)
    } else if (step.op === 'feed') {
      engine.feed(step.key, step.delta)
    } else if (step.op === 'backlog') {
      engine.noteBacklog(step.now)
    } else {
      const outcome = engine.tick(step.now) as {
        kind: string, budget: number, backlogUnits: number, advancedMaxUnits: number,
        advancedTotalUnits: number, rows: WasmRevealRow[], catchUpWindows: number,
      }
      observations.push({
        kind: outcome.kind,
        budget: outcome.budget,
        backlogUnits: outcome.backlogUnits,
        advancedMaxUnits: outcome.advancedMaxUnits,
        advancedTotalUnits: outcome.advancedTotalUnits,
        rows: outcome.rows.map((row) => {
          const previous = revealed.get(row.key) ?? ''
          const value = previous + row.tail
          if (value.length !== row.revealedLength) {
            throw new Error(`tail 追加后揭示位不一致: key=${row.key} ${value.length} != ${row.revealedLength}`)
          }
          revealed.set(row.key, value)
          return { key: row.key, value, consumedUnits: row.consumedUnits }
        }),
        catchUpWindows: outcome.catchUpWindows,
        revealedTextByKey: { m1: engine.revealedText('m1'), m2: engine.revealedText('m2') },
        mirrorTextByKey: { m1: engine.mirrorText('m1'), m2: engine.mirrorText('m2') },
      })
    }
  }
  return observations
}

const TICK = 1000 / 60 + 1

/** 平滑流：每拍 feed 4 单元、每拍 tick——始终贴着打字节奏。 */
function smoothStream(ticks: number): Op[] {
  const script: Op[] = [{ op: 'reset', rows: [{ key: 'm1', text: '' }], at: 0 }]
  for (let index = 0; index < ticks; index += 1) {
    script.push({ op: 'feed', key: 'm1', delta: 'xxxx' })
    script.push({ op: 'backlog', now: index * TICK })
    script.push({ op: 'tick', now: (index + 1) * TICK })
  }
  return script
}

/** 突发：一次 4000 单元后只 tick 直到收敛（追赶窗口 + 硬上限路径）。 */
function burstStream(): Op[] {
  const script: Op[] = [{ op: 'reset', rows: [{ key: 'm1', text: '' }], at: 0 }, { op: 'feed', key: 'm1', delta: 'x'.repeat(4000) }, { op: 'backlog', now: 0 }]
  for (let index = 1; index <= 40; index += 1) script.push({ op: 'tick', now: index * TICK })
  return script
}

/** 多行交错：D1 递减摊分的公平性与行序敏感性。 */
function multiRowStream(): Op[] {
  const script: Op[] = [{ op: 'reset', rows: [{ key: 'm1', text: '' }, { key: 'm2', text: '' }], at: 0 }]
  for (let index = 0; index < 12; index += 1) {
    script.push({ op: 'feed', key: index % 2 === 0 ? 'm1' : 'm2', delta: `行${index}内容`.repeat(3) })
    script.push({ op: 'backlog', now: index * TICK })
    script.push({ op: 'tick', now: (index + 1) * TICK })
  }
  for (let index = 13; index <= 30; index += 1) script.push({ op: 'tick', now: index * TICK })
  return script
}

/** astral/字素流：预算切点永不落进字素（👩‍💻 = 5 UTF-16 单元）。 */
function astralStream(): Op[] {
  const grapheme = '👩‍💻'
  const script: Op[] = [{ op: 'reset', rows: [{ key: 'm1', text: '' }], at: 0 }]
  for (let index = 0; index < 30; index += 1) {
    script.push({ op: 'feed', key: 'm1', delta: grapheme.repeat(4) })
    script.push({ op: 'backlog', now: index * TICK })
    script.push({ op: 'tick', now: (index + 1) * TICK })
  }
  for (let index = 31; index <= 55; index += 1) script.push({ op: 'tick', now: index * TICK })
  return script
}

/** 长流：2000 拍 × 40 单元增量（累计 8 万单元）——生产「一次完整回合」的形状，
 *  也是边界收口前 O(全文)/拍 编组的尺度来源（对照基准 scripts/tmp-streaming-bench.mts）。 */
function longStream(): Op[] {
  const script: Op[] = [{ op: 'reset', rows: [{ key: 'm1', text: '' }], at: 0 }]
  for (let index = 0; index < 2000; index += 1) {
    script.push({ op: 'feed', key: 'm1', delta: 'x'.repeat(40) })
    script.push({ op: 'backlog', now: index * TICK })
    script.push({ op: 'tick', now: (index + 1) * TICK })
  }
  return script
}

/** 边角：空 delta、未知行 feed、reset 整发、无欠账连 tick。 */
function edgeScript(): Op[] {
  return [
    { op: 'reset', rows: [{ key: 'm1', text: 'hello' }], at: 0 },
    { op: 'feed', key: 'm1', delta: '' },
    { op: 'feed', key: 'm2', delta: '新行' },
    { op: 'tick', now: TICK },
    { op: 'reset', rows: [{ key: 'm1', text: 'fresh' }], at: 2 * TICK },
    { op: 'tick', now: 3 * TICK },
    { op: 'tick', now: 4 * TICK },
  ]
}

export function buildStreamingBudgetSuite(ctx: ComputeContextLike): Suite {
  const engineOf = () => new ctx.compute.StreamingRevealEngine() as unknown as {
    reset(rows: ReadonlyArray<{ key: string, text: string }>, at: number): void
    feed(key: string, delta: string): void
    noteBacklog(now: number): void
    tick(now: number): Record<string, unknown>
    revealedText(key: string): string | undefined
    mirrorText(key: string): string | undefined
    free(): void
  }
  return {
    domain: 'streaming-budget',
    pairs: [
      {
        name: 'StreamingRevealEngine(replay)',
        domain: 'streaming-budget',
        ts: script => replayTs(script),
        wasm: (script) => {
          const engine = engineOf()
          try {
            return replayWasm(engine, script)
          } finally {
            engine.free()
          }
        },
        cases: [
          { id: 'edge-reset-feed-tick', meta: { edge: true, flow: 'replay-script' }, build: () => edgeScript() },
          { id: 'smooth-s', meta: { scale: 's', flow: 'replay-script' }, build: () => smoothStream(50) },
          { id: 'smooth-m', meta: { scale: 'm', flow: 'replay-script' }, build: () => smoothStream(400) },
          { id: 'long-stream', meta: { scale: 'l', flow: 'replay-script' }, build: () => longStream() },
          { id: 'burst-drain', meta: { scale: 's', flow: 'replay-script' }, build: () => burstStream() },
          { id: 'multi-row-d1', meta: { scale: 's', shape: 'multi-row', flow: 'replay-script' }, build: () => multiRowStream() },
          { id: 'astral-grapheme', meta: { scale: 's', shape: 'astral', edge: true, flow: 'replay-script' }, build: () => astralStream() },
        ],
      },
      {
        // 节奏选项变体：构造期归一化（positiveFinite/floor/max）与派生常量同源。
        name: 'StreamingRevealEngine(options)',
        domain: 'streaming-budget',
        ts: input => replayTs(input.script, input.options),
        wasm: (input) => {
          const engine = new ctx.compute.StreamingRevealEngine(input.options) as unknown as {
            reset(rows: ReadonlyArray<{ key: string, text: string }>, at: number): void
            feed(key: string, delta: string): void
            noteBacklog(now: number): void
            tick(now: number): Record<string, unknown>
            revealedText(key: string): string | undefined
            mirrorText(key: string): string | undefined
            free(): void
          }
          try {
            return replayWasm(engine, input.script)
          } finally {
            engine.free()
          }
        },
        cases: [
          {
            id: 'options-fast',
            meta: { shape: 'options', flow: 'replay-script' },
            build: () => ({
              script: burstStream().slice(0, 20),
              options: { maxUpdatesPerSecond: 144, revealUnitsPerSecond: 600, maxRevealUnitsPerTick: 32, maxRevealLagMs: 200 },
            }),
          },
          {
            id: 'options-invalid-fallback',
            meta: { shape: 'options', edge: true, flow: 'replay-script' },
            build: () => ({
              script: burstStream().slice(0, 20),
              options: { maxUpdatesPerSecond: -5, revealUnitsPerSecond: Number.NaN, maxRevealUnitsPerTick: 0.5, maxRevealLagMs: 0 },
            }),
          },
          {
            id: 'options-defaults',
            meta: { shape: 'options', flow: 'replay-script' },
            build: () => ({ script: burstStream().slice(0, 20), options: {} }),
          },
        ],
      },
    ],
  }
}
