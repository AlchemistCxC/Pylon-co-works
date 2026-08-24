import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { ContextPanelRegistry } from '../contextPanelRegistry.ts'
import { createPluginContextPanelApi } from '../pluginContextPanelApi.ts'
import { selectAvailableContextPanels } from '../contextPanelSelection.ts'

const Panel = () => null

function contribution(id: string, workspaceKind: string, order: number) {
  return { id, workspaceKind, order, label: id, renderKind: 'first-party-react' as const, component: Panel }
}

describe('ContextPanelRegistry', () => {
  it('统一按 workspace 与 when 选择当前可用贡献', () => {
    const registry = new ContextPanelRegistry()
    const identity = createPluginIdentity('test.context.when', 'run-1')
    registry.register(identity, {
      ...contribution('session-only', 'agent', 100),
      when: context => context.activeSessionId !== null,
    })

    expect(selectAvailableContextPanels(registry.getSnapshot().entries, {
      workspaceKind: 'agent', sheetId: 'sheet-a', activeSessionId: null,
    })).toEqual([])
    expect(selectAvailableContextPanels(registry.getSnapshot().entries, {
      workspaceKind: 'agent', sheetId: 'sheet-a', activeSessionId: 'session-a',
    }).map(entry => entry.contributionId)).toEqual(['session-only'])
  })

  it('when 异常时隔离贡献并留下可诊断错误', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = new ContextPanelRegistry()
    registry.register(createPluginIdentity('test.context.bad-when', 'run-1'), {
      ...contribution('bad-when', 'agent', 100),
      when: () => { throw new Error('bad availability predicate') },
    })

    expect(selectAvailableContextPanels(registry.getSnapshot().entries, {
      workspaceKind: 'agent', sheetId: 'sheet-a', activeSessionId: null,
    })).toEqual([])
    expect(report).toHaveBeenCalledWith('右栏贡献 bad-when 判断可用性失败', expect.any(Error))
  })

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
