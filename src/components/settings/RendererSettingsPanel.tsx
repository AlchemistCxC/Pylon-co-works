import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getPluginSettingOptionsRegistry, getPresentationProfileRegistry, getRendererRegistry, getRendererSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import type { PluginSettingOption } from '../../plugin-runtime/settings/pluginSettingsTypes.ts'
import type { RendererSettingsStore } from '../../plugin-runtime/renderers/rendererSettingsStore.ts'
import { isSettingVisible, settingFieldKey, type RenderSettingField, type RendererSettingValue, type RendererSettingsPlacement, type RendererSettingsSchema } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { evaluateRenderSettingCondition, default as RendererSettingField } from './RendererSettingField.tsx'
import RendererSuitePicker from './RendererSuitePicker.tsx'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { BUILTIN_INTERFACE_MODES } from '../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { resolveInterfaceModeSuite } from '../../application/transactions/activateInterfaceMode.ts'
import type { SettingsDensity } from './settingsChromeState.ts'
import { selectWorkbenchAppearance } from '../../domains/workbench/appearance.ts'
import { useStore } from '../../store.ts'
import { resolveProductionRendererSettingsScope } from '../../plugin-runtime/renderers/productionRenderAppearance.ts'
import { resolveFieldOptions, resolveRenderAppearance, type RenderAppearanceSource } from '../../plugin-runtime/renderers/renderAppearanceResolver.ts'
import { stringifySettingsTarget } from '../../plugin-runtime/settings/settingsTargetGrammar.ts'
import {
  projectRendererSettingsCatalog,
  rendererSettingsEntryKey,
  type RendererSettingsCatalogEntry,
} from './rendererSettingsCatalog.ts'
import type { SettingsContributionCatalog } from './settingsContributionCatalog.ts'

export interface RendererSettingsSchemaEntry {
  readonly id: string
  readonly label: string
  readonly schema: RendererSettingsSchema
  readonly namespace?: 'kind' | 'suite' | 'slot'
  readonly ownerPluginId?: string
  readonly placement?: RendererSettingsPlacement
}

export interface RendererSettingsPanelProps {
  readonly schemas?: readonly RendererSettingsSchemaEntry[]
  readonly store?: RendererSettingsStore
  readonly search?: string
  readonly categoryId?: string
  readonly objectKey?: string
  readonly density?: SettingsDensity
  readonly onSelectionChange?: (entry: RendererSettingsCatalogEntry | undefined) => void
  readonly settingsCatalog?: SettingsContributionCatalog
}

function fieldMatches(field: RenderSettingField, query: string, options: readonly PluginSettingOption[]): boolean {
  if (!query) return true
  const haystack = [settingFieldKey(field), field.label, field.description, ...options.flatMap(option => [option.value, option.label, option.description])]
    .filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(query)
}

function optionTargetFor(entry: RendererSettingsCatalogEntry, fieldKey: string): string {
  // Keep first-party legacy keys stable; namespaced third-party owners use the
  // encoded structured grammar so dotted ids cannot collide.
  return entry.ownerPluginId && entry.ownerPluginId !== 'fixture' && !entry.ownerPluginId.startsWith('builtin.')
    ? stringifySettingsTarget({ namespace: entry.namespace, ownerId: entry.id, fieldKey, ownerPluginId: entry.ownerPluginId })
    : `${entry.namespace}.${entry.id}.${fieldKey}`
}

function entryMatches(
  entry: RendererSettingsCatalogEntry,
  query: string,
  optionEntries: Parameters<typeof resolvePluginSettingOptions>[2],
): boolean {
  if (!query) return true
  if ([entry.id, entry.label, entry.description, entry.ownerPluginId, entry.placement.categoryLabel]
    .filter(Boolean).join(' ').toLowerCase().includes(query)) return true
  return entry.schema.groups.some(group => group.fields.some(field => {
    const target = optionTargetFor(entry, settingFieldKey(field))
    const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
    const options = resolveFieldOptions(field, optionTarget, optionEntries)
    return fieldMatches(field, query, options)
  }))
}

