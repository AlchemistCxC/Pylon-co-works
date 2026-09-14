/**
 * P89 / 施工书 S0：只读诊断读数的行为锁定（无 DOM 部分）。
 *
 * 锁定三件事：
 * 1. counters 与实际发布逐拍一致（含 budgeted/whole 两类与 flushes）；
 * 2. 间隔环形缓冲固定容量，不无界增长；
 * 3. 诊断是**纯读**：反复拉取不改变发布节奏（同一脚本两次跑结果一致）。
 *
 * DOM 夹具与验收桥读数往返（行几何、注册表三态）在
 * `streamingDiagnostics.solid.test.tsx`（Solid 触达文件）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STREAMING_DISPLAY_OPTIONS, createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'

/** 一拍：一个调度器定时器间隔（+1ms 余量，保证恰好走一拍）。 */
const TICK_MS = 1000 / DEFAULT_STREAMING_DISPLAY_OPTIONS.maxUpdatesPerSecond + 1

function snapshot(overrides: Partial<WorkbenchRuntimeSnapshot> = {}): WorkbenchRuntimeSnapshot {
  return {
    revision: 0, sessionId: 'session-a', ownerKey: 'owner-a', generation: 1,
    status: 'ready', messages: [], generating: false, generationStart: 0, tokenCount: 0, summary: null,
    tasks: [], availableModels: [], activeModel: '', availableModes: [], activeMode: '',
    canAttach: false, promptImage: false, error: null, ...overrides,
  }
}

const message = (content: string, running = true) => ({
  id: 'm1', role: 'assistant' as const, sender: 'test', content, time: '', running,
})

describe('streaming display diagnostics counters (P89/S0)', () => {
  const schedulers: ReturnType<typeof createStreamingDisplayScheduler>[] = []
  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose()
    vi.useRealTimers()
  })

  it('counts publications and per-publication units exactly as published', () => {
    vi.useFakeTimers()
    const published: WorkbenchRuntimeSnapshot[] = []
    const scheduler = createStreamingDisplayScheduler(value => published.push(value), { now: () => Date.now() })
    schedulers.push(scheduler)

    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    // 首帧整发：整发不适用预算，故单位字段必须是 null（不得伪造读数）。
    expect(scheduler.diagnostics()).toMatchObject({
      publishes: 1,
      lastPublicationKind: 'whole',
      lastPublicationMaxUnits: null,
      lastPublicationTotalUnits: null,
      flushes: 0,
    })

    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(20))] }))
    vi.advanceTimersByTime(TICK_MS)
    const paced = scheduler.diagnostics()
    expect(paced.publishes).toBe(published.length)
    expect(paced.lastPublicationKind).toBe('budgeted')
    // 单行场景：聚合 = 单行最大。
    expect(paced.lastPublicationTotalUnits).toBe(paced.lastPublicationMaxUnits)
    expect(paced.lastPublicationTotalUnits).toBeGreaterThan(0)
    expect(paced.lastPublicationTotalUnits!).toBeLessThanOrEqual(DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick)
    expect(paced.lastBacklogUnits).toBeGreaterThanOrEqual(paced.lastPublicationTotalUnits!)
    expect(paced.recentPublicationIntervalsMs.length).toBeGreaterThan(0)

    scheduler.flush()
    const flushed = scheduler.diagnostics()
    expect(flushed.publishes).toBe(published.length)
    expect(flushed.lastPublicationKind).toBe('whole')
    expect(flushed.lastPublicationMaxUnits).toBeNull()
    expect(flushed.flushes).toBe(1)
  })

  it('keeps the interval ring at a fixed capacity', () => {
    vi.useFakeTimers()
    const scheduler = createStreamingDisplayScheduler(() => {}, { now: () => Date.now() })
    schedulers.push(scheduler)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    for (let index = 1; index <= 120; index += 1) {
      scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(index))] }))
      vi.advanceTimersByTime(TICK_MS)
    }
    const diagnostics = scheduler.diagnostics()
    expect(diagnostics.publishes).toBeGreaterThan(64)
    expect(diagnostics.recentPublicationIntervalsMs).toHaveLength(64)
    expect(diagnostics.recentPublicationIntervalsMs.every(gap => Number.isFinite(gap) && gap >= 0)).toBe(true)
  })

  it('leaves pacing untouched when the readout is polled', () => {
    const run = (poll: boolean) => {
      vi.useFakeTimers()
      const revealed: number[] = []
      const scheduler = createStreamingDisplayScheduler(
        value => revealed.push(value.messages[0]?.content.length ?? 0),
        { now: () => Date.now() },
      )
      scheduler.push(snapshot({ generating: true, messages: [message('')] }))
      for (let index = 1; index <= 40; index += 1) {
        scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(index * 10))] }))
        vi.advanceTimersByTime(TICK_MS)
        if (poll) {
          scheduler.diagnostics()
          scheduler.diagnostics()
        }
      }
      const diagnostics = scheduler.diagnostics()
      const result = {
        revealed,
        publishes: diagnostics.publishes,
        backlog: diagnostics.lastBacklogUnits,
        budget: diagnostics.lastBudget,
        catchUpWindows: diagnostics.catchUpWindows,
      }
      scheduler.dispose()
      vi.useRealTimers()
      return result
    }
    const polled = run(true)
    const quiet = run(false)
    expect(polled).toEqual(quiet)
    expect(quiet.publishes).toBeGreaterThan(0)
  })
})
