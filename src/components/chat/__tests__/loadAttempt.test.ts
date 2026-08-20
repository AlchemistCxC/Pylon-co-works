import { describe, expect, it } from 'vitest'
import { createLoadLockState, beginLoadLock, finishLoadLock, isSendBlockedDuringLoad } from '../loadAttempt'

describe('load attempt contract', () => {
  it('generation 单调递增且结束只释放当前 attempt', () => {
    const state = createLoadLockState()
    const first = beginLoadLock(state, 'A')
    const second = beginLoadLock(first.state, 'A')
    expect(second.generation).toBe(first.generation + 1)
    expect(finishLoadLock(second.state, 'A', first.generation).finished).toBeUndefined()
    const completed = finishLoadLock(second.state, 'A', second.generation)
    expect(completed.finished?.source).toBe('A')
    expect(isSendBlockedDuringLoad(completed.state, 'A')).toBe(false)
  })
})