function fixtureValues(
  entry: RendererSettingsCatalogEntry,
  snapshot: ReturnType<RendererSettingsStore['getSnapshot']>,
  hostDefaults: Readonly<Record<string, RendererSettingValue>>,
  optionEntries: Parameters<typeof resolvePluginSettingOptions>[2],
): { readonly values: Readonly<Record<string, RendererSettingValue>>; readonly sources: Readonly<Record<string, RenderAppearanceSource>> } {
  const namespace = entry.namespace + '.' + entry.id
  const scoped = (source: Readonly<Record<string, RendererSettingValue>>) => Object.fromEntries(Object.entries(source).flatMap(([key, value]) =>
    key.startsWith(namespace + '.') ? [[key.slice(namespace.length + 1), value] as const] : []))
  const availableOptions = Object.fromEntries(entry.schema.groups.flatMap(group => group.fields.flatMap(field => {
    if (field.type !== 'choice' && field.type !== 'multi-choice' && field.type !== 'color') return []
    const key = settingFieldKey(field)
    const target = optionTargetFor(entry, key)
    return [[key, resolveFieldOptions(field, target, optionEntries).map(option => option.value)] as const]
  })))
  return resolveRenderAppearance({
    schema: entry.schema,
    hostDefaults,
    userOverrides: scoped(snapshot.values),
    sessionPreview: scoped(snapshot.sessionPreview),
    availableOptions,
  })
}

const SOURCE_LABELS: Readonly<Record<RenderAppearanceSource, string>> = Object.freeze({
  'schema-default': '组件默认',
  'host-default': '宿主主题',
  'kind-default': '类型默认',
  profile: '呈现方案',
  'user-override': '你的覆盖',
  'session-preview': '临时预览',
})

function fixtureCatalog(entries: readonly RendererSettingsSchemaEntry[]): readonly RendererSettingsCatalogEntry[] {
  return entries.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    ownerPluginId: entry.ownerPluginId ?? 'fixture',
    namespace: entry.namespace ?? 'kind',
    schema: entry.schema,
    placement: entry.placement ?? {
      categoryId: 'fixture',
      categoryLabel: '示例',
      categoryOrder: 0,
      objectOrder: index,
      disclosure: 'essential',
    },
    active: true,
    fieldCount: entry.schema.groups.reduce((count, group) => count + group.fields.length, 0),
  }))
}

function RendererSettingsGroup(props: {
  entry: RendererSettingsCatalogEntry
  group: RendererSettingsSchema['groups'][number]
  namespace: string
  values: Readonly<Record<string, RendererSettingValue>>
  sources: Readonly<Record<string, RenderAppearanceSource>>
  query: string
  density: SettingsDensity
  store: RendererSettingsStore
  storeSnapshot: ReturnType<RendererSettingsStore['getSnapshot']>
  optionEntries: Parameters<typeof resolvePluginSettingOptions>[2]
}) {
  const { entry, group, namespace, values, sources, query, density, store, storeSnapshot, optionEntries } = props
  const [open, setOpen] = useState(!group.collapsedByDefault)
  useEffect(() => {
    if (query) setOpen(true)
  }, [query])
  const fields = group.fields.filter(field => {
    if (!isSettingVisible(field, density)) return false
    const target = optionTargetFor(entry, settingFieldKey(field))
    const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
    const options = resolveFieldOptions(field, optionTarget, optionEntries)
    const matches = fieldMatches(field, query, options)
    return matches && (!field.showIf || evaluateRenderSettingCondition(field.showIf, values) || Boolean(query && matches))
  })
  if (query && fields.length === 0) return null
  const advancedCount = group.fields.filter(field => field.advanced).length
  const resetGroup = () => {
    for (const field of group.fields) {
      const target = optionTargetFor(entry, settingFieldKey(field))
      store.removeOverride(target)
      store.clearSessionPreview(target)
    }
  }

  return <section
    className={'renderer-settings-group' + (group.layout ? ' layout-' + group.layout : '')}
    data-group-anchor={entry.label + ' · ' + group.label}
  >
    <button type="button" className="renderer-settings-group-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="renderer-settings-group-caret" aria-hidden="true">{open ? '−' : '+'}</span>
      <span className="renderer-settings-group-copy">
        <strong>{group.label}</strong>
        {group.description && <small>{group.description}</small>}
      </span>
      {!open && advancedCount > 0 && <span className="renderer-settings-group-meta">含 {advancedCount} 项高级设置</span>}
      <span className="renderer-settings-group-count">{fields.length}</span>
    </button>
    {open && <div className="renderer-settings-fields">
      <div className="renderer-settings-group-actions">
        <span>{namespace}</span>
        <button type="button" onClick={event => { event.stopPropagation(); resetGroup() }}>恢复本组</button>
      </div>
      {fields.map(field => {
        const key = settingFieldKey(field)
      const target = optionTargetFor(entry, key)
        const optionTarget = 'optionTarget' in field ? field.optionTarget ?? target : target
        const options = resolveFieldOptions(field, optionTarget, optionEntries)
        const hiddenByCondition = field.showIf && !evaluateRenderSettingCondition(field.showIf, values)
        const storedValue = storeSnapshot.values[target]
        const unavailableValues = 'options' in field
          ? (typeof storedValue === 'string'
            ? (options.some(option => option.value === storedValue) ? [] : [storedValue])
            : Array.isArray(storedValue)
              ? storedValue.filter((item): item is string => typeof item === 'string' && !options.some(option => option.value === item))
              : [])
          : []
        const unavailableCurrent = unavailableValues.length > 0
        const displayOptions = unavailableCurrent
          ? [...options, ...unavailableValues.map(value => ({ value, label: `不可用：${value}`, disabled: true }))]
          : options
        const displayValue = unavailableCurrent ? storedValue : values[key]
        return <div key={key}
          className={'renderer-settings-field-row' + (hiddenByCondition ? ' renderer-settings-field-match' : '')}
          data-search-anchor={`renderer:${rendererSettingsEntryKey(entry)}:${group.id}:${key}`}>
          {hiddenByCondition && <div className="set-hint">条件尚未满足；搜索临时揭示此字段</div>}
          {unavailableCurrent && <div className="set-hint" role="status">当前值“{String(storedValue)}”已不可用；保留原值等待插件恢复。</div>}
          <RendererSettingField
            field={field}
            value={displayValue}
            options={displayOptions}
            onChange={value => {
              store.setOverride(target, value)
              store.clearSessionPreview(target)
            }}
            onPreviewChange={value => store.setSessionPreview({ ...store.getSnapshot().sessionPreview, [target]: value })}
            onPreviewCommit={() => store.clearSessionPreview(target)}
            onReset={() => {
              store.removeOverride(target)
              store.clearSessionPreview(target)
            }}
          />
          <div className="renderer-setting-provenance">
            <span>{SOURCE_LABELS[sources[key] ?? 'schema-default']}</span>
            {field.scope && <span data-setting-scope={field.scope}>scope: {field.scope}</span>}
            {field.inheritsFrom && <span>继承自 {field.inheritsFrom}</span>}
            {field.semanticKey && <span>semantic: {field.semanticKey}</span>}
            <code>{target}</code>
          </div>
        </div>
      })}
    </div>}
  </section>
}

