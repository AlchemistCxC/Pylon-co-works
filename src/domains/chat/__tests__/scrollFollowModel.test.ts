import { describe, expect, it } from 'vitest'
import {
  classifyScrollEvent,
  INSTANT_LOCK_MS,
  SCROLL_TRACE_THRESHOLD_PX,
  scrollTraceThreshold,
  SMOOTH_LOCK_MS,
  type ScrollWriteTrace,
} from '../scrollFollowModel.ts'

/**
 * P57 S1.1（R-C1）验收 ④：classifyScrollEvent 纯函数表驱动断言——
 * 2px 阈值边界、无迹、DPR 兜底；锁窗常量随模块迁移（scrollFollowState 退役）。
 */
describe('scrollFollowModel', () => {
  it.each([
    ['no trace → user', 300, undefined, 2, 'user'],
    ['exact trace top → feedback', 300, { top: 300, at: 0 }, 2, 'programmatic-feedback'],
    ['within threshold (+2) → feedback', 302, { top: 300, at: 0 }, 2, 'programmatic-feedback'],
    ['within threshold (−2) → feedback', 298, { top: 300, at: 0 }, 2, 'programmatic-feedback'],
    ['just past threshold (+2.01) → user', 302.01, { top: 300, at: 0 }, 2, 'user'],
    ['just past threshold (−2.01) → user', 297.99, { top: 300, at: 0 }, 2, 'user'],
    ['sub-pixel jitter (0.5) → feedback', 300.5, { top: 300, at: 0 }, 2, 'programmatic-feedback'],
    ['far scroll → user', 100, { top: 300, at: 0 }, 2, 'user'],
    ['wide threshold admits larger delta → feedback', 310, { top: 300, at: 0 }, 10, 'programmatic-feedback'],
  ])('%s', (_name, scrollTop, trace, threshold, expected) => {
    expect(classifyScrollEvent(scrollTop as number, trace as ScrollWriteTrace | undefined, threshold as number)).toBe(expected)
  })

  it('2px 阈值边界：恰在阈值内算程序化反馈，超出即判用户', () => {
    const trace: ScrollWriteTrace = { top: 700, at: 12 }
    expect(classifyScrollEvent(700 + SCROLL_TRACE_THRESHOLD_PX, trace)).toBe('programmatic-feedback')
    expect(classifyScrollEvent(700 - SCROLL_TRACE_THRESHOLD_PX, trace)).toBe('programmatic-feedback')
    expect(classifyScrollEvent(700 + SCROLL_TRACE_THRESHOLD_PX + 0.001, trace)).toBe('user')
  })

  it('scrollTraceThreshold 兜底：默认 2px，DPR>4 时按 0.5×DPR 放宽', () => {
    expect(scrollTraceThreshold(undefined)).toBe(2)
    expect(scrollTraceThreshold(1)).toBe(2)
    expect(scrollTraceThreshold(2)).toBe(2)
    expect(scrollTraceThreshold(5)).toBe(2.5)
  })

  it('锁窗常量随模块迁移且语义不变（smooth 500 / instant 50）', () => {
    expect(SMOOTH_LOCK_MS).toBe(500)
    expect(INSTANT_LOCK_MS).toBe(50)
  })
})
