import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { AgentSidebarRegistry } from '../sidebarRegistry.ts'
import { createPluginSidebarApi } from '../pluginSidebarApi.ts'
import type { AgentSidebarRegion } from '../sidebarTypes.ts'

const Panel = () => null

function contribution(id: string, region: AgentSidebarRegion) {
  return { id, region, label: id, renderKind: 'first-party-react' as const, component: Panel }
}

describe('AgentSidebarRegistry', () => {
  it('按 ReactiveRegistry 顺序发布并随 scope dispose 回收', async () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'run-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginSidebarApi(registry, identity, scope)
    const listener = vi.fn()
    registry.subscribe(listener)

    api.registerAgentSidebarContribution(contribution('modules-a', 'modules'))
    api.registerAgentSidebarContribution(contribution('sessions-a', 'sessions'))

    expect(registry.list('modules').map(item => item.id)).toEqual(['modules-a'])
    expect(registry.getSnapshot().entries.every(entry => entry.ownerRuntimeInstanceId === identity.key)).toBe(true)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('shadow transaction commit 前隔离候选，commit/revert 精确切换 owner', () => {
    const registry = new AgentSidebarRegistry()
    const oldOwner = createPluginIdentity('test.sidebar', 'old')
    const nextOwner = createPluginIdentity('test.sidebar', 'next')
    registry.register(oldOwner, contribution('shared', 'modules'))
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register(contribution('shared', 'sessions'), { contributionId: 'shared' })

    expect(registry.list()[0].region).toBe('modules')
    transaction.commit()
    expect(registry.list()[0].region).toBe('sessions')
    expect(registry.getSnapshot().entries[0].ownerRuntimeInstanceId).toBe(nextOwner.key)
    transaction.revert()
    expect(registry.list()[0].region).toBe('modules')
  })

  it('order 控制同一分区内贡献的确定性顺序', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'ordered')
    registry.register(identity, { ...contribution('late', 'modules'), order: 200 })
    registry.register(identity, { ...contribution('early', 'modules'), order: 100 })
    expect(registry.list('modules').map(item => item.id)).toEqual(['early', 'late'])
  })

  it('region 非法即拒绝注册', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'invalid')
    expect(() => registry.register(identity, { ...contribution('bad', 'modules'), region: 'work' as AgentSidebarRegion }))
      .toThrow(/region 非法/)
  })

  it('headerActions 校验：id 非空、不重复、label 非空', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'actions')
    const withActions = (headerActions: unknown) => ({ ...contribution('a', 'modules'), headerActions } as never)

    registry.register(identity, withActions([{ id: 'new', label: '新建' }]))
    expect(registry.list('modules')[0].headerActions).toHaveLength(1)
    expect(() => registry.register(identity, withActions([{ id: ' ', label: '新建' }]))).toThrow(/headerActions\[\]\.id/)
    expect(() => registry.register(identity, withActions([{ id: 'new', label: '' }]))).toThrow(/headerActions\[\]\.label/)
    expect(() => registry.register(identity, withActions([{ id: 'new', label: 'A' }, { id: 'new', label: 'B' }]))).toThrow(/headerActions id 重复/)
  })
})
