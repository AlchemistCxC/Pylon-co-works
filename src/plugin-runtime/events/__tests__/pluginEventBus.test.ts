import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity'
import { PluginScope } from '../../pluginScope'
import { createPluginEventApi } from '../pluginEventApi'
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

  it('PluginEventApi 自动把 subscription 收入 Scope，snapshot 响应式更新', async () => {
    const bus = new PluginEventBus()
    const owner = createPluginIdentity('p.scope-event', 'run-1')
    const scope = new PluginScope(owner.key)
    const api = createPluginEventApi(bus, owner, scope)
    const snapshots = vi.fn()
    bus.subscribeSnapshot(snapshots)

    api.subscribe('scope.event', 'scope.listener', () => undefined)
    expect(bus.getSnapshot().subscriptions).toHaveLength(1)
    expect(scope.size).toBe(1)

    await scope.dispose()
    expect(bus.getSnapshot().subscriptions).toEqual([])
    expect(snapshots).toHaveBeenCalledTimes(2)
  })
})
