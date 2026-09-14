// @vitest-environment jsdom
/**
 * P89 / 施工书 §3.4（S1）：帧对齐的契约锁定。
 *
 * 用户决策 D-A =「保持定时器继续收敛」⇒ 定时器是心跳、窗口隐藏也不停发；
 * 帧对齐只在**页面可见且帧源可用**时生效，并有帧停摆兜底。
 *
 * 覆盖：① 无帧源时等价帧对齐之前（纯定时器）；② 可见时一拍一次且发生在帧内、且合并重复请求；
 * ③ 隐藏态仍持续收敛且不排帧；④ pause/dispose 取消已排的帧；⑤ 终态与收敛路径在新 seam 下仍不整块倒出；
 * ⑥ 帧源停摆时回落到直接发布（心跳优先）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_STREAMING_DISPLAY_OPTIONS, createStreamingDisplayScheduler } from '../streamingDisplayScheduler.ts'
import type { StreamingDisplayFrameSource } from '../streamingDisplayScheduler.ts'
import type { WorkbenchRuntimeSnapshot } from '../../../domains/workbench/workbenchRuntime.ts'

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

/** 手动帧泵：不自动交付，由测试显式 pump（模拟 rAF 何时到来）。 */
function createFramePump() {
  const pending = new Set<() => void>()
  const source: StreamingDisplayFrameSource = callback => {
    pending.add(callback)
    return () => pending.delete(callback)
  }
  return {
    source,
    pump(times = 1) {
      for (let index = 0; index < times; index += 1) {
        const callback = pending.values().next().value
        if (callback === undefined) return
        pending.delete(callback)
        callback()
      }
    },
    pendingCount: () => pending.size,
  }
}

function hideVisibilityState() {
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  return () => {
    if (original === undefined) delete (document as unknown as Record<string, unknown>).visibilityState
    else Object.defineProperty(document, 'visibilityState', original)
  }
}

