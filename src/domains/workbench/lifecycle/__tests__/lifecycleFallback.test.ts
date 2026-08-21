import { describe, expect, it } from 'vitest'
import {
  applyLifecycleEvent,
  createEmptyLifecycleState,
  normalizeNormalizedError,
  plainLifecycleSummary,
} from '../lifecycleModel.ts'

describe('lifecycle React fallback text selectors (C13)', () => {
  it('summarizes retry/suspend/recovery as readable lines without string parsing', () => {
    let state = createEmptyLifecycleState()
    state = applyLifecycleEvent(state, { type: 'lifecycle.retrying', attempt: 1, maxAttempts: 3, delayMs: 2000, error: { technicalMessage: 'boom', recoverability: 'retry' } as unknown as Parameters<typeof JSON.stringify>[0] })
    expect(plainLifecycleSummary(state)).toContain('[retry] 第 1/3 次重试')
    state = applyLifecycleEvent(state, { type: 'lifecycle.suspended', reason: '等待用户输入' })
    expect(plainLifecycleSummary(state)).toContain('[suspended] 等待用户输入')
    state = applyLifecycleEvent(state, { type: 'lifecycle.recovered', source: 'canonical' })
    expect(plainLifecycleSummary(state)).toBe('')
  })

  it('normalizes unknown error shapes into visible fallback text', () => {
    const error = normalizeNormalizedError('plain string failure')
    expect(error?.userSummary).toBe('plain string failure')
    expect(error?.recoverability).toBe('none')
    expect(normalizeNormalizedError(undefined)).toBeUndefined()
  })
})
