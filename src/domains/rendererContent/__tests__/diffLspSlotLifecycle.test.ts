import { describe, expect, it } from 'vitest'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { resolveRendererActivation } from '../../../plugin-runtime/renderers/rendererActivationResolver.ts'
import { RendererRegistry } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RendererSlotContribution, RendererSuiteContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../textRenderKindCatalog.ts'

function surface(rendererId: string): RenderSurface {
  return {
    rendererId,
    kind: 'solid',
    mount: () => ({}),
    update: () => {},
    destroy: () => {},
    on: () => () => {},
  }
}

function suite(id: string): RendererSuiteContribution {
  return {
    id, label: id, apiVersion: 1,
    runtime: { framework: 'solid', version: '1.0.0' },
    compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
    requiredKinds: ['content.diff'], optionalKinds: ['diagnostic.lsp'],
    factory: () => null,
  }
}

function slot(
  id: string,
  targetSuites: readonly string[],
  rendererId: string,
  options: { fallback?: boolean; priority?: number } = {},
): RendererSlotContribution {
  return {
    id, targetSuites, kinds: ['content.diff', 'diagnostic.lsp'],
    priority: options.priority ?? 1,
    fallback: options.fallback ?? false,
    canRender: () => true,
    createSurface: () => surface(rendererId),
  }
}

describe('C06 diff and LSP Slot ownership', () => {
  it('keeps overlays Suite-local and atomically restores the base Slot after hot-update cleanup', async () => {
    const registry = new RendererRegistry()
    const builtin = createPluginIdentity('builtin.pylon-renderers', 'base')
    const alt = createPluginIdentity('example.alt-suite', 'base')
    for (const id of ['content.diff', 'diagnostic.lsp']) {
      registry.registerRenderKind(builtin, BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === id)!)
    }
    registry.registerSuite(builtin, suite('builtin.solid'))
    registry.registerSuite(alt, suite('example.alt'))
    registry.registerSlot(builtin, slot('builtin.solid.content.base', ['builtin.solid'], 'builtin-base', { fallback: true, priority: 10_000 }))
    registry.registerSlot(alt, slot('example.alt.content.base', ['example.alt'], 'alt-base', { fallback: true, priority: 10_000 }))

    const oldOwner = createPluginIdentity('example.diff-overlay', 'v1')
    const oldHandle = registry.registerSlot(oldOwner, slot('example.diff-overlay.slot', ['builtin.solid'], 'overlay-v1'))
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('content.diff')?.[0].value.id).toBe('example.diff-overlay.slot')
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'example.alt' })
      .slots.get('content.diff')?.[0].value.id).toBe('example.alt.content.base')

    const nextOwner = createPluginIdentity('example.diff-overlay', 'v2')
    const update = registry.beginShadowTransaction(nextOwner, oldOwner.key)
    const nextHandle = update.registerSlot(slot('example.diff-overlay.slot', ['builtin.solid'], 'overlay-v2'))
    update.validate()
    update.commit()
    expect(registry.snapshot().rendererSlots.filter(entry => entry.value.id === 'example.diff-overlay.slot')).toHaveLength(1)
    expect(registry.snapshot().rendererSlots.find(entry => entry.value.id === 'example.diff-overlay.slot')?.ownerRuntimeInstanceId).toBe(nextOwner.key)

    await oldHandle.dispose()
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('diagnostic.lsp')?.[0].value.id).toBe('example.diff-overlay.slot')
    await nextHandle.dispose()
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('content.diff')?.[0].value.id).toBe('builtin.solid.content.base')
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'example.alt' })
      .slots.get('diagnostic.lsp')?.[0].value.id).toBe('example.alt.content.base')
  })
})
