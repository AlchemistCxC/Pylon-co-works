import { THEME_FIELD_DEFS } from '../../themeFieldDefs.ts'
import { RENDERER_SETTINGS_CATEGORIES } from '../../domains/rendererContent/rendererSettingsPlacement.ts'
import { projectRendererSettingsCatalog, type RendererSettingsCatalogProjection } from './rendererSettingsCatalog.ts'
import { domainOfSection, SECTION_ZONES, SETTINGS_DOMAIN_BY_ID, SETTINGS_SECTION_LABELS, type SettingsSectionId, type SettingsSearchItem } from '../../settingsDomains.ts'
import type { RendererRegistrySnapshot } from '../../plugin-runtime/renderers/rendererRegistry.ts'
import type { RenderSettingField, RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { normalizeRendererSettingsSchema, settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import type { RegistryEntry } from '../../plugin-runtime/registry/types.ts'
import type { PluginSettingsPageContribution } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { ContextPanelContribution } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'

export type SettingsContributionSource =
  | 'theme' | 'renderer-kind' | 'renderer-slot' | 'renderer-suite'
  | 'plugin-page' | 'context-panel' | 'page-owned'

export type SettingsContributionNamespace = 'theme' | 'kind' | 'slot' | 'suite' | 'plugin-page' | 'context-panel' | 'page-owned'

export interface SettingsContributionDiagnostic {
  readonly code: string
  readonly message: string
}

export interface SettingsConsumerTrace {
  readonly ownerDefinition: string
  readonly settingsControl: string
  readonly storeOrPreview: string
  readonly productionConsumer: string
  readonly visibleResult: string
}

export interface SettingsContributionRecord {
  readonly source: SettingsContributionSource
  readonly ownerId: string
  readonly ownerPluginId?: string
  readonly namespace?: SettingsContributionNamespace
  readonly fieldKey?: string
  readonly label?: string
  readonly canonicalRoute: {
    readonly domain: string
    readonly section: string
    readonly category?: string
    readonly object?: string
    readonly group?: string
    readonly field?: string
  }
  readonly placementSource: 'host-policy' | 'owner-hint' | 'fallback'
  readonly semanticKey?: string
  readonly inheritsFrom?: string
  readonly active: boolean
  readonly deprecated?: boolean
  readonly aliases?: readonly string[]
  readonly diagnostics: readonly SettingsContributionDiagnostic[]
  readonly consumerTrace?: SettingsConsumerTrace
}

export interface SettingsContributionCatalog {
  readonly revision: number
  readonly records: readonly SettingsContributionRecord[]
  readonly categories: readonly { readonly id: string; readonly label: string; readonly order: number; readonly entryCount: number }[]
  readonly searchItems: readonly SettingsSearchItem[]
  readonly renderer: RendererSettingsCatalogProjection
  readonly rendererSnapshot?: RendererRegistrySnapshot
}

export interface SettingsContributionCatalogInput {
  readonly rendererSnapshot?: RendererRegistrySnapshot
  readonly activeSuiteId?: string
  readonly pluginPages?: readonly RegistryEntry<PluginSettingsPageContribution>[]
  readonly contextPanels?: readonly RegistryEntry<ContextPanelContribution>[]
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  return Object.freeze(value)
}

function identity(record: Pick<SettingsContributionRecord, 'source' | 'ownerPluginId' | 'ownerId' | 'namespace' | 'fieldKey'>): string {
  return [record.source, record.ownerPluginId ?? '', record.ownerId, record.namespace ?? '', record.fieldKey ?? ''].join('|')
}

function sectionForThemeZone(zone: string): SettingsSectionId | undefined {
  return (Object.entries(SECTION_ZONES).find(([, value]) => value === zone)?.[0] as SettingsSectionId | undefined)
}

function themeRecords(): SettingsContributionRecord[] {
  const records: SettingsContributionRecord[] = []
  for (const [fieldKey, definition] of Object.entries(THEME_FIELD_DEFS)) {
    if (definition.hidden || definition.meta) continue
    const section = sectionForThemeZone(definition.zone)
    if (!section) continue
    records.push({
      source: 'theme', ownerId: fieldKey, namespace: 'theme', fieldKey,
      label: definition.label,
      canonicalRoute: {
        domain: domainOfSection(section), section,
        group: definition.group, field: fieldKey,
      },
      placementSource: 'host-policy', active: true,
      consumerTrace: {
        ownerDefinition: `themeFieldDefs:${fieldKey}`, settingsControl: 'themeFieldRenderer',
        storeOrPreview: 'ThemeStore.setZoneField', productionConsumer: 'themeCssSnapshot', visibleResult: 'Workbench CSS/theme value',
      },
      diagnostics: [],
    })
  }
  return records
}

function rendererRecords(snapshot: RendererRegistrySnapshot | undefined): SettingsContributionRecord[] {
  if (!snapshot) return []
  const records: SettingsContributionRecord[] = []
  const sources = [
    ...snapshot.rendererSuites.map(entry => ({ source: 'renderer-suite' as const, namespace: 'suite' as const, entry, value: entry.value })),
    ...snapshot.rendererSlots.map(entry => ({ source: 'renderer-slot' as const, namespace: 'slot' as const, entry, value: entry.value })),
    ...snapshot.renderKinds.map(entry => ({ source: 'renderer-kind' as const, namespace: 'kind' as const, entry, value: entry.value })),
  ]
  for (const source of sources) {
    const schema = source.value.settings as RendererSettingsSchema | undefined
    if (!schema) continue
    const placement = source.value.settingsPlacement
    const category = placement?.categoryId ?? 'plugin-extension'
    const categoryKnown = ['foundation', 'markdown-text', 'code-terminal', 'reasoning', 'tool-activity', 'workflow', 'files-resources', 'interaction-diagnostic', 'plugin-extension', 'advanced-catalog'].includes(category)
    const placementSource = categoryKnown ? 'host-policy' : 'fallback'
    for (const group of schema.groups) for (const field of group.fields) {
      const key = settingFieldKey(field)
      if (!key) continue
      records.push({
        source: source.source,
        ownerId: source.value.id,
        ownerPluginId: source.entry.ownerPluginId,
        namespace: source.namespace,
        fieldKey: key,
        label: field.label ?? key,
        canonicalRoute: {
          domain: 'appearance', section: 'renderers', category: categoryKnown ? category : 'plugin-extension',
          object: source.value.id, group: group.id, field: key,
        },
        placementSource,
        semanticKey: (field as RenderSettingField & { semanticKey?: string }).semanticKey,
        inheritsFrom: (field as RenderSettingField & { inheritsFrom?: string }).inheritsFrom,
        active: !(source.namespace === 'kind' && source.value.id.startsWith('tool.')),
        deprecated: (field as RenderSettingField & { deprecated?: boolean }).deprecated,
        aliases: (field as RenderSettingField & { aliases?: readonly string[] }).aliases,
        diagnostics: categoryKnown ? [] : [{ code: 'placement-fallback', message: `未知 Renderer category：${category}` }],
        consumerTrace: {
          ownerDefinition: `${source.namespace}:${source.value.id}.${key}`, settingsControl: 'RendererSettingField',
          storeOrPreview: 'RendererSettingsStore', productionConsumer: 'productionRenderAppearance', visibleResult: 'resolved renderer appearance',
        },
      })
    }
  }
  return records
}

function pluginRecords(input: SettingsContributionCatalogInput): SettingsContributionRecord[] {
  const records: SettingsContributionRecord[] = []
  for (const entry of input.pluginPages ?? []) {
    const page = entry.value
    let schema: RendererSettingsSchema | undefined
    let schemaError: unknown
    if (page.schema) {
      try { schema = normalizeRendererSettingsSchema(page.schema) } catch (error) { schemaError = error }
    }
    const hasSchema = Boolean(schema)
    const hasAdapter = Boolean(page.valueAdapter)
    const base = {
      source: 'plugin-page' as const, ownerId: entry.contributionId, ownerPluginId: entry.ownerPluginId,
      label: page.label,
      namespace: 'plugin-page' as const, canonicalRoute: { domain: 'plugins', section: 'pluginManager', object: entry.contributionId },
      placementSource: 'host-policy' as const, active: true,
      diagnostics: schemaError ? [{ code: 'schema-invalid', message: schemaError instanceof Error ? schemaError.message : 'schema 非法，保留 opaque page' }] : (!hasSchema || hasAdapter ? [] : [{ code: 'value-adapter-missing', message: 'schema contribution 无 value adapter，保留 opaque page' }]),
      consumerTrace: {
        ownerDefinition: `plugin-page:${entry.contributionId}`, settingsControl: hasSchema && hasAdapter ? 'RendererSettingField' : 'PluginSettingsPageHost',
        storeOrPreview: hasAdapter ? 'SettingsValueAdapter' : 'opaque surface', productionConsumer: 'plugin contribution owner', visibleResult: 'plugin settings surface',
      },
    }
    if (!hasSchema || !hasAdapter) { records.push(base); continue }
    for (const group of schema!.groups) for (const field of group.fields) {
      const key = settingFieldKey(field)
      records.push({ ...base, fieldKey: key, canonicalRoute: { ...base.canonicalRoute, group: group.id, field: key } })
    }
    for (const [key, unavailable] of Object.entries(page.valueAdapter!.getSnapshot().unavailable)) {
      if (records.some(record => record.ownerId === entry.contributionId && record.fieldKey === key)) continue
      records.push({ ...base, fieldKey: key, active: false, canonicalRoute: { ...base.canonicalRoute, field: key }, diagnostics: [{ code: unavailable.code || 'unavailable', message: unavailable.message || '字段当前不可用，已保留原值' }] })
    }
  }
  for (const entry of input.contextPanels ?? []) {
    const panel = entry.value
    const section = panel.settings?.section === 'pluginManager' ? 'pluginManager' : 'right'
    let schema: RendererSettingsSchema | undefined
    let schemaError: unknown
    if (panel.schema) {
      try { schema = normalizeRendererSettingsSchema(panel.schema) } catch (error) { schemaError = error }
    }
    const hasSchema = Boolean(schema)
    const hasAdapter = Boolean(panel.valueAdapter)
    const base = {
      source: 'context-panel' as const, ownerId: entry.contributionId, ownerPluginId: entry.ownerPluginId,
      label: panel.settings?.label ?? panel.label,
      namespace: 'context-panel' as const, canonicalRoute: { domain: section === 'right' ? 'appearance' : 'plugins', section, object: entry.contributionId },
      placementSource: 'host-policy' as const, active: true,
      diagnostics: schemaError ? [{ code: 'schema-invalid', message: schemaError instanceof Error ? schemaError.message : 'schema 非法，保留 opaque page' }] : (!hasSchema || hasAdapter ? [] : [{ code: 'value-adapter-missing', message: 'schema contribution 无 value adapter，保留 opaque page' }]),
      consumerTrace: {
        ownerDefinition: `context-panel:${entry.contributionId}`, settingsControl: hasSchema && hasAdapter ? 'RendererSettingField' : 'ContextPanelHost',
        storeOrPreview: hasAdapter ? 'SettingsValueAdapter' : 'opaque surface', productionConsumer: 'context panel owner', visibleResult: 'context panel settings surface',
      },
    }
    if (!hasSchema || !hasAdapter) { records.push(base); continue }
    for (const group of schema!.groups) for (const field of group.fields) {
      const key = settingFieldKey(field)
      records.push({ ...base, fieldKey: key, canonicalRoute: { ...base.canonicalRoute, group: group.id, field: key } })
    }
    for (const [key, unavailable] of Object.entries(panel.valueAdapter!.getSnapshot().unavailable)) {
      if (records.some(record => record.ownerId === entry.contributionId && record.fieldKey === key)) continue
      records.push({ ...base, fieldKey: key, active: false, canonicalRoute: { ...base.canonicalRoute, field: key }, diagnostics: [{ code: unavailable.code || 'unavailable', message: unavailable.message || '字段当前不可用，已保留原值' }] })
    }
  }
  return records
}

function withDiagnostics(records: SettingsContributionRecord[]): SettingsContributionRecord[] {
  const byIdentity = new Map<string, SettingsContributionRecord[]>()
  const byRoute = new Map<string, SettingsContributionRecord[]>()
  for (const record of records) {
    const id = identity(record)
    const route = JSON.stringify(record.canonicalRoute)
    byIdentity.set(id, [...(byIdentity.get(id) ?? []), record])
    byRoute.set(route, [...(byRoute.get(route) ?? []), record])
  }
  return records.map(record => {
    const diagnostics = [...record.diagnostics]
    const identityPeers = byIdentity.get(identity(record)) ?? []
    const identityIndex = identityPeers.indexOf(record)
    const duplicate = identityPeers.length > 1
    if (duplicate) diagnostics.push({ code: 'duplicate-identity', message: '同一 owner/field identity 重复' })
    const routePeers = byRoute.get(JSON.stringify(record.canonicalRoute)) ?? []
    const routeCollision = routePeers.some(peer => identity(peer) !== identity(record))
    const routeIndex = routePeers.indexOf(record)
    if (routeCollision) diagnostics.push({ code: 'route-collision', message: '跨 owner canonical route 冲突' })
    const blocked = (duplicate && identityIndex > 0) || (routeCollision && routeIndex > 0)
    return {
      ...record,
      active: blocked ? false : record.active,
      ...(routeCollision && routeIndex > 0 ? { canonicalRoute: { ...record.canonicalRoute, category: 'plugin-extension' } } : {}),
      diagnostics: Object.freeze(diagnostics),
    }
  })
}

export function projectSettingsContributionCatalog(input: SettingsContributionCatalogInput = {}): SettingsContributionCatalog {
  const records = withDiagnostics([...themeRecords(), ...rendererRecords(input.rendererSnapshot), ...pluginRecords(input)])
  const frozen = freezeDeep(records.slice().sort((a, b) => JSON.stringify(a.canonicalRoute).localeCompare(JSON.stringify(b.canonicalRoute)))) as readonly SettingsContributionRecord[]
  const renderer = input.rendererSnapshot
    ? projectRendererSettingsCatalog(input.rendererSnapshot, input.activeSuiteId)
    : Object.freeze({ entries: Object.freeze([]), categories: Object.freeze([]), searchItems: Object.freeze([]) }) as RendererSettingsCatalogProjection
  const categories = renderer.categories.length > 0
    ? renderer.categories
    : Object.freeze(RENDERER_SETTINGS_CATEGORIES.map(category => ({
      ...category,
      entryCount: frozen.filter(record => record.canonicalRoute.category === category.id && record.active && !record.deprecated).length,
    })).filter(category => category.entryCount > 0 || category.id === 'advanced-catalog'))
  const adapterRevisions = [...(input.pluginPages ?? []), ...(input.contextPanels ?? [])]
    .map(entry => entry.value.valueAdapter?.getSnapshot().revision ?? 0)
  const revision = [input.rendererSnapshot?.revision ?? 0, ...(adapterRevisions.length > 0 ? adapterRevisions : [0])]
    .reduce((hash, value) => ((hash * 31) ^ value) >>> 0, 17)
  const base = { revision, records: frozen, categories, searchItems: [] as readonly SettingsSearchItem[], renderer, rendererSnapshot: input.rendererSnapshot }
  return Object.freeze({ ...base, searchItems: freezeDeep(buildSettingsContributionSearchItems(base)) })
}

/** Editable routes are the conflict-free, active owner entries only. */
export function canonicalEditableRecords(catalog: SettingsContributionCatalog): readonly SettingsContributionRecord[] {
  return Object.freeze(catalog.records.filter(record => record.active && !record.deprecated && !record.diagnostics.some(diagnostic => diagnostic.code === 'duplicate-identity' || diagnostic.code === 'route-collision')))
}

/** Convert the canonical records into the SettingsQuickSearch contract. */
export function buildSettingsContributionSearchItems(
  catalog: SettingsContributionCatalog,
): readonly SettingsSearchItem[] {
  return Object.freeze(catalog.records.filter(record => !(record.namespace === 'kind' && record.ownerId.startsWith('tool.') && record.deprecated)).map(record => {
    const route = record.canonicalRoute
    const domain = SETTINGS_DOMAIN_BY_ID[route.domain as keyof typeof SETTINGS_DOMAIN_BY_ID]
    const section = route.section as SettingsSectionId
    const path = `${domain?.label ?? route.domain} › ${SETTINGS_SECTION_LABELS[section] ?? route.section}`
    const item: SettingsSearchItem = {
      path: `${path}${route.category ? ` › ${route.category}` : ''}${route.object ? ` › ${route.object}` : ''}${route.group ? ` › ${route.group}` : ''}`,
      label: record.label ?? record.fieldKey ?? record.ownerId,
      section,
      advanced: Boolean(record.deprecated || record.diagnostics.length > 0),
      kind: record.source === 'plugin-page' ? 'plugin-page' : record.source === 'context-panel' ? 'context-panel' : record.source === 'theme' ? 'chain-a' : 'renderer-entry',
      ...(record.namespace === 'theme' && record.fieldKey ? { anchor: `field:${record.fieldKey}` } : {}),
      ...(record.namespace && ['kind', 'slot', 'suite'].includes(record.namespace) && record.fieldKey ? {
        rendererRoute: {
          categoryId: route.category ?? 'plugin-extension',
          objectKey: `${record.namespace}.${record.ownerId}`,
          groupId: route.group ?? '',
          fieldKey: record.fieldKey,
        },
        anchor: `renderer:${record.namespace}.${record.ownerId}:${route.group ?? ''}:${record.fieldKey}`,
      } : {}),
      ...(record.source === 'plugin-page' ? { pluginPageId: record.ownerId } : {}),
      ...(record.source === 'context-panel' ? { contextPanelId: record.ownerId } : {}),
    }
    return item
  }))
}

export { identity as settingsContributionIdentity }
