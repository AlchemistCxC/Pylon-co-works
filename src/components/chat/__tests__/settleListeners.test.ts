/**
 * settleListeners 行为测试（FE-AUD-024）：
 * 全成功保留全部 handle；部分失败保留成功 handle 并逐个报告失败；全失败空数组。
 */
import { describe, expect, it, vi } from 'vitest'
import { settleListeners } from '../chatEventController'

describe('settleListeners', () => {
  it('全部成功：保留全部 stop handle，无失败报告', async () => {
    const stop1 = vi.fn()
    const stop2 = vi.fn()
    const onRejected = vi.fn()
    const fns = await settleListeners([Promise.resolve(stop1), Promise.resolve(stop2)], onRejected)
    expect(fns).toEqual([stop1, stop2])
    expect(onRejected).not.toHaveBeenCalled()
  })

  it('部分失败：保留成功 handle，逐个报告失败（index/reason）', async () => {
    const stop1 = vi.fn()
    const onRejected = vi.fn()
    const fns = await settleListeners(
      [Promise.resolve(stop1), Promise.reject(new Error('listen a down')), Promise.reject(new Error('listen b down'))],
      onRejected,
    )
    expect(fns).toEqual([stop1])
    expect(onRejected).toHaveBeenCalledTimes(2)
    expect(onRejected).toHaveBeenNthCalledWith(1, expect.any(Error), 1)
    expect(onRejected).toHaveBeenNthCalledWith(2, expect.any(Error), 2)
  })

  it('全部失败：空数组（dispose 无残留清理）', async () => {
    const onRejected = vi.fn()
    const fns = await settleListeners([Promise.reject(new Error('down'))], onRejected)
    expect(fns).toEqual([])
    expect(onRejected).toHaveBeenCalledTimes(1)
  })
})
