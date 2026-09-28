import { describe, expect, it, vi } from 'vitest'
import { drainPersistentStateBeforeClose } from '../drainPersistentStateBeforeClose'

describe('drainPersistentStateBeforeClose', () => {
  it('等待 identity 持久化链完成（#439 起 canonical 自写轨退役，只剩 identity 一条链）', async () => {
    const order: string[] = []
    await drainPersistentStateBeforeClose({
      flushIdentity: async () => { order.push('identity') },
    })
    expect(order).toEqual(['identity'])
  })

  it('identity 失败时向调用方传播失败', async () => {
    await expect(drainPersistentStateBeforeClose({
      flushIdentity: async () => { throw new Error('identity failed') },
    })).rejects.toThrow('identity failed')
  })

  it('超过总预算时返回结构化 timeout，窗口生命周期不得永久挂起', async () => {
    vi.useFakeTimers()
    const draining = drainPersistentStateBeforeClose({
      flushIdentity: () => new Promise<void>(() => undefined),
    }, { timeoutMs: 100 })
    const assertion = expect(draining).rejects.toMatchObject({
      code: 'persistence_drain_timeout',
    })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    vi.useRealTimers()
  })
})
