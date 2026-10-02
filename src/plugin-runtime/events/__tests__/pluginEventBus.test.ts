import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity'
import { PluginEventBus } from '../pluginEventBus'

describe('PluginEventBus', () => {
  it('按事件发布，监听器失败隔离，dispose 后停止接收', async () => {
    const bus = new PluginEventBus()
    const ownerA = createPluginIdentity('p.a', 'run-1')
    const ownerB = createPluginIdentity('p.b', 'run-1')
    const listener = vi.fn()
    bus.subscribe(ownerA, 'test.event', 'a.throw', () => { throw new Error('boom') })
    const handle = bus.subscribe(ownerB, 'test.event', 'b.ok', listener)

    await expect(bus.publish('test.event', { value: 1 })).resolves.toBeUndefined()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      event: 'test.event',
      payload: { value: 1 },
    }))

    await handle.dispose()
    await bus.publish('test.event', { value: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
  // （createPluginEventApi 的 Scope 收纳用例随 pluginEventApi.ts 退役删除——#520 死代码二批。）
})
