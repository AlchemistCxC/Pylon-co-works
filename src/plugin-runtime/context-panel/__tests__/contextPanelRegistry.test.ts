import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { ContextPanelRegistry } from '../contextPanelRegistry.ts'
import { createPluginContextPanelApi } from '../pluginContextPanelApi.ts'
import { selectContextPanels, resolveContextPanelDefault } from '../contextPanelSelection.ts'

const Panel = () => null

function contribution(id: string, workspaceKind: string, order: number) {
  return { id, workspaceKind, order, label: id, renderKind: 'first-party-react' as const, component: Panel }
}

describe('ContextPanelRegistry', () => {
  it('可显示面板只按 when 闸门裁剪——Sheet 种类不再是闸门', () => {
    const registry = new ContextPanelRegistry()
    const identity = createPluginIdentity('test.context.when', 'run-1')
    registry.register(identity, {
      ...contribution('session-only', 'agent', 100),
      when: context => context.activeSessionId !== null,
    })
    registry.register(identity, contribution('file-panel', 'file', 200))

    // 无会话时 `session-only` 被 when 挡住；而「有没有种类亲和」与能否显示无关。
    expect(selectContextPanels(registry.getSnapshot().entries, {
      workspaceKind: 'agent', sheetId: 'sheet-a', activeSessionId: null,
    }).map(entry => entry.contributionId)).toEqual(['file-panel'])
    // agent Sheet 上 file 面板照样可切换：用户实机报「侧栏内部没有切换侧栏种类的按钮」，
    // 根因就是这里按种类裁掉了它。
    expect(selectContextPanels(registry.getSnapshot().entries, {
      workspaceKind: 'agent', sheetId: 'sheet-a', activeSessionId: 'session-a',
    }).map(entry => entry.contributionId)).toEqual(['session-only', 'file-panel'])
  })

  it('Sheet 种类只决定「没选过时默认看谁」：种类亲和 → global → 列表首个', () => {
    const registry = new ContextPanelRegistry()
    const identity = createPluginIdentity('test.context.default', 'run-1')
    registry.register(identity, contribution('agent-panel', 'agent', 100))
    registry.register(identity, contribution('file-panel', 'file', 200))
    registry.register(identity, { ...contribution('anywhere', '', 300), workspaceKind: undefined, scope: 'global' as const })
    const entries = registry.getSnapshot().entries

    expect(resolveContextPanelDefault(entries, 'agent')?.contributionId).toBe('agent-panel')
    expect(resolveContextPanelDefault(entries, 'file')?.contributionId).toBe('file-panel')
    // 没有亲和面板的 Sheet 种类：先挑 global，再退到列表首个。
    expect(resolveContextPanelDefault(entries, 'overview')?.contributionId).toBe('anywhere')
    expect(resolveContextPanelDefault([entries[0]], 'overview')?.contributionId).toBe('agent-panel')
    expect(resolveContextPanelDefault([], 'agent')).toBeUndefined()
  })

  it('when 异常时隔离贡献并留下可诊断错误', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = new ContextPanelRegistry()
    registry.register(createPluginIdentity('test.context.bad-when', 'run-1'), {
      ...contribution('bad-when', 'agent', 100),
      when: () => { throw new Error('bad availability predicate') },
    })

    expect(selectContextPanels(registry.getSnapshot().entries, {
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
