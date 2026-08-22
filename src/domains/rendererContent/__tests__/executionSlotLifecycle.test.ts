import { describe, expect, it } from 'vitest'
import type { RenderSurface } from '../../../contracts/messageRenderer.ts'
import { createPluginIdentity } from '../../../plugin-runtime/pluginIdentity.ts'
import { resolveRendererActivation } from '../../../plugin-runtime/renderers/rendererActivationResolver.ts'
import { RendererRegistry } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RendererSlotContribution } from '../../../plugin-runtime/renderers/rendererSuiteTypes.ts'
import { BUILTIN_EXECUTION_RENDER_KINDS } from '../executionRenderKindCatalog.ts'

function overlay(id: string, targetSuites: readonly string[], fallback = false, priority = 1): RendererSlotContribution {
  const surface: RenderSurface = {
    rendererId: id, kind: 'solid', mount: () => ({}), update: () => {}, destroy: () => {}, on: () => () => {},
  }
  return {
    id, targetSuites, kinds: ['activity.process'], priority, fallback, canRender: () => true,
    createSurface: () => surface,
  }
}

describe('C07 execution Slot lifecycle', () => {
  it('keeps process overlays Suite-local and restores the base Slot after hot-update cleanup', async () => {
    const registry = new RendererRegistry()
    const builtin = createPluginIdentity('builtin.pylon-renderers', 'base')
    const processKind = BUILTIN_EXECUTION_RENDER_KINDS.find(kind => kind.id === 'activity.process')!
    registry.registerRenderKind(builtin, processKind)
    registry.registerSuite(builtin, {
      id: 'builtin.solid', label: 'builtin.solid', apiVersion: 1,
      runtime: { framework: 'solid', version: '1.0.0' },
      compatibility: { documentSchema: 'workbench.v1', renderCatalogSchema: 1 },
      requiredKinds: ['activity.process'], factory: () => null,
    })
    registry.registerSlot(builtin, overlay('builtin.solid.content.base', ['builtin.solid'], true, 10_000))

    const v1 = createPluginIdentity('example.process-overlay', 'v1')
    const oldHandle = registry.registerSlot(v1, overlay('example.process-overlay', ['builtin.solid']))
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('activity.process')?.[0].value.id).toBe('example.process-overlay')

    const v2 = createPluginIdentity('example.process-overlay', 'v2')
    const update = registry.beginShadowTransaction(v2, v1.key)
    const nextHandle = update.registerSlot(overlay('example.process-overlay', ['builtin.solid']))
    update.validate()
    update.commit()
    await oldHandle.dispose()
    expect(registry.snapshot().rendererSlots.filter(entry => entry.value.id === 'example.process-overlay')).toHaveLength(1)

    await nextHandle.dispose()
    expect(resolveRendererActivation(registry.snapshot(), { explicitSuiteId: 'builtin.solid' })
      .slots.get('activity.process')?.[0].value.id).toBe('builtin.solid.content.base')
  })
})
