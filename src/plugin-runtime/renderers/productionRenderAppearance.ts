import type { RenderAppearanceSnapshot } from '../../contracts/messageRenderer.ts'
import type { WorkbenchAppearanceSnapshot } from '../../domains/workbench/appearance.ts'
import type { RenderCatalogSnapshot } from './rendererRegistry.ts'
import { resolveRenderAppearance, type RenderAppearanceResolution } from './renderAppearanceResolver.ts'
import type { RendererSettingValue, RendererSettingsSchema } from './rendererSettingsTypes.ts'
import type { RendererSettingsStoreSnapshot } from './rendererSettingsStore.ts'
import type { RegistryEntry } from '../registry/types.ts'
import { resolvePluginSettingOptions } from '../settings/pluginSettingOptionsRegistry.ts'
import type { PluginSettingOptionsContribution } from '../settings/pluginSettingsTypes.ts'

export interface ProductionRenderAppearanceInput {
  readonly hostAppearance: WorkbenchAppearanceSnapshot
  readonly catalog: RenderCatalogSnapshot
  readonly settings: RendererSettingsStoreSnapshot
  readonly suiteId: string
  readonly slotId: string
  readonly kind: string
  readonly profileKindTokens?: Readonly<Record<string, RendererSettingValue>>
  readonly optionEntries?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
}

function scopedValues(
  values: Readonly<Record<string, RendererSettingValue>>,
  namespace: 'kind' | 'suite' | 'slot',
  id: string,
): Readonly<Record<string, RendererSettingValue>> {
  const prefix = `${namespace}.${id}.`
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) =>
    key.startsWith(prefix) ? [[key.slice(prefix.length), value] as const] : []))
}

function hostDefaults(
  host: WorkbenchAppearanceSnapshot,
  schema: RendererSettingsSchema,
): Readonly<Record<string, RendererSettingValue>> {
  const keys = new Set(schema.groups.flatMap(group => group.fields.map(field => field.key ?? field.id ?? '')))
  return Object.fromEntries(Object.entries(host).flatMap(([key, value]) =>
    keys.has(key) ? [[key, value as RendererSettingValue] as const] : []))
}

function resolveScope(input: {
  readonly schema?: RendererSettingsSchema
  readonly namespace: 'kind' | 'suite' | 'slot'
  readonly id: string
  readonly host: WorkbenchAppearanceSnapshot
  readonly settings: RendererSettingsStoreSnapshot
  readonly defaults?: Readonly<Record<string, RendererSettingValue>>
  readonly profile?: Readonly<Record<string, RendererSettingValue>>
  readonly optionEntries?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
}) {
  if (!input.schema) return {
    values: Object.freeze({}),
    sources: Object.freeze({}),
  }
  const availableOptions = Object.fromEntries(input.schema.groups.flatMap(group => group.fields.flatMap(field => {
    if (field.type !== 'choice' && field.type !== 'multi-choice') return []
    const key = field.key ?? field.id ?? ''
    const target = field.optionTarget ?? `${input.namespace}.${input.id}.${key}`
    const options = resolvePluginSettingOptions(target, field.options, input.optionEntries ?? [])
    return [[key, options.map(option => option.value)] as const]
  })))
  const resolution = resolveRenderAppearance({
    schema: input.schema,
    hostDefaults: hostDefaults(input.host, input.schema),
    kindDefaults: input.defaults,
    profileTokens: input.profile,
    userOverrides: scopedValues(input.settings.values, input.namespace, input.id),
    sessionPreview: scopedValues(input.settings.sessionPreview, input.namespace, input.id),
    availableOptions,
  })
  return { values: resolution.values, sources: resolution.sources }
}

export interface ProductionRendererSettingsScopeInput {
  readonly hostAppearance: WorkbenchAppearanceSnapshot
  readonly catalog: RenderCatalogSnapshot
  readonly settings: RendererSettingsStoreSnapshot
  readonly namespace: 'kind' | 'suite' | 'slot'
  readonly id: string
  readonly profileKindTokens?: Readonly<Record<string, RendererSettingValue>>
  readonly optionEntries?: readonly RegistryEntry<PluginSettingOptionsContribution>[]
}

/**
 * Settings Inspector 与 production renderer 共用的单 owner 解析入口。
 * UI 不得自行拼接 schema default / profile / override / preview。
 */
export function resolveProductionRendererSettingsScope(
  input: ProductionRendererSettingsScopeInput,
): Pick<RenderAppearanceResolution, 'values' | 'sources'> {
  const contribution = input.namespace === 'kind'
    ? input.catalog.renderKinds.find(entry => entry.value.id === input.id)?.value
    : input.namespace === 'suite'
      ? input.catalog.rendererSuites.find(entry => entry.value.id === input.id)?.value
      : input.catalog.rendererSlots.find(entry => entry.value.id === input.id)?.value
  const defaults = input.namespace === 'kind' && contribution && 'defaultTokens' in contribution
    ? contribution.defaultTokens as Readonly<Record<string, RendererSettingValue>>
    : undefined
  return resolveScope({
    schema: contribution?.settings,
    namespace: input.namespace,
    id: input.id,
    host: input.hostAppearance,
    settings: input.settings,
    defaults,
    profile: input.namespace === 'kind' ? input.profileKindTokens : undefined,
    optionEntries: input.optionEntries,
  })
}

/**
 * Composition-root resolver for a concrete Suite/Slot/Kind tuple.
 * Renderers receive only the resolved immutable snapshot and never see stores.
 */
export function resolveProductionRenderAppearance(input: ProductionRenderAppearanceInput): RenderAppearanceSnapshot {
  const shared = { hostAppearance: input.hostAppearance, catalog: input.catalog, settings: input.settings, optionEntries: input.optionEntries }
  const suiteResolution = resolveProductionRendererSettingsScope({ ...shared, namespace: 'suite', id: input.suiteId })
  const slotResolution = resolveProductionRendererSettingsScope({ ...shared, namespace: 'slot', id: input.slotId })
  const kindResolution = resolveProductionRendererSettingsScope({ ...shared, namespace: 'kind', id: input.kind, profileKindTokens: input.profileKindTokens })
  const suiteValues = suiteResolution.values
  const slotValues = slotResolution.values
  const slotContribution = input.catalog.rendererSlots.find(entry => entry.value.id === input.slotId)?.value
  const sharedKeys = new Set(slotContribution?.settings?.groups.flatMap(group => group.fields.map(field => field.key ?? field.id ?? '')) ?? [])
  const kindValues = Object.fromEntries(Object.entries(kindResolution.values).filter(([key]) => {
    if (!sharedKeys.has(key)) return true
    // A legacy Kind override remains a deliberate per-kind exception. Schema
    // and host/profile defaults for shared keys defer to the Slot owner.
    const source = kindResolution.sources[key]
    return source === 'user-override' || source === 'session-preview'
  }))
  const effectiveKindValues = { ...kindValues }
  for (const key of sharedKeys) {
    if (kindValues[key] === undefined && slotValues[key] !== undefined) effectiveKindValues[key] = slotValues[key]
  }
  return Object.freeze({
    ...input.hostAppearance,
    ...suiteValues,
    ...slotValues,
    ...effectiveKindValues,
    renderSettings: Object.freeze({
      suite: suiteValues,
      slot: slotValues,
      kind: Object.freeze(effectiveKindValues),
      sources: Object.freeze({
        suite: suiteResolution.sources,
        slot: slotResolution.sources,
        kind: kindResolution.sources,
      }),
    }),
  })
}
