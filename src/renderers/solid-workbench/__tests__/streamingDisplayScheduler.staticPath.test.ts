/**
 * #212 判据 A / C：重放与直播的分流（静态路径）。
 *
 * 症状：打开/切换会话时历史正文逐字铺开（128 UTF-16 单位/拍 ⇒ 约 7.7k 字符/秒），
 * 且被揭示的行每拍整段重解析（静态路径不走 graft）——单条 2 万字符要 2.6s。
 *
 * 判据 A（发表姿态）：预算插值只在「本拍有直播语义」时使用——`generating === true`
 *  或已有行处于揭示中（`midReveal`）。一批**已完成**的历史整发上屏。
 * 判据 C（增长集合）：把「同一行文本在两次发布之间变长」记成 `revealingRows()`，
 *  渲染层据此把该行留在增量路径；新出现的行不算「在长」（活性由权威判据负责）。
 *
 * 两侧边界同样被钉住：直播中的新行仍按预算揭示；终态交接仍不整块倒出。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STREAMING_DISPLAY_OPTIONS, createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { StreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'
import { createWorkbenchDocument, type WorkbenchMessage } from '../../../domains/workbench/workbenchProjector.ts'

const TICK_MS = 1000 / DEFAULT_STREAMING_DISPLAY_OPTIONS.maxUpdatesPerSecond + 1

function snapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: 'session-a', ownerKey: 'owner-a', generation: 1,
    status: 'ready', messages: [], generating: false, generationStart: 0, tokenCount: 0, summary: null,
    tasks: [], availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

const message = (id: string, content: string, running = true) => ({
  id, role: 'assistant' as const, sender: 'test', content, time: '', running,
})

/** 与 `streamingDisplayScheduler.test.ts` 同一口径：假定时器 + `Date.now()` 时钟。 */
function setup() {
  vi.useFakeTimers()
  const published: WorkbenchRuntimeSnapshot[] = []
  const scheduler = createStreamingDisplayScheduler(value => published.push(value), { now: () => Date.now() })
  schedulers.push(scheduler)
  return { scheduler, published }
}

const schedulers: StreamingDisplayScheduler[] = []
afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.dispose()
  vi.useRealTimers()
})

describe('#212 判据 A · 历史整发', () => {
  it('非生成态下整量出现的历史一次上屏，不进预算插值', () => {
    const { scheduler, published } = setup()
    const long = 'x'.repeat(20_000)
    scheduler.push(snapshot({ messages: [] }))
    const before = published.length

    scheduler.push(snapshot({ messages: [message('m1', long, false)] }))

    expect(published).toHaveLength(before + 1)
    expect(published.at(-1)!.messages[0]!.content).toBe(long)
    expect(scheduler.diagnostics().lastPublicationKind).toBe('whole')
    expect(scheduler.diagnostics().historyPublications).toBe(1)
  })

  it('多行历史（含 reasoning）同样一次上屏', () => {
    const { scheduler, published } = setup()
    const text = (n: number) => 'y'.repeat(n)
    scheduler.push(snapshot({ messages: [] }))
    scheduler.push(snapshot({
      messages: [
        { id: 'r1', role: 'reasoning', sender: 'test', content: text(3000), time: '', running: false },
        { id: 'm1', role: 'assistant', sender: 'test', content: text(5000), time: '', running: false },
      ] as never,
    }))
    expect(published.at(-1)!.messages.map(item => item.content.length)).toEqual([3000, 5000])
    expect(scheduler.diagnostics().historyPublications).toBe(1)
  })

  it('暂停期间攒下的历史在 resume 时整发（不从预算里爬）', () => {
    const { scheduler, published } = setup()
    const long = 'x'.repeat(9000)
    scheduler.push(snapshot({ generating: true, messages: [message('m1', '')] }))
    scheduler.pause()
    // 后台期间回合结束，历史整量到位
    scheduler.push(snapshot({ generating: false, messages: [message('m1', long, false)] }))
    const before = published.length
    scheduler.resume(snapshot({ generating: false, messages: [message('m1', long, false)] }))
    expect(published).toHaveLength(before + 1)
    expect(published.at(-1)!.messages[0]!.content).toBe(long)
  })

  it('interpolateHistory 开关是回滚路径：置 true 恢复逐拍揭示', async () => {
    vi.useFakeTimers()
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value), {
      now: () => Date.now(),
      interpolateHistory: true,
    })
    schedulers.push(scheduler)
    const long = 'x'.repeat(20_000)
    scheduler.push(snapshot({ messages: [] }))
    const before = published.length
    scheduler.push(snapshot({ messages: [message('m1', long, false)] }))
    // 非生成态的增长走「终态合并」分支（微任务）⇒ 与既有用例同构，须 await 才落地
    await Promise.resolve()
    const first = published[before]!
    expect(first.messages[0]!.content.length).toBe(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick)
    expect(scheduler.diagnostics().lastPublicationKind).toBe('budgeted')
    expect(scheduler.diagnostics().historyPublications).toBe(0)
  })
})

