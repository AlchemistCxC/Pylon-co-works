import { describe, expect, it } from 'vitest'
import { beginLoadLock, createLoadLockState, finishLoadLock, isSendBlockedDuringLoad, shouldFlushQueuedSource } from '../loadAttempt'

describe('stale-safe load lock', () => {
  it('旧 generation 不得释放新 attempt', () => {
    let state = createLoadLockState()
    const first = beginLoadLock(state, 'A')
    state = first.state
    const second = beginLoadLock(state, 'A')
    state = second.state
    expect(finishLoadLock(state, 'A', first.generation).finished).toBeUndefined()
    expect(isSendBlockedDuringLoad(state, 'A')).toBe(true)
    const finished = finishLoadLock(state, 'A', second.generation)
    expect(finished.finished).toEqual({ source: 'A', generation: second.generation })
    expect(isSendBlockedDuringLoad(finished.state, 'A')).toBe(false)
  })

  it('不同 source 的 lock 相互隔离', () => {
    let state = createLoadLockState()
    const a = beginLoadLock(state, 'A')
    state = a.state
    const b = beginLoadLock(state, 'B')
    state = b.state
    state = finishLoadLock(state, 'A', a.generation).state
    expect(isSendBlockedDuringLoad(state, 'A')).toBe(false)
    expect(isSendBlockedDuringLoad(state, 'B')).toBe(true)
  })

  it('只有同 source 的 load-finished 才能 flush 当前 queue', () => {
    expect(shouldFlushQueuedSource({ source: 'A', generation: 1 }, 'A')).toBe(true)
    expect(shouldFlushQueuedSource({ source: 'A', generation: 1 }, 'B')).toBe(false)
    expect(shouldFlushQueuedSource({ source: 'A', generation: 1 }, null)).toBe(false)
  })
})
