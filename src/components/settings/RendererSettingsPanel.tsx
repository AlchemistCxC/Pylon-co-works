import { useMemo, useSyncExternalStore } from 'react'
import { getPluginSettingOptionsRegistry, getRendererRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import type { PluginSettingOption } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { RendererSettingsStore } from '../../plugin-runtime/renderers/rendererSettingsStore.ts'
import { settingFieldKey, type RenderSettingField, type RendererSettingValue, type RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { evaluateRenderSettingCondition, default as RendererSettingField } from './RendererSettingField.tsx'
import RendererSuitePicker from './RendererSuitePicker.tsx'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { BUILTIN_INTERFACE_MODES } from '../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { resolveInterfaceModeSuite } from '../../application/transactions/activateInterfaceMode.ts'

export interface RendererSettingsSchemaEntry {
  readonly id: string
  readonly label: string
  readonly schema: RendererSettingsSchema
  readonly namespace?: 'kind' | 'suite' | 'slot'
}

export interface RendererSettingsPanelProps {
  readonly schemas?: readonly RendererSettingsSchemaEntry[]
  readonly store?: RendererSettingsStore
  readonly search?: string
}

function catalogSchemas(activeSuiteId?: string): readonly RendererSettingsSchemaEntry[] {
  const snapshot = getRendererRegistry().snapshot()
  const kinds = snapshot.renderKinds.flatMap(entry => entry.value.settings ? [{ id: entry.value.id, label: entry.value.id, schema: entry.value.settings, namespace: 'kind' as const }] : [])
  const suite = activeSuiteId ? snapshot.rendererSuites.find(entry => entry.value.id === activeSuiteId)?.value : undefined
  const suiteSettings = suite?.settings ? [{ id: suite.id, label: suite.label, schema: suite.settings, namespace: 'suite' as const }] : []
  const slots = snapshot.rendererSlots.filter(entry => activeSuiteId && (entry.value.targetSuites.includes('*') || entry.value.targetSuites.includes(activeSuiteId)))
    .flatMap(entry => entry.value.settings ? [{ id: entry.value.id, label: entry.value.label ?? entry.value.id, schema: entry.value.settings, namespace: 'slot' as const }] : [])
  return [...suiteSettings, ...slots, ...kinds]
}

function fieldMatches(field: RenderSettingField, query: string, options: readonly PluginSettingOption[]): boolean {
  if (!query) return true
  const haystack = [settingFieldKey(field), field.label, field.description, ...options.flatMap(option => [option.value, option.label, option.description])].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(query)
}

function effectiveValues(entry: RendererSettingsSchemaEntry, snapshot: ReturnType<RendererSettingsStore['getSnapshot']>): Record<string, RendererSettingValue> {
  const namespace = `${entry.namespace ?? 'kind'}.${entry.id}`
  return Object.fromEntries(entry.schema.groups.flatMap(group => group.fields.flatMap(field => {
    const key = settingFieldKey(field)
    const value = snapshot.sessionPreview[`${namespace}.${key}`] ?? snapshot.values[`${namespace}.${key}`] ?? field.default
    return value === undefined ? [] : [[key, value] as const]
  })))
}

export default function RendererSettingsPanel(props: RendererSettingsPanelProps) {
  const store = props.store ?? getRendererSettingsStore()
  const storeSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const registrySnapshot = useSyncExternalStore(listener => getRendererRegistry().subscribe(listener), () => getRendererRegistry().snapshot(), () => getRendererRegistry().snapshot())
  const optionSnapshot = useSyncExternalStore(listener => getPluginSettingOptionsRegistry().subscribe(listener), () => getPluginSettingOptionsRegistry().getSnapshot(), () => getPluginSettingOptionsRegistry().getSnapshot())
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const suitePreference = usePresentationPreferenceStore(state => state.rendererSuiteIdByMode[interfaceMode])
  const mode = getInterfaceModeRegistry().resolve(interfaceMode)?.value ?? BUILTIN_INTERFACE_MODES.find(entry => entry.id === interfaceMode)
  const activeSuiteId = mode?.workbench.renderKind === 'renderer-suite'
    ? resolveInterfaceModeSuite(mode, suitePreference, registrySnapshot.rendererSuites.map(entry => entry.value.id)).activeSuiteId
    : undefined
  const entries = props.schemas ?? catalogSchemas(activeSuiteId)
  const query = props.search?.trim().toLowerCase() ?? ''
  // Keep subscriptions alive even when caller supplies fixture schemas.
  void registrySnapshot
  const sections = useMemo(() => entries.flatMap(entry => {
    const namespace = `${entry.namespace ?? 'kind'}.${entry.id}`
    const values = effectiveValues(entry, storeSnapshot)
    return entry.schema.groups.flatMap(group => {
      const fields = group.fields.filter(field => {
        const target = `${namespace}.${settingFieldKey(field)}`
        const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
        const options = 'options' in field ? resolvePluginSettingOptions(optionTarget, field.options, optionSnapshot.entries) : []
        const matches = fieldMatches(field, query, options)
        return matches && (!field.showIf || evaluateRenderSettingCondition(field.showIf, values) || Boolean(query && matches))
      })
      return fields.length > 0 || !query ? [{ entry, group, namespace, values, fields }] : []
    })
  }), [entries, optionSnapshot.entries, query, storeSnapshot])

  return <section className="renderer-settings-panel" aria-label="渲染器设置">
    <RendererSuitePicker />
    {sections.map(({ entry, group, namespace, values, fields }) => <div className={`renderer-settings-group${group.layout ? ` layout-${group.layout}` : ''}`} key={`${namespace}.${group.id}`}>
      <div className="renderer-settings-group-heading">
        <div><h3>{entry.label} · {group.label}</h3>{group.description && <p>{group.description}</p>}</div>
        <button type="button" onClick={() => store.reset(namespace)}>恢复本组默认</button>
      </div>
      {fields.map(field => {
        const key = settingFieldKey(field)
        const target = `${namespace}.${key}`
        const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
        const options = 'options' in field ? resolvePluginSettingOptions(optionTarget, field.options, optionSnapshot.entries) : []
        const hiddenByCondition = field.showIf && !evaluateRenderSettingCondition(field.showIf, values)
        const storedValue = storeSnapshot.values[target]
        const unavailableCurrent = 'options' in field && typeof storedValue === 'string' && !options.some(option => option.value === storedValue)
        return <div key={key} className={hiddenByCondition ? 'renderer-settings-field-match' : undefined}>
          {hiddenByCondition && <div className="set-hint">条件字段：当前条件未满足，但搜索命中了此字段</div>}
          {unavailableCurrent && <div className="set-hint" role="status">当前值“{String(storedValue)}”已不可用；可恢复默认或等待插件重新加载。</div>}
          <RendererSettingField
            field={field}
            value={unavailableCurrent ? field.default : values[key]}
            options={options}
            onChange={value => store.setOverride(target, value)}
            onReset={() => store.removeOverride(target)}
          />
        </div>
      })}
    </div>)}
    {Object.entries(storeSnapshot.unavailable).map(([key, value]) => <div className="renderer-setting-unavailable" key={key}>
      <span>{key}：{String(value)}（不可用，等待插件恢复）</span>
      <button type="button" onClick={() => store.restoreUnavailable(key)}>恢复</button>
    </div>)}
    {sections.length === 0 && Object.keys(storeSnapshot.unavailable).length === 0 && <div className="set-hint">暂无可配置的渲染器设置</div>}
  </section>
}
