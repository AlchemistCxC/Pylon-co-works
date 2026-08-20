import { describe, expect, it, vi } from 'vitest'
import { drainPersistentStateBeforeClose } from '../drainPersistentStateBeforeClose'

describe('drainPersistentStateBeforeClose', () => {
  it('同时等待 canonical 与 identity 两条持久化链', async () => {
    const order: string[] = []
    await drainPersistentStateBeforeClose({
      flushCanonical: async () => { order.push('canonical') },
      flushIdentity: async () => { order.push('identity') },
    })
    expect(order).toEqual(expect.arrayContaining(['canonical', 'identity']))
  })

  it('任一链失败时仍等待另一链，并向调用方传播聚合失败', async () => {
    const flushIdentity = vi.fn(async () => undefined)
    await expect(drainPersistentStateBeforeClose({
      flushCanonical: async () => { throw new Error('canonical failed') },
      flushIdentity,
    })).rejects.toThrow('canonical failed')
    expect(flushIdentity).toHaveBeenCalledTimes(1)
  })

  it('超过总预算时返回结构化 timeout，窗口生命周期不得永久挂起', async () => {
    vi.useFakeTimers()
    const draining = drainPersistentStateBeforeClose({
      flushCanonical: () => new Promise<void>(() => undefined),
      flushIdentity: async () => undefined,
    }, { timeoutMs: 100 })
    const assertion = expect(draining).rejects.toMatchObject({
      code: 'persistence_drain_timeout',
    })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    vi.useRealTimers()
  })
})
