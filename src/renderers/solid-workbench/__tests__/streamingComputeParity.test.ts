/**
 * #220 WP3 parity witness：流式切分 + 揭示预算引擎的 TS↔Rust 差分。
 *
 * 同一输入喂两侧、断言逐项一致（issue 的验收第 1 条：差分 corpus 上逐字节一致）：
 * - 切分：TS 基线 `chat/streamingMarkdownSplit.ts`（纯函数，直接调用）对 WASM
 *   出口——corpus 覆盖 `streamingMarkdownSplit.test.ts` 的全部契约形状 + 四个
 *   调度器测试文件用到的输入形状（纯 ASCII 重复、👩‍💻 字素重复、中文、CRLF），
 *   并做**全前缀扫描**（切分决策只依赖完整行，每个前缀都必须一致）；
 * - 预算引擎：TS 基线 `streamingDisplayScheduler.ts`（真实调度器，注入时钟）对
 *   WASM `StreamingRevealEngine`——先跑 TS 侧录下事件流（reset/feed/noteBacklog/tick，
 *   含每拍时刻与发布内容），再用**同一份事件流**驱动 WASM 引擎，逐拍断言
 *   发布种类、每行揭示前缀、预算与欠账读数、追赶窗口计数全部一致。
 *   镜像单写者的漂移断言在回放中逐 feed 执行（`mirrorText` 必须等于权威目标）。
 *
 * 装载走 `loadPylonCompute()`（blessed loader，Node 宿主自读 wasm 字节）。
 * 流式出口的 TS 类型尚未并入 `PylonCompute` 接口——那是 TS 退役/切流那一刀的
 * 落点（主 agent 统筹），这里先用窄化 cast 消费运行时确实存在的导出。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  findLastStableBlockBoundary as tsFindLastStableBlockBoundary,
  splitOpenCodeFenceTail as tsSplitOpenCodeFenceTail,
  splitStreamingMarkdown as tsSplitStreamingMarkdown,
  splitStreamingMarkdownBlocks as tsSplitStreamingMarkdownBlocks,
} from '../chat/streamingMarkdownSplit.ts'
import { DEFAULT_STREAMING_DISPLAY_OPTIONS, createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { StreamingDisplaySchedulerOptions } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'
import { loadPylonCompute } from '../../../infrastructure/compute/pylonCompute'

// ── WASM 出口（运行时存在；类型收编随 TS 退役那一刀落地） ──────────────────────

interface WasmTail { prefix: string, language?: string, code: string }
interface WasmRowReveal { key: string, value: string, consumedUnits: number }
interface WasmTickOutcome {
  kind: 'budgeted' | 'converged'
  budget: number
  backlogUnits: number
  advancedMaxUnits: number
  advancedTotalUnits: number
  rows: WasmRowReveal[]
  catchUpWindows: number
}
interface WasmRevealEngine {
  reset(rows: { key: string, text: string }[], at: number): void
  feed(key: string, delta: string): void
  noteBacklog(now: number): void
  tick(now: number): WasmTickOutcome
  mirrorText(key: string): string | undefined
  revealedText(key: string): string | undefined
  revealedUnits(key: string): number | undefined
  catchUpWindows(): number
}
interface StreamingComputeExports {
  splitStreamingMarkdownBlocks(text: string): { stableBlocks: string[], unstable: string }
  splitStreamingMarkdown(text: string): { stable: string, unstable: string }
  findLastStableBlockBoundary(text: string): number
  splitOpenCodeFenceTail(text: string): WasmTail | null
  StreamingRevealEngine: { new (options?: Record<string, number>): WasmRevealEngine }
}

const compute = (await loadPylonCompute()) as unknown as StreamingComputeExports

// ── 切分 parity ───────────────────────────────────────────────────────────────

/** corpus：split 契约测试的全部形状 + 调度器四文件的输入形状 + 字素/UTF-16 边角。 */
const SPLIT_CORPUS: readonly string[] = [
  '',
  ' ',
  '\n',
  '\n\n',
  '  \n\n  x',
  '\t\n\n\tx',
  '正在回复的一段话',
  '第一行\n\n第二行片段',
  'A\n\nB',
  'a\n\n\n\nb',
  '头部\n\n```js\nconst x = 1',
  '头部\n\n```js\nconst x = 1\n```\n\n新的片段继续',
  '- 项1\n- 项2\n\n新段落开始',
  '# 前文\n\n1. **开始**\n\n    **后续**\n    正文\n\n新段落',
  '# 前文\n\n10) **开始**\n\n    **后续**\n    正文\n\n新段落',
  '# 前文\n\n- **开始**\n\n    **后续**\n    正文\n\n新段落',
  '# 前文\n\n+ **开始**\n\n    **后续**\n    正文\n\n新段落',
  '# 前文\n\n* **开始**\n\n    **后续**\n    正文\n\n新段落',
  '# 前文\n\n> **开始**\n\n    **后续**\n    正文\n\n新段落',
  '```md\n1. item\n\n> quote\n```\n\ntail',
  '前文\n\n  ````js\nconst a = 1\n```\n```still-code\n\nconst b = 2',
  '第一段\r\n\r\n第二段',
  'a\r\nb\r\n\r\nc',
  '完成\r\n\r\n下一行',
  'x'.repeat(20),
  'y'.repeat(3000),
  '👩‍💻'.repeat(6),
  '👩‍💻a\n\n👩‍💻b',
  '🇺🇸🇯🇵\n\n尾',
  'e\u0301f\n\ng',
  '段落尾随无换行',
  '1. a\n2. b\n3. c',
  '10) x\n\n尾',
  '1234567890. x\n\n尾',
  '    ```ts\nconst a = 1',
  '```ts\nconst a = 1\n```',
  '```bad`info\nconst a = 1',
  '前缀\n  ````ts title\nconst a = 1\n```\nconst b = 2',
  '前缀\r\n~~~ ts\r\nconst a = 1\r\n',
  '~~~ts\nconst a = 1\n~~~~',
  '```ts\nconst a = 1\n~~~',
  '```ts\nconst a = 1\n``` trailing',
]

