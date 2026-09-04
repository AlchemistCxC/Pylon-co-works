import { describe, expect, it } from 'vitest'
import { buildSettingsContributionSearchItems, projectSettingsContributionCatalog, settingsContributionIdentity } from '../settingsContributionCatalog.ts'
import type { RendererRegistrySnapshot } from '../../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RegistryEntry } from '../../../plugin-runtime/registry/types.ts'
import type { PluginSettingsPageContribution } from '../../../plugin-runtime/settings/pluginSettingsTypes.ts'

const entry = <T,>(value: T, contributionId = 'fixture', ownerPluginId = 'fixture.plugin'): RegistryEntry<T> => ({
  value, contributionId, ownerPluginId, ownerRuntimeInstanceId: `${ownerPluginId}@test`, layer: 'feature', priority: 0,
})

const rendererSnapshot = (overrides: Partial<RendererRegistrySnapshot> = {}): RendererRegistrySnapshot => ({
  revision: 1, renderKinds: [], messageRenderers: [], contentRenderers: [], toolRenderers: [], codeHighlighters: [], rendererSuites: [], rendererSlots: [], ...overrides,
})

describe('SettingsContributionCatalog', () => {
  it('projects theme and renderer fields to canonical immutable routes', () => {
    const snapshot = rendererSnapshot({ renderKinds: [entry({ id: 'content.fixture', category: 'content', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'layout', label: 'Layout', fields: [{ key: 'maxWidth', type: 'number', default: 10 }] }] }, settingsPlacement: { categoryId: 'markdown-text', categoryLabel: 'Markdown', objectOrder: 1 } }) as never] })
    const catalog = projectSettingsContributionCatalog({ rendererSnapshot: snapshot })
    expect(catalog.records.some(record => record.namespace === 'theme' && record.fieldKey === 'accent')).toBe(true)
    expect(catalog.records.some(record => record.namespace === 'kind' && record.fieldKey === 'maxWidth' && record.canonicalRoute.section === 'renderers')).toBe(true)
    expect(Object.isFrozen(catalog.records)).toBe(true)
  })

  it('falls back unknown placement and reports a diagnostic', () => {
    const snapshot = rendererSnapshot({ renderKinds: [entry({ id: 'content.fixture', category: 'content', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'x', type: 'boolean' }] }] }, settingsPlacement: { categoryId: 'unknown-owner-category', categoryLabel: 'Unknown' } }) as never] })
    const record = projectSettingsContributionCatalog({ rendererSnapshot: snapshot }).records.find(item => item.fieldKey === 'x')!
    expect(record.canonicalRoute.category).toBe('plugin-extension')
    expect(record.placementSource).toBe('fallback')
    expect(record.diagnostics.some(diagnostic => diagnostic.code === 'placement-fallback')).toBe(true)
  })

  it('keeps plugin schema opaque without an adapter and projects fields with one', () => {
    const opaque: PluginSettingsPageContribution = { id: 'opaque', label: 'Opaque', renderKind: 'isolated-surface', surfaceId: 'opaque' }
    const adapted: PluginSettingsPageContribution = { id: 'adapted', label: 'Adapted', renderKind: 'isolated-surface', surfaceId: 'adapted', schema: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'enabled', type: 'boolean' }] }] }, valueAdapter: { namespace: 'plugin-page', getSnapshot: () => ({ values: {}, unavailable: {}, revision: 0 }), setValue: () => {}, removeValue: () => {}, reset: () => {}, subscribe: () => () => {} } }
    const records = projectSettingsContributionCatalog({ pluginPages: [entry(opaque, 'opaque'), entry(adapted, 'adapted')] }).records
    expect(records.find(record => record.ownerId === 'opaque')?.fieldKey).toBeUndefined()
    expect(records.some(record => record.ownerId === 'adapted' && record.fieldKey === 'enabled')).toBe(true)
  })

  it('distinguishes duplicate identity from route collision', () => {
    const pages = [entry({ id: 'a', label: 'A', renderKind: 'isolated-surface' as const, surfaceId: 'a' }, 'same'), entry({ id: 'a', label: 'A', renderKind: 'isolated-surface' as const, surfaceId: 'a' }, 'same')]
    const records = projectSettingsContributionCatalog({ pluginPages: pages }).records
    const duplicates = records.filter(record => record.ownerId === 'same')
    expect(duplicates.every(record => record.diagnostics.some(diagnostic => diagnostic.code === 'duplicate-identity'))).toBe(true)
    expect(settingsContributionIdentity(duplicates[0])).toContain('plugin-page')
  })

  it('keeps migrated layout and assistant avatar fields to one canonical editable route', () => {
    const catalog = projectSettingsContributionCatalog()
    expect(catalog.records.filter(record => record.fieldKey === 'showPet')).toHaveLength(0)
    expect(catalog.records.filter(record => record.fieldKey === 'assistantDotImage')).toHaveLength(1)
    expect(catalog.records.find(record => record.fieldKey === 'assistantDotImage')?.canonicalRoute.section).toBe('chat')
  })

  it('does not index deprecated shared Tool Kind fields as duplicate search entries', () => {
    const snapshot = rendererSnapshot({ renderKinds: [{
      ...entry({ id: 'tool.read', category: 'tool', priority: 1, fallbackKind: 'content.unknown', settingsSchemaVersion: 1, validateInput: () => true, settings: { schemaVersion: 1, groups: [{ id: 'g', label: 'G', fields: [{ key: 'density', type: 'boolean', deprecated: true }] }] } } as never),
    }] })
    const catalog = projectSettingsContributionCatalog({ rendererSnapshot: snapshot })
    expect(buildSettingsContributionSearchItems(catalog).some(item => item.label === 'density' && item.kind === 'renderer-entry')).toBe(false)
  })
})