export default function RendererSettingsPanel(props: RendererSettingsPanelProps) {
  const { onSelectionChange } = props
  const store = props.store ?? getRendererSettingsStore()
  const storeSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const liveRegistrySnapshot = useSyncExternalStore(
    listener => getRendererRegistry().subscribe(listener),
    () => getRendererRegistry().snapshot(),
    () => getRendererRegistry().snapshot(),
  )
  const registrySnapshot = props.settingsCatalog?.rendererSnapshot ?? liveRegistrySnapshot
  const optionSnapshot = useSyncExternalStore(
    listener => getPluginSettingOptionsRegistry().subscribe(listener),
    () => getPluginSettingOptionsRegistry().getSnapshot(),
    () => getPluginSettingOptionsRegistry().getSnapshot(),
  )
  const presentationProfileRegistry = getPresentationProfileRegistry()
  const presentationProfiles = useSyncExternalStore(
    listener => presentationProfileRegistry.subscribe(listener),
    () => presentationProfileRegistry.getSnapshot(),
    () => presentationProfileRegistry.getSnapshot(),
  )
  const interfaceMode = useInterfaceModeStore(state => state.interfaceMode)
  const suitePreference = usePresentationPreferenceStore(state => state.rendererSuiteIdByMode[interfaceMode])
  const activeProfileId = usePresentationPreferenceStore(state => state.activeProfileId)
  const mode = getInterfaceModeRegistry().resolve(interfaceMode)?.value ?? BUILTIN_INTERFACE_MODES.find(entry => entry.id === interfaceMode)
  const activeSuiteId = mode?.workbench.renderKind === 'renderer-suite'
    ? resolveInterfaceModeSuite(mode, suitePreference, registrySnapshot.rendererSuites.map(entry => entry.value.id)).activeSuiteId
    : undefined
  const entries = useMemo(() => props.schemas
    ? fixtureCatalog(props.schemas)
    : (props.settingsCatalog?.renderer ?? projectRendererSettingsCatalog(registrySnapshot, activeSuiteId)).entries,
  [activeSuiteId, props.schemas, props.settingsCatalog, registrySnapshot])
  const query = props.search?.trim().toLowerCase() ?? ''
  const categoryId = props.categoryId ?? (props.schemas ? 'fixture' : 'foundation')
  const density = props.density ?? 'standard'
  const candidates = useMemo(() => entries.filter(entry => {
    if (query) return entryMatches(entry, query, optionSnapshot.entries)
    if (categoryId === 'advanced-catalog') return true
    return entry.active && entry.placement.categoryId === categoryId
  }), [categoryId, entries, optionSnapshot.entries, query])
  const [selectedKey, setSelectedKey] = useState('')
  const selected = candidates.find(entry => rendererSettingsEntryKey(entry) === selectedKey) ?? candidates[0]
  const activeObjectKey = selected ? rendererSettingsEntryKey(selected) : ''
  const selectedResolution = useMemo(() => {
    if (!selected) return { values: {}, sources: {} }
    if (props.schemas) return fixtureValues(selected, storeSnapshot, selectWorkbenchAppearance(useStore.getState(), 0) as unknown as Readonly<Record<string, RendererSettingValue>>, optionSnapshot.entries)
    const profile = presentationProfiles.entries.find(entry => entry.contributionId === activeProfileId)?.value
    return resolveProductionRendererSettingsScope({
      hostAppearance: selectWorkbenchAppearance(useStore.getState(), 0),
      catalog: registrySnapshot,
      settings: storeSnapshot,
      namespace: selected.namespace,
      id: selected.id,
      profileKindTokens: profile?.kindTokens?.[selected.id],
      optionEntries: optionSnapshot.entries,
    })
  }, [activeProfileId, optionSnapshot.entries, presentationProfiles.entries, props.schemas, registrySnapshot, selected, storeSnapshot])

  useEffect(() => {
    if (props.objectKey && candidates.some(entry => rendererSettingsEntryKey(entry) === props.objectKey)) {
      setSelectedKey(props.objectKey)
      return
    }
    const nextKey = candidates[0] ? rendererSettingsEntryKey(candidates[0]) : ''
    if (!candidates.some(entry => rendererSettingsEntryKey(entry) === selectedKey)) setSelectedKey(nextKey)
  }, [candidates, props.objectKey, selectedKey])
  useEffect(() => {
    onSelectionChange?.(selected)
  }, [activeObjectKey, onSelectionChange, selected])

  return <section className="renderer-settings-panel" aria-label="渲染器设置">
    {!props.schemas && <RendererSuitePicker />}
    {candidates.length > 0 && <div className="renderer-settings-ledger">
      <nav className="renderer-settings-object-index" aria-label="Renderer 设置对象">
        <div className="renderer-settings-object-index-head">
          <span>{query ? 'SEARCH RESULTS' : selected?.placement.categoryLabel}</span>
          <strong>{candidates.length} objects</strong>
        </div>
        {candidates.map(entry => {
          const key = rendererSettingsEntryKey(entry)
          return <button type="button" key={key}
            className={'renderer-settings-object' + (key === activeObjectKey ? ' active' : '')}
            onClick={() => setSelectedKey(key)}>
            <span>{entry.label}</span>
            <small>{entry.namespace} · {entry.fieldCount}</small>
          </button>
        })}
      </nav>
      {selected && <div className="renderer-settings-inspector">
        <header className="renderer-settings-object-header">
          <div>
            <span>{selected.namespace.toUpperCase()} / {selected.id}</span>
            <h3>{selected.label}</h3>
            {selected.description && <p>{selected.description}</p>}
          </div>
          <div className="renderer-settings-owner">
            <span>{selected.active ? 'ACTIVE' : 'AVAILABLE'}</span>
            <small>{selected.ownerPluginId}</small>
            {!selected.compatibilityOnly && <button type="button" onClick={() => store.reset(selected.namespace + '.' + selected.id)}>恢复当前对象</button>}
          </div>
        </header>
        {selected.compatibilityOnly
          ? <div className="set-hint renderer-settings-compatibility" role="status">
            该 Kind 设置已迁移至共享 Slot；此处仅保留旧 key 的兼容读取与诊断，不提供重复编辑表单。
            {selected.compatibilityFieldCount ? `（兼容字段 ${selected.compatibilityFieldCount} 项）` : ''}
          </div>
          : selected.schema.groups.map(group => <RendererSettingsGroup
            key={group.id}
            entry={selected}
            group={group}
            namespace={selected.namespace + '.' + selected.id}
            values={selectedResolution.values}
            sources={selectedResolution.sources}
            query={query}
            density={density}
            store={store}
            storeSnapshot={storeSnapshot}
            optionEntries={optionSnapshot.entries}
          />)}
      </div>}
    </div>}
    {Object.entries(storeSnapshot.unavailable).map(([key, value]) => <div className="renderer-setting-unavailable" key={key}>
      <span>{key}：{String(value)}（不可用，等待插件恢复）</span>
      <button type="button" onClick={() => store.restoreUnavailable(key)}>恢复</button>
    </div>)}
    {candidates.length === 0 && Object.keys(storeSnapshot.unavailable).length === 0 && (
      <div className="settings-empty-state renderer-settings-empty">
        <span className="settings-empty-kicker">Renderer catalog</span>
        <h3>{query ? '没有匹配的 Renderer 设置' : '当前类别暂无可配置对象'}</h3>
        <p>{query ? '换一个关键词，或进入高级目录查看完整 Suite / Slot / Kind。' : '参数所有者尚未为此类别贡献 schema。'}</p>
      </div>
    )}
  </section>
}
