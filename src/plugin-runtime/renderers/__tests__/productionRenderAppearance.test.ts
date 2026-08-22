import { describe, expect, it } from 'vitest'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { selectWorkbenchAppearance } from '../../../domains/workbench/appearance.ts'
import type { RegistryEntry } from '../../registry/types.ts'
import type { PluginSettingOptionsContribution } from '../../settings/pluginSettingsTypes.ts'
import type { RenderCatalogSnapshot } from '../rendererRegistry.ts'
import { resolveProductionRenderAppearance } from '../productionRenderAppearance.ts'

function entry<T>(id: string, value: T): RegistryEntry<T> {
  return {
    ownerPluginId: 'test', ownerRuntimeInstanceId: 'test@1', contributionId: id,
    layer: 'feature', priority: 1, value,
  }
}

describe('production render appearance', () => {
  it('把 optionTarget 插件新增候选带入生产 kind appearance', () => {
    const code = BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === 'content.code')!
    const catalog: RenderCatalogSnapshot = {
      revision: 1,
      renderKinds: [entry(code.id, code)],
      messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [],
      rendererSuites: [], rendererSlots: [],
    }
    const optionEntries: readonly RegistryEntry<PluginSettingOptionsContribution>[] = [entry('test.palette', {
      id: 'test.palette', target: 'kind.content.code.palette', upsert: [{ value: 'solarized', label: 'Solarized' }],
    })]
    const appearance = resolveProductionRenderAppearance({
      hostAppearance: selectWorkbenchAppearance(DEFAULTS, 1),
      catalog,
      settings: {
        schemaVersion: 1,
        values: { 'kind.content.code.palette': 'solarized' },
        unavailable: {}, sessionPreview: {}, diagnostics: [],
      },
      suiteId: 'builtin.solid', slotId: 'builtin.solid.content.base', kind: 'content.code',
      optionEntries,
    })
    expect(appearance.palette).toBe('solarized')
  })
})
