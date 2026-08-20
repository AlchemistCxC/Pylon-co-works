import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { AgentSidebarRegistry } from '../sidebarRegistry.ts'
import { createPluginSidebarApi } from '../pluginSidebarApi.ts'

const Panel = () => null

function contribution(id: string, mode: 'work' | 'chat') {
  return { id, mode, label: id, renderKind: 'first-party-react' as const, component: Panel }
}

describe('AgentSidebarRegistry', () => {
  it('按 ReactiveRegistry 顺序发布并随 scope dispose 回收', async () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'run-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginSidebarApi(registry, identity, scope)
    const listener = vi.fn()
    registry.subscribe(listener)

    api.registerAgentSidebarContribution(contribution('work-a', 'work'))
    api.registerAgentSidebarContribution(contribution('chat-a', 'chat'))

    expect(registry.list('work').map(item => item.id)).toEqual(['work-a'])
    expect(registry.getSnapshot().entries.every(entry => entry.ownerRuntimeInstanceId === identity.key)).toBe(true)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('shadow transaction commit 前隔离候选，commit/revert 精确切换 owner', () => {
    const registry = new AgentSidebarRegistry()
    const oldOwner = createPluginIdentity('test.sidebar', 'old')
    const nextOwner = createPluginIdentity('test.sidebar', 'next')
    registry.register(oldOwner, contribution('shared', 'work'))
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register(contribution('shared', 'chat'), { contributionId: 'shared' })

    expect(registry.list()[0].mode).toBe('work')
    transaction.commit()
    expect(registry.list()[0].mode).toBe('chat')
    expect(registry.getSnapshot().entries[0].ownerRuntimeInstanceId).toBe(nextOwner.key)
    transaction.revert()
    expect(registry.list()[0].mode).toBe('work')
  })

  it('order 控制同一模式贡献的确定性顺序', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'ordered')
    registry.register(identity, { ...contribution('late', 'work'), order: 200 })
    registry.register(identity, { ...contribution('early', 'work'), order: 100 })
    expect(registry.list('work').map(item => item.id)).toEqual(['early', 'late'])
  })
})