/**
 * 全前缀扫描：步长 1（短文本）/ 3（长文本，与 #150 fuzz 同款省成本）。
 * astral 字符处对齐到 char 边界（UTF-16 偏移 +1 越过代理对）——孤立代理在 JS 侧
 * 可表示、在 wasm 边界会被 U+FFFD 替换（Rust String 是 UTF-8），不是合法流内容，
 * 不进 corpus（见语义缺口清单）。
 */
function prefixesOf(text: string): string[] {
  const step = text.length > 60 ? 3 : 1
  const prefixes: string[] = []
  for (let end = 0; end <= text.length; end += step) {
    let boundary = end
    while (boundary > 0 && boundary < text.length) {
      const code = text.charCodeAt(boundary - 1)
      if (code >= 0xd800 && code <= 0xdbff && boundary === end) boundary += 1
      else break
    }
    if (boundary > text.length) break
    prefixes.push(text.slice(0, boundary))
  }
  if (prefixes.at(-1) !== text) prefixes.push(text)
  return prefixes
}

describe('切分 parity（splitStreamingMarkdownBlocks / splitStreamingMarkdown / findLastStableBlockBoundary / splitOpenCodeFenceTail）', () => {
  for (const text of SPLIT_CORPUS) {
    it(`corpus 逐前缀一致：${JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…(${text.length})` : text)}`, () => {
      for (const prefix of prefixesOf(text)) {
        const context = `prefix=${JSON.stringify(prefix)}`
        const wasmBlocks = compute.splitStreamingMarkdownBlocks(prefix)
        const tsBlocks = tsSplitStreamingMarkdownBlocks(prefix)
        expect(wasmBlocks.stableBlocks, `stableBlocks ${context}`).toEqual([...tsBlocks.stableBlocks])
        expect(wasmBlocks.unstable, `unstable ${context}`).toBe(tsBlocks.unstable)

        const wasmSplit = compute.splitStreamingMarkdown(prefix)
        const tsSplit = tsSplitStreamingMarkdown(prefix)
        expect(wasmSplit.stable, `stable ${context}`).toBe(tsSplit.stable)
        expect(wasmSplit.unstable, `unstable ${context}`).toBe(tsSplit.unstable)

        expect(
          compute.findLastStableBlockBoundary(prefix),
          `boundary ${context}`,
        ).toBe(tsFindLastStableBlockBoundary(prefix))

        const wasmTail = compute.splitOpenCodeFenceTail(prefix)
        const tsTail = tsSplitOpenCodeFenceTail(prefix)
        if (tsTail === null) {
          expect(wasmTail, `tail ${context}`).toBeNull()
        } else {
          expect(wasmTail, `tail 存在 ${context}`).not.toBeNull()
          expect(wasmTail!.prefix, `tail.prefix ${context}`).toBe(tsTail.prefix)
          expect(wasmTail!.language, `tail.language ${context}`).toBe(tsTail.language)
          expect(wasmTail!.code, `tail.code ${context}`).toBe(tsTail.code)
        }
      }
    })
  }
})

// ── 揭示预算引擎 parity（驱动真实 TS 调度器，回放同一事件流到 WASM 引擎） ────────

/** 一拍：调度间隔 + 1ms 余量（与既有调度器测试同口径）。 */
const TICK_MS = 1000 / DEFAULT_STREAMING_DISPLAY_OPTIONS.maxUpdatesPerSecond + 1

function snapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: 'session-a', ownerKey: 'owner-a', generation: 1,
    status: 'ready', messages: [], generating: false, generationStart: 0, tokenCount: 0, summary: null,
    tasks: [], availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

const message = (id: string, content: string) => ({
  id, role: 'assistant' as const, sender: 'test', content, time: '', running: true,
})

type EngineEvent =
  | { op: 'reset', at: number, rows: { key: string, text: string }[] }
  | { op: 'feed', at: number, key: string, full: string }
  | { op: 'note', at: number }
  | {
    op: 'tick', at: number, first: boolean
    publication: { kind: 'whole' | 'budgeted', rows: string[], budget: number, backlog: number, totalUnits: number | null }
  }

interface DriveResult {
  events: EngineEvent[]
  catchUpWindows: number
  keys: string[]
}

/**
 * 跑 TS 侧真实调度器并录制事件流。注入时钟 + 无帧源（纯定时器路径，Node 宿主
 * 与既有测试同构）；每次 push 后推进恰好一拍，最后排干（或到 maxDrainTicks 上限，
 * 供「单字素 > 单拍上限」这类永不收敛的边角用例对齐两侧停机点）。
 */
function drive(
  options: StreamingDisplaySchedulerOptions,
  specs: { key: string, deltas: string[] }[],
  maxDrainTicks = 80,
): DriveResult {
  vi.useFakeTimers()
  try {
    const events: EngineEvent[] = []
    const keys = specs.map(spec => spec.key)
    const full = new Map<string, string>(keys.map(key => [key, '']))
    let publicationCount = 0
    const scheduler = createStreamingDisplayScheduler(value => {
      const diagnostics = scheduler.diagnostics()
      events.push({
        op: 'tick',
        at: Date.now(),
        first: publicationCount === 0,
        publication: {
          kind: diagnostics.lastPublicationKind,
          rows: value.messages.map(row => row.content),
          budget: diagnostics.lastBudget,
          backlog: diagnostics.lastBacklogUnits,
          totalUnits: diagnostics.lastPublicationTotalUnits,
        },
      })
      publicationCount += 1
    }, { now: () => Date.now(), ...options })

    events.push({ op: 'reset', at: Date.now(), rows: keys.map(key => ({ key, text: '' })) })
    scheduler.push(snapshot({ generating: true, messages: keys.map(key => message(key, '')) }))

    const stepCount = Math.max(...specs.map(spec => spec.deltas.length))
    for (let step = 0; step < stepCount; step += 1) {
      for (const spec of specs) {
        const delta = spec.deltas[step]
        if (!delta) continue
        const next = full.get(spec.key)! + delta
        full.set(spec.key, next)
        const at = Date.now()
        events.push({ op: 'feed', at, key: spec.key, full: next })
        events.push({ op: 'note', at })
        scheduler.push(snapshot({ generating: true, messages: keys.map(key => message(key, full.get(key)!)) }))
      }
      vi.advanceTimersByTime(TICK_MS)
    }
    for (let drained = 0; drained < maxDrainTicks && vi.getTimerCount() > 0; drained += 1) {
      vi.advanceTimersByTime(TICK_MS)
    }
    const catchUpWindows = scheduler.diagnostics().catchUpWindows
    scheduler.dispose()
    return { events, catchUpWindows, keys }
  } finally {
    vi.useRealTimers()
  }
}

/** 用同一份事件流回放 WASM 引擎，逐事件断言两侧一致。 */
function replayWithEngine(result: DriveResult, options?: Record<string, number>): void {
  const { keys } = result
  const engine = new compute.StreamingRevealEngine(options)
  const previousFull = new Map<string, string>(keys.map(key => [key, '']))
  let tickIndex = 0

  for (const event of result.events) {
    if (event.op === 'reset') {
      engine.reset(event.rows, event.at)
      continue
    }
    if (event.op === 'feed') {
      const previous = previousFull.get(event.key) ?? ''
      engine.feed(event.key, event.full.slice(previous.length))
      previousFull.set(event.key, event.full)
      // 文本镜像单写者：镜像必须与权威目标逐字节一致（#55 同类 bug 的断言位）
      expect(engine.mirrorText(event.key), `mirror ${event.key}`).toBe(event.full)
      continue
    }
    if (event.op === 'note') {
      engine.noteBacklog(event.at)
      continue
    }

    const { publication, first, at } = event
    const context = `tick#${tickIndex}@${at}`
    if (first) {
      // 首发整发（push 同步发布，非定时器 tick）：reset 后 revealed 应已等于发布内容
      expect(publication.kind).toBe('whole')
      publication.rows.forEach((content, index) => {
        expect(engine.revealedText(keys[index]) ?? '', `首发 ${keys[index]}`).toBe(content)
      })
      tickIndex += 1
      continue
    }

    const outcome = engine.tick(at)
    const expectedKind = outcome.kind === 'converged' ? 'whole' : 'budgeted'
    expect(expectedKind, `${context} 发布种类`).toBe(publication.kind)
    publication.rows.forEach((rowContent, index) => {
      expect(
        engine.revealedText(keys[index]) ?? '',
        `${context} 行 ${keys[index]} 揭示前缀`,
      ).toBe(rowContent)
    })
    if (outcome.kind === 'budgeted') {
      expect(outcome.budget, `${context} 预算`).toBe(publication.budget)
      expect(outcome.backlogUnits, `${context} 欠账`).toBe(publication.backlog)
      expect(outcome.advancedTotalUnits, `${context} 聚合新增`).toBe(publication.totalUnits)
    }
    tickIndex += 1
  }
  expect(engine.catchUpWindows(), '追赶窗口计数').toBe(result.catchUpWindows)
}

