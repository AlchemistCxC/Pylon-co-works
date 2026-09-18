import { describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { AgentSidebarRegistry } from '../sidebarRegistry.ts'
import { createPluginSidebarApi } from '../pluginSidebarApi.ts'
import type { AgentSidebarContribution } from '../sidebarTypes.ts'

const Panel = () => null

function contribution(id: string, extra: Partial<AgentSidebarContribution> = {}): AgentSidebarContribution {
  return { id, label: id, renderKind: 'first-party-react', component: Panel, ...extra } as AgentSidebarContribution
}

describe('AgentSidebarRegistry', () => {
  it('按 ReactiveRegistry 顺序发布并随 scope dispose 回收', async () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'run-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginSidebarApi(registry, identity, scope)
    const listener = vi.fn()
    registry.subscribe(listener)

    api.registerAgentSidebarContribution(contribution('a'))
    api.registerAgentSidebarContribution(contribution('b'))

    expect(registry.list().map(item => item.id)).toEqual(['a', 'b'])
    expect(registry.getSnapshot().entries.every(entry => entry.ownerRuntimeInstanceId === identity.key)).toBe(true)
    await scope.dispose()
    expect(registry.getSnapshot().entries).toEqual([])
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('shadow transaction commit 前隔离候选，commit/revert 精确切换 owner', () => {
    const registry = new AgentSidebarRegistry()
    const oldOwner = createPluginIdentity('test.sidebar', 'old')
    const nextOwner = createPluginIdentity('test.sidebar', 'next')
    registry.register(oldOwner, contribution('shared', { icon: 'clock' }))
    const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    transaction.register(contribution('shared', { icon: 'boxes' }), { contributionId: 'shared' })

    expect(registry.list()[0].icon).toBe('clock')
    transaction.commit()
    expect(registry.list()[0].icon).toBe('boxes')
    expect(registry.getSnapshot().entries[0].ownerRuntimeInstanceId).toBe(nextOwner.key)
    transaction.revert()
    expect(registry.list()[0].icon).toBe('clock')
  })

  it('order 控制模块栈的确定性顺序', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'ordered')
    registry.register(identity, contribution('late', { order: 200 }))
    registry.register(identity, contribution('early', { order: 100 }))
    expect(registry.list().map(item => item.id)).toEqual(['early', 'late'])
  })

  it('headerActions 校验：id 非空、不重复、label 非空', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'actions')
    const withActions = (headerActions: unknown) => contribution('a', { headerActions } as never)

    registry.register(identity, withActions([{ id: 'new', label: '新建' }]))
    expect(registry.list()[0].headerActions).toHaveLength(1)
    expect(() => registry.register(identity, withActions([{ id: ' ', label: '新建' }]))).toThrow(/headerActions\[\]\.id/)
    expect(() => registry.register(identity, withActions([{ id: 'new', label: '' }]))).toThrow(/headerActions\[\]\.label/)
    expect(() => registry.register(identity, withActions([{ id: 'new', label: 'A' }, { id: 'new', label: 'B' }]))).toThrow(/headerActions id 重复/)
  })

  it('点击语义与页面声明必须自洽：onTitleClick=page 却无 page 即拒绝', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'title-action')
    expect(() => registry.register(identity, contribution('bad', { onTitleClick: 'page' }))).toThrow(/未声明 page/)
    registry.register(identity, contribution('ok', { onTitleClick: 'page', page: { title: '页面' } }))
    expect(registry.list()[0].page?.title).toBe('页面')
    expect(() => registry.register(identity, contribution('bad-action', { onTitleClick: 'collapse' as never }))).toThrow(/onTitleClick 非法/)
  })

  it('alwaysOpen 与 collapsible 是互相否定的声明，不做静默取一', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'always-open')
    expect(() => registry.register(identity, contribution('bad', { alwaysOpen: true, collapsible: true }))).toThrow(/不得同时声明/)
    registry.register(identity, contribution('ok', { alwaysOpen: true }))
    expect(registry.list()[0].alwaysOpen).toBe(true)
  })

  it('page.title 不能为空', () => {
    const registry = new AgentSidebarRegistry()
    const identity = createPluginIdentity('test.sidebar', 'page-title')
    expect(() => registry.register(identity, contribution('bad', { page: { title: '  ' } }))).toThrow(/page\.title 不能为空/)
  })
})
