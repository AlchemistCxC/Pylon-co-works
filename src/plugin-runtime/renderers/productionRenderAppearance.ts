import type { RenderAppearanceSnapshot } from '../../contracts/messageRenderer.ts'
import type { WorkbenchAppearanceSnapshot } from '../../domains/workbench/appearance.ts'
import type { RenderCatalogSnapshot } from './rendererRegistry.ts'
import { resolveRenderAppearance } from './renderAppearanceResolver.ts'
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
  if (!input.schema) return Object.freeze({})
  const availableOptions = Object.fromEntries(input.schema.groups.flatMap(group => group.fields.flatMap(field => {
    if (field.type !== 'choice' && field.type !== 'multi-choice') return []
    const key = field.key ?? field.id ?? ''
    const target = field.optionTarget ?? `${input.namespace}.${input.id}.${key}`
    const options = resolvePluginSettingOptions(target, field.options, input.optionEntries ?? [])
    return [[key, options.map(option => option.value)] as const]
  })))
  return resolveRenderAppearance({
    schema: input.schema,
    hostDefaults: hostDefaults(input.host, input.schema),
    kindDefaults: input.defaults,
    profileTokens: input.profile,
    userOverrides: scopedValues(input.settings.values, input.namespace, input.id),
    sessionPreview: scopedValues(input.settings.sessionPreview, input.namespace, input.id),
    availableOptions,
  }).values
}

/**
 * Composition-root resolver for a concrete Suite/Slot/Kind tuple.
 * Renderers receive only the resolved immutable snapshot and never see stores.
 */
export function resolveProductionRenderAppearance(input: ProductionRenderAppearanceInput): RenderAppearanceSnapshot {
  const suite = input.catalog.rendererSuites.find(entry => entry.value.id === input.suiteId)?.value
  const slot = input.catalog.rendererSlots.find(entry => entry.value.id === input.slotId)?.value
  const kind = input.catalog.renderKinds.find(entry => entry.value.id === input.kind)?.value
  const suiteValues = resolveScope({ schema: suite?.settings, namespace: 'suite', id: input.suiteId, host: input.hostAppearance, settings: input.settings, optionEntries: input.optionEntries })
  const slotValues = resolveScope({ schema: slot?.settings, namespace: 'slot', id: input.slotId, host: input.hostAppearance, settings: input.settings, optionEntries: input.optionEntries })
  const kindValues = resolveScope({
    schema: kind?.settings,
    namespace: 'kind',
    id: input.kind,
    host: input.hostAppearance,
    settings: input.settings,
    defaults: kind?.defaultTokens as Readonly<Record<string, RendererSettingValue>> | undefined,
    profile: input.profileKindTokens,
    optionEntries: input.optionEntries,
  })
  return Object.freeze({
    ...input.hostAppearance,
    ...suiteValues,
    ...slotValues,
    ...kindValues,
    renderSettings: Object.freeze({ suite: suiteValues, slot: slotValues, kind: kindValues }),
  })
}
