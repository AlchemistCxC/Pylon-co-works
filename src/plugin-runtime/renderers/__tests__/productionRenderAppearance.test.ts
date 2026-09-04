import { describe, expect, it } from 'vitest'
import { BUILTIN_TEXT_RENDER_KINDS } from '../../../domains/rendererContent/textRenderKindCatalog.ts'
import { DEFAULTS } from '../../../domains/theme/themeDefaults.ts'
import { selectWorkbenchAppearance } from '../../../domains/workbench/appearance.ts'
import type { RegistryEntry } from '../../registry/types.ts'
import type { PluginSettingOptionsContribution } from '../../settings/pluginSettingsTypes.ts'
import type { RenderCatalogSnapshot } from '../rendererRegistry.ts'
import { resolveProductionRenderAppearance } from '../productionRenderAppearance.ts'
import { resolveRenderAppearance } from '../renderAppearanceResolver.ts'

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

  it('exposes setting provenance so message text only applies explicit font overrides', () => {
    const markdown = BUILTIN_TEXT_RENDER_KINDS.find(kind => kind.id === 'content.markdown')!
    const catalog: RenderCatalogSnapshot = {
      revision: 1,
      renderKinds: [entry(markdown.id, markdown)],
      messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [],
      rendererSuites: [], rendererSlots: [],
    }
    const appearance = resolveProductionRenderAppearance({
      hostAppearance: selectWorkbenchAppearance(DEFAULTS, 1), catalog,
      settings: {
        schemaVersion: 1,
        values: { 'kind.content.markdown.fontSize': 18 },
        unavailable: {}, sessionPreview: {}, diagnostics: [],
      },
      suiteId: 'builtin.solid', slotId: 'builtin.solid.content.base', kind: 'content.markdown',
    })

    expect((appearance.renderSettings as { sources: { kind: { fontSize: string } } }).sources.kind.fontSize)
      .toBe('user-override')
  })

  it('preserves an unloaded palette color as unavailable instead of silently defaulting', () => {
    const resolution = resolveRenderAppearance({
      schema: { schemaVersion: 1, groups: [{ id: 'colors', label: 'Colors', fields: [{ key: 'accent', type: 'color', presentation: 'palette', default: '#fff' }] }] },
      userOverrides: { accent: '#old' },
      availableOptions: { accent: ['#fff', '#000'] },
    })
    expect(resolution.values.accent).toBe('#fff')
    expect(resolution.unavailable.accent).toBe('#old')
    expect(resolution.diagnostics.some(item => item.code === 'renderer.setting.unavailable')).toBe(true)
  })
})