describe('揭示预算引擎 parity（D1/D2/追赶窗口，经真实 TS 调度器差分）', () => {
  it('单行 ASCII 突发：默认节奏逐拍一致', () => {
    const deltas = Array.from({ length: 6 }, () => 'x'.repeat(200))
    const result = drive({}, [{ key: 'm1', deltas }])
    replayWithEngine(result)
  })

  it('单行 astral 突发（D2：UTF-16 计量 + 不劈字素）逐拍一致', () => {
    const deltas = Array.from({ length: 6 }, () => '👩‍💻'.repeat(8))
    const result = drive({}, [{ key: 'm1', deltas }])
    replayWithEngine(result)
  })

  it('三行并发增长（D1：预算逐行递减）逐拍一致', () => {
    const specs = ['m1', 'm2', 'm3'].map(key => ({
      key,
      deltas: Array.from({ length: 5 }, () => 'abcdefghij'.repeat(20)),
    }))
    const result = drive({}, specs)
    replayWithEngine(result)
  })

  it('单字素大于单拍上限（D2 边角：零推进死锁两侧同构）', () => {
    const options = { revealUnitsPerSecond: 1, maxRevealUnitsPerTick: 5 }
    const specs = [{ key: 'm1', deltas: ['👨‍👩‍👧‍👦'.repeat(2), '👨‍👩‍👧‍👦'.repeat(2), '👨‍👩‍👧‍👦'.repeat(2)] }]
    const result = drive({ ...options }, specs, 12)
    replayWithEngine(result, options)
  })

  it('CRLF + 中文 + regional indicator 混排逐拍一致', () => {
    const deltas = ['第一段\r\n\r\n', '👩‍💻🇺🇸e\u0301', '\r\n\r\n尾段', '完成']
    const result = drive({}, [{ key: 'm1', deltas }])
    replayWithEngine(result)
  })

  it('多行交错到达（每拍只到一行，欠账窗口反复延长）逐拍一致', () => {
    const specs = ['m1', 'm2'].map((key, index) => ({
      key,
      deltas: Array.from({ length: 6 }, (_, step) => (step % 2 === index ? 'z'.repeat(260) : '')),
    }))
    const result = drive({}, specs)
    replayWithEngine(result)
  })
})