describe('#212 边界 · 直播侧不变', () => {
  it('直播中的新行仍按预算逐拍揭示', () => {
    const { scheduler, published } = setup()
    const long = 'x'.repeat(20_000)
    scheduler.push(snapshot({ generating: true, messages: [message('m1', '')] }))
    const before = published.length
    scheduler.push(snapshot({ generating: true, messages: [message('m1', long)] }))
    vi.advanceTimersByTime(TICK_MS)
    expect(published[before]!.messages[0]!.content.length).toBe(
      DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick,
    )
    expect(scheduler.diagnostics().historyPublications).toBe(0)
  })

  it('终态交接仍不整块倒出：揭示中的行在 generating=false 后按同一节奏收敛', async () => {
    vi.useFakeTimers()
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value), {
      now: () => Date.now(),
      frame: undefined,
    })
    schedulers.push(scheduler)
    const complete = 'x'.repeat(4000)
    scheduler.push(snapshot({ generating: true, messages: [message('m1', '')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('m1', complete)] }))
    vi.advanceTimersByTime(TICK_MS)
    const revealed = published.at(-1)!.messages[0]!.content.length
    expect(revealed).toBeGreaterThan(0)
    expect(revealed).toBeLessThan(complete.length)

    scheduler.push(snapshot({
      generating: false,
      summary: { elapsedMs: 1, tokenCount: 1, completedFrame: '', reason: 'done' },
      messages: [message('m1', complete, false)],
    }))
    await Promise.resolve()
    // 终态的结构（summary/running）已落地，文本仍在按预算收敛
    expect(published.at(-1)!.messages[0]!.content.length).toBeLessThan(complete.length)
    expect(scheduler.diagnostics().flushes).toBe(0)
    vi.advanceTimersByTime(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs + 400)
    expect(published.at(-1)!.messages[0]!.content).toBe(complete)
  })
})

describe('#212 判据 C · 增长集合', () => {
  it('同一行文本在两次发布之间变长才计入，新出现的行不计入', () => {
    const { scheduler } = setup()
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'a')] }))
    expect(scheduler.revealingRows().size).toBe(0)
    // 新行出现（无参照物）⇒ 不算「在长」
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'a'), message('m2', 'zzz')] }))
    expect([...scheduler.revealingRows()]).toEqual([])
    // 已有行变长 ⇒ 计入
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'abcd'), message('m2', 'zzz')] }))
    expect([...scheduler.revealingRows()]).toEqual(['m1\u0000assistant'])
  })

  it('粘滞到换会话：收敛后仍留在集合里，换会话清空', () => {
    const { scheduler } = setup()
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'a')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'abcd')] }))
    expect(scheduler.revealingRows().has('m1\u0000assistant')).toBe(true)
    // 收敛（无增长、无待揭示）后仍粘滞
    scheduler.push(snapshot({ generating: false, messages: [message('m1', 'abcd', false)] }))
    expect(scheduler.revealingRows().has('m1\u0000assistant')).toBe(true)
    // 换会话 ⇒ 清空
    scheduler.push(snapshot({ sessionId: 'session-b', messages: [] }))
    expect(scheduler.revealingRows().size).toBe(0)
  })

  it('canonical 与 legacy 双列表同源时只记一次账', () => {
    const { scheduler } = setup()
    const documentOf = (content: string) => ({
      ...createWorkbenchDocument('session-a'),
      messages: [{
        id: 'm1', role: 'assistant' as const, content, time: '', running: true,
        parts: [], identity: {}, source: { provider: 'acp', sourceId: 's' }, sequence: 2,
      } as unknown as WorkbenchMessage],
    })
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'a')], document: documentOf('a') }))
    scheduler.push(snapshot({ generating: true, messages: [message('m1', 'abc')], document: documentOf('abc') }))
    expect(scheduler.revealingRows().size).toBe(1)
    expect(scheduler.diagnostics().growingRows).toBe(1)
  })
})
