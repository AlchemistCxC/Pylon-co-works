import { describe, expect, it, vi } from 'vitest'
import type { MessageRenderer } from '../../../contracts/messageRenderer.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginScope } from '../../pluginScope.ts'
import { createPluginRendererApi } from '../pluginRendererApi.ts'
import { RendererRegistry } from '../rendererRegistry.ts'

const dummyRenderer = (rendererId: string): MessageRenderer => ({
  rendererId,
  kind: 'unknown',
  renderMessage: () => { throw new Error('not used') },
  renderTool: () => { throw new Error('not used') },
  renderReasoning: () => { throw new Error('not used') },
})

describe('RendererRegistry', () => {
  it('开放 namespaced RenderKind 进入 catalog，并拒绝缺失 fallback', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.kind', 'instance-kind')
    const disposable = registry.registerRenderKind(owner, {
      id: 'plugin.note',
      category: 'content',
      fallbackKind: 'content.unknown',
      priority: 10,
      fixture: { text: 'hello' },
      defaultTokens: {},
      settingsSchemaVersion: 1,
      validateInput: () => true,
    })

    expect(registry.snapshot().renderKinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.objectContaining({ id: 'plugin.note' }) }),
    ]))
    expect(() => registry.registerRenderKind(owner, {
      id: 'plugin.broken', category: 'content', priority: 10,
      fixture: {}, defaultTokens: {}, settingsSchemaVersion: 1, validateInput: () => true,
    })).toThrow(/fallbackKind/)
    disposable.dispose()
    expect(registry.snapshot().renderKinds.some(entry => entry.value.id === 'plugin.note')).toBe(false)
  })

  it('校验并冻结 render kind/renderer settings schema', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.settings', 'instance-settings')
    const settings = { schemaVersion: 1, groups: [{ id: 'main', label: 'Main', fields: [{ key: 'density', type: 'choice' as const, presentation: 'select' as const, options: [{ value: 'compact' }] }] }] }
    registry.registerRenderKind(owner, {
      id: 'plugin.settings', category: 'content', fallbackKind: 'content.unknown', priority: 10,
      fixture: {}, defaultTokens: {}, settingsSchemaVersion: 1, settings, validateInput: () => true,
    })
    const entry = registry.snapshot().renderKinds.find(item => item.value.id === 'plugin.settings')
    expect(entry?.value.settings).toMatchObject({ schemaVersion: 1 })
    expect(Object.isFrozen(entry?.value.settings)).toBe(true)
    expect(() => registry.registerRenderKind(owner, {
      id: 'plugin.bad-settings', category: 'content', fallbackKind: 'content.unknown', priority: 10,
      fixture: {}, defaultTokens: {}, settingsSchemaVersion: 2, settings, validateInput: () => true,
    })).toThrow(/schemaVersion/)
  })

  it('四类 API 都记录 owner instance，并随 PluginScope 原子注销', async () => {
    const registry = new RendererRegistry()
    const identity = createPluginIdentity('test.renderer', 'instance-1')
    const scope = new PluginScope(identity.key)
    const api = createPluginRendererApi(registry, identity, scope)
    const changed = vi.fn()
    registry.subscribe(changed)

    api.registerMessageRenderer({
      id: 'test.message', renderer: dummyRenderer('test.message'), priority: 10,
      fallback: false, canRender: () => true,
    })
    api.registerContentRenderer({
      id: 'test.ansi', kind: 'ansi', priority: 10, fallback: false,
      canRender: input => input.kind === 'ansi',
      provider: { providerId: 'test.ansi', render: text => text },
    })
    api.registerToolRenderer({
      id: 'test.tool', kind: 'read', priority: 10, fallback: false,
      canRender: input => input.kind === 'read', renderer: { getSummary: () => 'read' },
    })
    api.registerCodeHighlighter({
      id: 'test.highlight', priority: 10, fallback: false,
      canRender: input => input.language === 'ts', highlight: async () => '<b />',
    })

    const entries = [
      ...registry.snapshot().messageRenderers,
      ...registry.snapshot().contentRenderers,
      ...registry.snapshot().toolRenderers,
      ...registry.snapshot().codeHighlighters,
    ]
    expect(entries).toHaveLength(4)
    expect(entries.every(entry => entry.ownerPluginId === identity.pluginId)).toBe(true)
    expect(entries.every(entry => entry.ownerRuntimeInstanceId === identity.key)).toBe(true)

    expect((await scope.dispose()).disposed).toBe(4)
    expect(registry.snapshot().messageRenderers).toEqual([])
    expect(registry.snapshot().contentRenderers).toEqual([])
    expect(registry.snapshot().toolRenderers).toEqual([])
    expect(registry.snapshot().codeHighlighters).toEqual([])
    expect(changed).toHaveBeenCalledTimes(8)
  })

  it('resolveSurface 按显式 renderer、kind fallback 链选择，并在异常后回退 unknown', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.surface', 'instance-surface')
    registry.registerRenderKind(owner, {
      id: 'plugin.note', category: 'content', fallbackKind: 'content.unknown', priority: 10,
      fixture: {}, defaultTokens: {}, settingsSchemaVersion: 1, validateInput: () => true,
    })
    registry.registerContentRenderer(owner, {
      id: 'test.note.renderer', kind: 'plugin.note', priority: 10, fallback: false,
      canRender: () => { throw new Error('predicate failed') },
      onError: () => 'fallback', provider: { providerId: 'note', partId: 'note', label: 'Note' },
    })
    const diagnostics: Array<{ code: string }> = []
    expect(registry.resolveSurface({ kind: 'plugin.note', payload: { text: 'x' } }, { diagnostic: d => diagnostics.push(d) })).toMatchObject({
      kind: 'content.unknown', fallback: true,
    })
    expect(diagnostics).toEqual([expect.objectContaining({ code: 'renderer.canRender.failed' })])
    expect(registry.resolveSurface({ kind: 'vendor.future-kind' })).toMatchObject({
      kind: 'content.unknown', fallback: true,
      diagnostics: [expect.objectContaining({ code: 'render-kind.unknown', kind: 'vendor.future-kind' })],
    })
  })

  it('保留已批准 semanticKind 的 catalog 分层，并始终能回退 unknown', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.semantic-kind', 'instance-semantic-kind')
    for (const id of ['tool.read', 'content.memory', 'activity.subagent']) {
      registry.registerRenderKind(owner, {
        id, category: id.startsWith('activity.') ? 'activity' : id.startsWith('content.') ? 'content' : 'tool',
        fallbackKind: 'content.unknown', priority: 100,
        fixture: { semanticKind: id }, defaultTokens: {}, settingsSchemaVersion: 1,
        validateInput: () => true,
      })
    }
    expect(registry.snapshot().renderKinds.map(entry => entry.value.id)).toEqual(expect.arrayContaining(['tool.read', 'content.memory', 'activity.subagent']))
    expect(registry.resolveSurface({ kind: 'tool.read', payload: { semanticKind: 'tool.read' } })).toMatchObject({ kind: 'content.unknown', fallback: true })
  })

  it('kind 与 renderer shadow transaction 可一起 commit，并 revert 到同一旧 snapshot', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.transaction', 'instance-transaction')
    const beforeRevision = registry.snapshot().revision
    const tx = registry.beginShadowTransaction(owner, 'old-runtime')
    tx.registerRenderKind({
      id: 'plugin.transaction', category: 'content', fallbackKind: 'content.unknown', priority: 10,
      fixture: {}, defaultTokens: {}, settingsSchemaVersion: 1, validateInput: () => true,
    })
    tx.registerContentRenderer({
      id: 'transaction.renderer', kind: 'plugin.transaction', priority: 10, fallback: false,
      canRender: () => true, provider: { providerId: 'transaction', partId: 'transaction', label: 'Transaction' },
    })
    tx.validate()
    tx.commit()
    expect(registry.snapshot().revision).toBe(beforeRevision + 1)
    expect(registry.snapshot().renderKinds.some(entry => entry.value.id === 'plugin.transaction')).toBe(true)
    expect(registry.snapshot().contentRenderers.some(entry => entry.contributionId === 'transaction.renderer')).toBe(true)
    tx.revert()
    expect(registry.snapshot().renderKinds.some(entry => entry.value.id === 'plugin.transaction')).toBe(false)
    expect(registry.snapshot().contentRenderers.some(entry => entry.contributionId === 'transaction.renderer')).toBe(false)
  })

  it('跨 staged kind 的 fallback cycle 在 validate 阶段拒绝', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.kind-cycle', 'instance-cycle')
    const tx = registry.beginShadowTransaction(owner, 'old-cycle')
    const definition = (id: string, fallbackKind: string) => ({
      id, category: 'content', fallbackKind, priority: 10,
      fixture: {}, defaultTokens: {}, settingsSchemaVersion: 1, validateInput: () => true,
    })
    tx.registerRenderKind(definition('plugin.cycle-a', 'plugin.cycle-b'))
    tx.registerRenderKind(definition('plugin.cycle-b', 'plugin.cycle-a'))
    expect(() => tx.validate()).toThrow(/成环/)
    tx.rollback()
  })

  it('resolve 跳过 canRender=false/异常项，按 priority 选择后显式回退', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.renderer', 'instance-2')
    registry.registerMessageRenderer(owner, {
      id: 'throws', renderer: dummyRenderer('throws'), priority: 1, fallback: false,
      canRender: () => { throw new Error('broken predicate') },
      onError: () => 'fallback',
    })
    registry.registerMessageRenderer(owner, {
      id: 'incapable', renderer: dummyRenderer('incapable'), priority: 2, fallback: false,
      canRender: () => false,
    })
    registry.registerMessageRenderer(owner, {
      id: 'fallback', renderer: dummyRenderer('fallback'), priority: 3, fallback: true,
      canRender: () => true,
    })
    expect(registry.resolveMessageRenderer()?.value.renderer.rendererId).toBe('fallback')

    registry.registerMessageRenderer(owner, {
      id: 'capable', renderer: dummyRenderer('capable'), priority: 4, fallback: false,
      canRender: () => true,
    })
    expect(registry.resolveMessageRenderer()?.value.renderer.rendererId).toBe('capable')
  })

  it('message renderer 可按 Agent Workspace mode 选择，其他 mode 回退', () => {
    const registry = new RendererRegistry()
    const owner = createPluginIdentity('test.mode-renderer', 'instance-mode')
    registry.registerMessageRenderer(owner, {
      id: 'work-mode', renderer: dummyRenderer('work-mode'), priority: 10, fallback: false,
      canRender: input => input.context?.workspaceMode === 'work',
    })
    registry.registerMessageRenderer(owner, {
      id: 'default-mode', renderer: dummyRenderer('default-mode'), priority: 20, fallback: true,
      canRender: () => true,
    })

    expect(registry.resolveMessageRenderer({ context: {
      workspaceKind: 'agent', workspaceMode: 'work', agentId: 'peri', sessionId: 's1',
    } })?.value.renderer.rendererId).toBe('work-mode')
    expect(registry.resolveMessageRenderer({ context: {
      workspaceKind: 'agent', workspaceMode: 'chat', agentId: 'peri', sessionId: 's1',
    } })?.value.renderer.rendererId).toBe('default-mode')
  })
})