describe('streaming display frame alignment (P89/S1)', () => {
  const schedulers: ReturnType<typeof createStreamingDisplayScheduler>[] = []
  const restoreFrameGlobals: Array<() => void> = []

  afterEach(() => {
    for (const scheduler of schedulers.splice(0)) scheduler.dispose()
    for (const restore of restoreFrameGlobals.splice(0)) restore()
    vi.useRealTimers()
  })

  function removeAnimationFrame() {
    const scope = window as unknown as Record<string, unknown>
    const request = scope.requestAnimationFrame
    const cancel = scope.cancelAnimationFrame
    delete scope.requestAnimationFrame
    delete scope.cancelAnimationFrame
    restoreFrameGlobals.push(() => {
      scope.requestAnimationFrame = request
      scope.cancelAnimationFrame = cancel
    })
  }

  it('publishes on the timer when the host has no frame source', () => {
    vi.useFakeTimers()
    removeAnimationFrame()
    const published: number[] = []
    const scheduler = createStreamingDisplayScheduler(
      value => published.push(value.messages[0]?.content.length ?? 0),
      { now: () => Date.now() },
    )
    schedulers.push(scheduler)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(30))] }))
    vi.advanceTimersByTime(TICK_MS)
    expect(published.length).toBe(2)
    expect(published.at(-1)).toBeGreaterThan(0)
  })

  it('aligns to one publication per frame while visible and coalesces pending requests', () => {
    vi.useFakeTimers()
    const pump = createFramePump()
    const published: number[] = []
    const scheduler = createStreamingDisplayScheduler(
      value => published.push(value.messages[0]?.content.length ?? 0),
      { now: () => Date.now(), frame: pump.source },
    )
    schedulers.push(scheduler)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    const afterInitial = published.length

    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(30))] }))
    vi.advanceTimersByTime(TICK_MS)
    // 到期只排帧、不直接发布；等帧期间重复到期（未跨两拍停摆阈值）不叠加请求。
    expect(published.length).toBe(afterInitial)
    expect(pump.pendingCount()).toBe(1)
    vi.advanceTimersByTime(TICK_MS / 2)
    expect(pump.pendingCount()).toBe(1)
    expect(published.length).toBe(afterInitial)

    pump.pump(1)
    expect(published.length).toBe(afterInitial + 1)
    expect(published.at(-1)).toBeGreaterThan(0)
  })

  it('keeps converging while the page is hidden and requests no frames (D-A)', () => {
    vi.useFakeTimers()
    const restoreVisibility = hideVisibilityState()
    restoreFrameGlobals.push(restoreVisibility)
    const pump = createFramePump()
    const published: number[] = []
    const scheduler = createStreamingDisplayScheduler(
      value => published.push(value.messages[0]?.content.length ?? 0),
      { now: () => Date.now(), frame: pump.source },
    )
    schedulers.push(scheduler)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    const afterInitial = published.length
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(120))] }))
    for (let index = 0; index < 6; index += 1) vi.advanceTimersByTime(TICK_MS)
    // 隐藏也能继续收敛，而且不排帧。
    expect(published.length).toBeGreaterThan(afterInitial + 1)
    expect(pump.pendingCount()).toBe(0)
    expect(published.at(-1)).toBeGreaterThan(0)
  })

  it('cancels a pending frame on pause and on dispose', () => {
    vi.useFakeTimers()
    const pump = createFramePump()
    const scheduler = createStreamingDisplayScheduler(() => {}, { now: () => Date.now(), frame: pump.source })
    schedulers.push(scheduler)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(30))] }))
    vi.advanceTimersByTime(TICK_MS)
    expect(pump.pendingCount()).toBe(1)
    scheduler.pause()
    expect(pump.pendingCount()).toBe(0)

    scheduler.resume(snapshot({ generating: true, messages: [message('x'.repeat(30))] }))
    scheduler.push(snapshot({ generating: true, messages: [message('x'.repeat(60))] }))
    vi.advanceTimersByTime(TICK_MS)
    scheduler.dispose()
    expect(pump.pendingCount()).toBe(0)
  })

  it('still refuses to paint a whole block on the terminal publication under the frame seam', async () => {
    vi.useFakeTimers()
    const pump = createFramePump()
    const published: string[] = []
    const scheduler = createStreamingDisplayScheduler(
      value => published.push(value.messages[0]?.content ?? ''),
      { now: () => Date.now(), frame: pump.source },
    )
    schedulers.push(scheduler)
    const complete = 'x'.repeat(2000)
    scheduler.push(snapshot({ generating: true, messages: [message('')] }))
    scheduler.push(snapshot({ generating: true, messages: [message(complete)] }))
    vi.advanceTimersByTime(TICK_MS)
    pump.pump(1)
    const terminal = snapshot({
      generating: false,
      summary: { elapsedMs: 1, tokenCount: 1, completedFrame: '', reason: 'done' },
      messages: [message(complete, false)],
    })
    scheduler.push(terminal)
    // 终态发布走微任务合并：必须 await 才会落地（与既有用例同构）
    await Promise.resolve()
    const last = published.at(-1) ?? ''
    expect(last.length).toBeGreaterThan(0)
    expect(last.length).toBeLessThan(complete.length)
    for (let index = 0; index < 80; index += 1) {
      vi.advanceTimersByTime(TICK_MS)
      pump.pump(2)
    }
    expect(published.at(-1)).toBe(complete)
  })

  it('falls back to the timer when the frame source stalls', () => {
    vi.useFakeTimers()
    const stalled: Array<() => void> = []
    const published: number[] = []
    const counting = createStreamingDisplayScheduler(
      value => published.push(value.messages[0]?.content.length ?? 0),
      { now: () => Date.now(), frame: callback => { stalled.push(callback); return () => {} } },
    )
    schedulers.push(counting)
    counting.push(snapshot({ generating: true, messages: [message('')] }))
    const afterInitial = published.length
    counting.push(snapshot({ generating: true, messages: [message('x'.repeat(500))] }))
    // 帧一帧都不来：超过两拍后必须直接发布（心跳优先）
    for (let index = 0; index < 4; index += 1) vi.advanceTimersByTime(TICK_MS)
    expect(stalled.length).toBeGreaterThan(0)
    expect(published.length).toBeGreaterThan(afterInitial)
  })
})
