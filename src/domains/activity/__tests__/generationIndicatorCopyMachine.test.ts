import { describe, expect, it, vi } from 'vitest'
import {
  chooseGenerationIndicatorVerb,
  generationIndicatorCopyText,
  reduceGenerationIndicatorCopy,
} from '../generationIndicatorCopyMachine.ts'

const MIN_DISPLAY_MS = 1_200

describe('generation indicator copy machine', () => {
  it('阶段上下文变化不重置主文案计时，普通切换在到期后显示', () => {
    let state = reduceGenerationIndicatorCopy(undefined, {
      type: 'start', generationId: 'g-1', text: '博大精深', at: 0,
    }, MIN_DISPLAY_MS)
    const shown = state

    state = reduceGenerationIndicatorCopy(state, {
      type: 'context-change', generationId: 'g-1', at: 400,
    }, MIN_DISPLAY_MS)
    expect(state).toBe(shown)

    state = reduceGenerationIndicatorCopy(state, {
      type: 'preset-change', generationId: 'g-1', text: '大道至简', at: 600,
    }, MIN_DISPLAY_MS)
    expect(state.status).toBe('pending')
    expect(generationIndicatorCopyText(state)).toBe('博大精深')
    if (state.status === 'pending') expect(state.dueAt).toBe(1_200)

    state = reduceGenerationIndicatorCopy(state, {
      type: 'preset-change', generationId: 'g-1', text: '博大精深', at: 700,
    }, MIN_DISPLAY_MS)
    expect(state).toMatchObject({ status: 'showing', text: '博大精深', shownAt: 0 })

    state = reduceGenerationIndicatorCopy(state, {
      type: 'preset-change', generationId: 'g-1', text: '大道至简', at: 800,
    }, MIN_DISPLAY_MS)
    expect(state.status).toBe('pending')
    state = reduceGenerationIndicatorCopy(state, {
      type: 'tick', generationId: 'g-1', at: 1_199,
    }, MIN_DISPLAY_MS)
    expect(generationIndicatorCopyText(state)).toBe('博大精深')

    state = reduceGenerationIndicatorCopy(state, {
      type: 'tick', generationId: 'g-1', at: 1_200,
    }, MIN_DISPLAY_MS)
    expect(state).toMatchObject({ status: 'showing', text: '大道至简', shownAt: 1_200 })
  })

  it('waiting/stalled 遵守最短展示时间，恢复 active 不会造成抖动', () => {
    let state = reduceGenerationIndicatorCopy(undefined, {
      type: 'start', generationId: 'g-1', text: '博大精深', at: 0,
    }, MIN_DISPLAY_MS)
    state = reduceGenerationIndicatorCopy(state, {
      type: 'liveness-change', generationId: 'g-1', liveness: 'waiting', text: '等待响应', at: 300,
    }, MIN_DISPLAY_MS)
    expect(state).toMatchObject({ status: 'pending', text: '博大精深', nextText: '等待响应', dueAt: 1_200 })

    state = reduceGenerationIndicatorCopy(state, {
      type: 'liveness-change', generationId: 'g-1', liveness: 'active', text: '博大精深', at: 500,
    }, MIN_DISPLAY_MS)
    expect(state).toMatchObject({ status: 'showing', text: '博大精深', shownAt: 0 })
  })

  it('完成后旧回合的延迟事件不能唤醒新回合', () => {
    let state = reduceGenerationIndicatorCopy(undefined, {
      type: 'start', generationId: 'g-1', text: '旧文案', at: 0,
    }, MIN_DISPLAY_MS)
    state = reduceGenerationIndicatorCopy(state, { type: 'finish', generationId: 'g-1', at: 100 }, MIN_DISPLAY_MS)
    expect(reduceGenerationIndicatorCopy(state, {
      type: 'liveness-change', generationId: 'g-1', liveness: 'active', text: '迟到文案', at: 150,
    }, MIN_DISPLAY_MS)).toBe(state)
    state = reduceGenerationIndicatorCopy(state, {
      type: 'start', generationId: 'g-2', text: '新文案', at: 200,
    }, MIN_DISPLAY_MS)
    const current = state

    expect(reduceGenerationIndicatorCopy(state, {
      type: 'tick', generationId: 'g-1', at: 2_000,
    }, MIN_DISPLAY_MS)).toBe(current)
    expect(reduceGenerationIndicatorCopy(state, {
      type: 'finish', generationId: 'g-1', at: 2_000,
    }, MIN_DISPLAY_MS)).toBe(current)
    expect(generationIndicatorCopyText(current)).toBe('新文案')
  })

  it('只在真正选择时调用随机函数，并保留 Unicode 预设词', () => {
    const random = vi.fn(() => 0.99)
    expect(chooseGenerationIndicatorVerb(['博大精深', '大道至简'], random)).toBe('大道至简')
    expect(random).toHaveBeenCalledTimes(1)
  })
})
