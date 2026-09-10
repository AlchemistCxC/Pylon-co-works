import { describe, expect, it } from 'vitest'
import { buildRendererSettingsCatalog, probeSettingsRegistries } from '../rendererSettingsCatalog.ts'
import type { RendererRegistrySnapshot } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RenderKindDefinition } from '../../../plugin-runtime/renderers/rendererTypes.ts'
import { BUILTIN_TOOL_RENDER_KINDS } from '../../../domains/rendererContent/toolRenderKindCatalog.ts'

const schema = {
  schemaVersion: 1,
  groups: [{ id: 'appearance', label: '外观', fields: [{ key: 'tone', label: '色调', type: 'choice', options: [{ value: 'default', label: '默认' }], default: 'default' }] }],
} as const

function snapshot(kind: RenderKindDefinition): RendererRegistrySnapshot {
  return {
    revision: 1,
    renderKinds: [{ contributionId: kind.id, ownerPluginId: 'plugin.demo', ownerRuntimeInstanceId: 'demo', layer: 'feature', priority: 1, value: kind }],
    messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [], rendererSuites: [], rendererSlots: [],
  }
}

describe('Renderer settings catalog fallback placement', () => {
  it('未知 category 进入插件扩展而不是从导航中消失', () => {
    const kind = {
      id: 'plugin.demo.kind', category: 'content', fallbackKind: 'content.unknown', priority: 1,
      fixture: { text: 'fixture' }, defaultTokens: {}, settingsSchemaVersion: 1, settings: schema,
      settingsPlacement: { categoryId: 'plugin-specific', categoryLabel: 'Plugin Specific', objectOrder: 7, disclosure: 'essential' },
      validateInput: () => true,
    } as unknown as RenderKindDefinition
    const entry = buildRendererSettingsCatalog(snapshot(kind))[0]
    expect(entry.placement.categoryId).toBe('plugin-extension')
    expect(entry.placement.categoryLabel).toBe('插件扩展')
    expect(entry.placement.objectOrder).toBe(7)
  })

  it('探针确认 renderer/plugin 设置都进入 canonical 索引并报告重复/非法贡献', () => {
    const kind = {
      id: 'plugin.demo.kind', category: 'content', fallbackKind: 'content.unknown', priority: 1,
      fixture: { text: 'fixture' }, defaultTokens: {}, settingsSchemaVersion: 1, settings: schema,
      validateInput: () => true,
    } as unknown as RenderKindDefinition
    const issues = probeSettingsRegistries(snapshot(kind), [{ contributionId: 'plugin.settings', value: { label: '设置' } }])
    expect(issues).toEqual([])

    const invalid = probeSettingsRegistries(snapshot(kind), [
      { contributionId: 'plugin.settings', value: { label: '设置' } },
      { contributionId: 'plugin.settings', value: { label: '设置副本' } },
      { contributionId: ' ', value: { label: '' } },
    ])
    expect(invalid).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'plugin_settings_duplicate', id: 'plugin.settings' }),
      expect.objectContaining({ code: 'plugin_settings_invalid' }),
    ]))
  })

  it('shared Tool Kind schema is compatibility-only while Slot remains the editable route', () => {
    const entries = buildRendererSettingsCatalog({
      revision: 1,
      renderKinds: BUILTIN_TOOL_RENDER_KINDS.map(kind => ({ contributionId: kind.id, ownerPluginId: 'core', ownerRuntimeInstanceId: 'core', layer: 'platform' as const, priority: 1, value: kind })),
      messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [], rendererSuites: [], rendererSlots: [],
    })
    const tool = entries.find(entry => entry.id === 'tool.read')!
    expect(tool.compatibilityOnly).toBe(true)
    expect(tool.fieldCount).toBe(0)
    expect(tool.compatibilityFieldCount).toBeGreaterThan(0)
    expect(tool.schema.groups[0].fields[0]).toMatchObject({ deprecated: true, inheritsFrom: expect.stringContaining('slot.') })
  })
})
