/**
 * settleListeners 行为测试（FE-AUD-024 + G1）：
 * 全成功保留全部 handle；部分失败保留成功 handle 并返回 failures（可重试）；
 * 全失败空数组。
 */
import { describe, expect, it, vi } from 'vitest'
import { settleListeners } from '../chatEventController'

describe('settleListeners', () => {
  it('全部成功：保留全部 stop handle，无失败', async () => {
    const stop1 = vi.fn()
    const stop2 = vi.fn()
    const onRejected = vi.fn()
    const result = await settleListeners([Promise.resolve(stop1), Promise.resolve(stop2)], onRejected)
    expect(result.fns).toEqual([stop1, stop2])
    expect(result.failures).toEqual([])
    expect(onRejected).not.toHaveBeenCalled()
  })

  it('部分失败：保留成功 handle，failures 含 index/reason（G1 可重试）', async () => {
    const stop1 = vi.fn()
    const onRejected = vi.fn()
    const result = await settleListeners(
      [Promise.resolve(stop1), Promise.reject(new Error('listen a down')), Promise.reject(new Error('listen b down'))],
      onRejected,
    )
    expect(result.fns).toEqual([stop1])
    expect(result.failures).toHaveLength(2)
    expect(result.failures[0]?.index).toBe(1)
    expect(result.failures[0]?.reason).toBeInstanceOf(Error)
    expect(result.failures[1]?.index).toBe(2)
    expect(onRejected).toHaveBeenCalledTimes(2)
  })

  it('全部失败：空 fns，failures 全量', async () => {
    const onRejected = vi.fn()
    const result = await settleListeners([Promise.reject(new Error('down'))], onRejected)
    expect(result.fns).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(onRejected).toHaveBeenCalledTimes(1)
  })
})
