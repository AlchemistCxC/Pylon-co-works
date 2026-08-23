import { describe, expect, it } from 'vitest'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { resolveRendererActivation } from '../../../plugin-runtime/renderers/rendererActivationResolver.ts'
import { RendererRegistry } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RendererSlotContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { BUILTIN_TEXT_RENDER_KINDS } from '../textRenderKindCatalog.ts'

function slot(id: string, priority: number): RendererSlotContribution {
  const surface: RenderSurface = { rendererId: id, kind: 'solid', mount: () => ({}), update() {}, destroy() {}, on: () => () => {} }
  return { id, targetSuites: ['builtin.solid'], kinds: ['content.artifact'], priority, fallback: priority > 100,
    canRender: input => input.kind === 'content.artifact', createSurface: () => surface }
}

describe('C15 extension content Slot lifecycle', () => {
  it('atomically replaces a targeted artifact overlay and restores the base Slot after unload', async () => {
    const registry = new RendererRegistry()
    const builtin = createPluginIdentity('builtin.pylon-renderers', 'base')
    registry.registerRenderKind(builtin, BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === 'content.artifact')!)
    registry.registerSuite(builtin, { id: 'builtin.solid', label: 'builtin.solid', apiVersion: 1,
      runtime: { framework: 'solid', version: '1.0.0' }, compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
      requiredKinds: ['content.artifact'], factory: () => null })
    registry.registerSlot(builtin, slot('builtin.solid.content.base', 10_000))

    const v1 = createPluginIdentity('plugin.artifact-preview', 'v1')
    const oldHandle = registry.registerSlot(v1, slot('plugin.artifact-preview.slot', 1))
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' }).slots.get('content.artifact')?.[0].ownerRuntimeInstanceId).toBe(v1.key)

    const v2 = createPluginIdentity('plugin.artifact-preview', 'v2')
    const update = registry.beginShadowTransaction(v2, v1.key)
    const nextHandle = update.registerSlot(slot('plugin.artifact-preview.slot', 1))
    update.validate()
    update.commit()
    await oldHandle.dispose()
    expect(registry.snapshot().rendererSlots.filter(entry => entry.value.id === 'plugin.artifact-preview.slot')).toHaveLength(1)
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' }).slots.get('content.artifact')?.[0].ownerRuntimeInstanceId).toBe(v2.key)

    await nextHandle.dispose()
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' }).slots.get('content.artifact')?.[0].value.id).toBe('builtin.solid.content.base')
  })
})
