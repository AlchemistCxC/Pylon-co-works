import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { ContextPanelRegistry } from '../contextPanelRegistry.ts'
import { createPluginContextPanelApi } from '../pluginContextPanelApi.ts'

const Panel = () => null

function contribution(id: string, workspaceKind: string, order: number) {
  return { id, workspaceKind, order, label: id, renderKind: 'first-party-react' as const, component: Panel }
}

describe('ContextPanelRegistry', () => {
  it('按 order 发布并随插件 scope 回收', async () => {
    const registry = new ContextPanelRegistry()
    const identity = createPluginIdentity('test.context', 'run-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginContextPanelApi(registry, identity, scope)
    const listener = vi.fn()
    registry.subscribe(listener)

    api.register(contribution('late', 'agent', 200))
    api.register(contribution('early', 'agent', 100))

    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['early', 'late'])
    expect(registry.hasForWorkspace('agent')).toBe(true)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('shadow transaction 原子替换右栏贡献并支持 revert', () => {
    const registry = new ContextPanelRegistry()
    const oldOwner = createPluginIdentity('test.context', 'old')
    const nextOwner = createPluginIdentity('test.context', 'next')
    registry.register(oldOwner, contribution('shared', 'agent', 100))
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register(contribution('shared', 'file', 100), { contributionId: 'shared' })

    expect(registry.hasForWorkspace('agent')).toBe(true)
    transaction.commit()
    expect(registry.hasForWorkspace('file')).toBe(true)
    expect(registry.hasForWorkspace('agent')).toBe(false)
    transaction.revert()
    expect(registry.hasForWorkspace('agent')).toBe(true)
  })
})
