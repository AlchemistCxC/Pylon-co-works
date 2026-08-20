import { describe, expect, it, vi } from 'vitest'
import { PluginScope } from '../pluginScope'

describe('PluginScope', () => {
  it('disposeNow waits for async disposal and returns stable cleanup errors', async () => {
    let rejectDisposal!: (error: Error) => void
    const scope = new PluginScope('builtin.test@async-dispose')
    scope.add(
      () => new Promise<void>((_resolve, reject) => { rejectDisposal = reject }),
      { resourceId: 'async-resource', label: 'async fixture' },
    )

    const disposal = scope.disposeNow()
    expect(disposal).toBeInstanceOf(Promise)
    let settled = false
    void disposal.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    rejectDisposal(new Error('late cleanup failure'))
    await expect(disposal).resolves.toMatchObject({
      disposed: 0,
      remaining: 1,
      errors: [{ resourceId: 'async-resource', message: 'late cleanup failure' }],
    })
  })

  it('按注册逆序统一回收 Disposable，重复 dispose 幂等', async () => {
    const calls: string[] = []
    const scope = new PluginScope('builtin.test@instance-1')
    scope.add(() => { calls.push('first') })
    scope.add(() => { calls.push('second') })
    scope.add({ dispose: () => { calls.push('third') } })

    const first = await scope.dispose()
    const second = await scope.dispose()

    expect(calls).toEqual(['third', 'second', 'first'])
    expect(first).toMatchObject({ disposed: 3, errors: [] })
    expect(second).toMatchObject({ disposed: 0, errors: [] })
  })

  it('回收项抛错不阻断后续资源释放', async () => {
    const calls: string[] = []
    const scope = new PluginScope('builtin.test@instance-1')
    scope.add(() => { calls.push('survivor') })
    scope.add(() => { throw new Error('dispose boom') })

    const result = await scope.dispose()

    expect(calls).toEqual(['survivor'])
    expect(result).toMatchObject({
      disposed: 1,
      remaining: 1,
      errors: [{ message: 'dispose boom' }],
    })
  })

  it('retry disposes only residual failures and never repeats successful resources', async () => {
    const calls: string[] = []
    let failingAttempts = 0
    const scope = new PluginScope('builtin.test@retry')
    scope.add(() => { calls.push('first') }, { resourceId: 'first' })
    scope.add(() => {
      calls.push('failing')
      failingAttempts += 1
      if (failingAttempts === 1) throw new Error('transient')
    }, { resourceId: 'failing' })
    scope.add(() => { calls.push('last') }, { resourceId: 'last' })

    await expect(scope.dispose()).resolves.toMatchObject({ disposed: 2, remaining: 1 })
    await expect(scope.dispose()).resolves.toMatchObject({ disposed: 1, remaining: 0, errors: [] })

    expect(calls).toEqual(['last', 'failing', 'first', 'failing'])
  })

  it('统一管理 event listener、timer 与 AbortController', async () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const handler = vi.fn()
    const timeoutHandler = vi.fn()
    const intervalHandler = vi.fn()
    const scope = new PluginScope('builtin.test@instance-1')

    scope.listen(target, 'ping', handler)
    scope.setTimeout(timeoutHandler, 20)
    scope.setInterval(intervalHandler, 10)
    const controller = scope.createAbortController()

    target.dispatchEvent(new Event('ping'))
    await vi.advanceTimersByTimeAsync(20)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(timeoutHandler).toHaveBeenCalledTimes(1)
    expect(intervalHandler).toHaveBeenCalledTimes(2)

    await scope.dispose()
    target.dispatchEvent(new Event('ping'))
    await vi.advanceTimersByTimeAsync(20)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(intervalHandler).toHaveBeenCalledTimes(2)
    expect(controller.signal.aborted).toBe(true)
    vi.useRealTimers()
  })

  it('scope 释放后拒绝登记新资源', async () => {
    const scope = new PluginScope('builtin.test@instance-1')
    await scope.dispose()
    expect(() => scope.add(() => {})).toThrow('已释放')
  })
})
