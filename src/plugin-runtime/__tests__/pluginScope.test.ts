import { describe, expect, it, vi } from 'vitest'
import { PluginScope } from '../pluginScope'

describe('PluginScope', () => {
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
    expect(result.disposed).toBe(2)
    expect(result.errors).toHaveLength(1)
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
