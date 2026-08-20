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
