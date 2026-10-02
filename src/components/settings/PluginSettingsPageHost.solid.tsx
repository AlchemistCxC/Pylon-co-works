/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, on, onCleanup, Show, Suspense } from 'solid-js'
import { getPluginSettingOptionsRegistry, getPluginSettingsPageRegistry, getPluginSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import { settingFieldKey, type RendererSettingOption, type SettingsValue } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.solid.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.solid.tsx'
import { RendererSettingsSchemaHost } from './RendererSettingField.solid.tsx'
import { createSolidMount } from '../../host/solidBridge.solid'
import { createRegistrySignal } from '../../sheets/solidSheetSupport.solid.tsx'

const EMPTY_VALUES: Readonly<Record<string, SettingsValue>> = Object.freeze({})
const EMPTY_ADAPTER_SNAPSHOT = Object.freeze({ values: EMPTY_VALUES, unavailable: Object.freeze({}), revision: 0 })

/**
 * PluginSettingsPageHost — 插件设置页宿主（#515 Solid 实体；原
 * PluginSettingsPageHost.tsx 保留同名薄桥）。注册表/选项快照订阅经
 * createRegistrySignal；页头与空态是 Solid 直出 DOM。贡献面按 #515 贡献面翻转后的
 * 契约原生 Solid 渲染（与 ContextPanelHost.solid 同构）：schema →
 * RendererSettingsSchemaHost 实体；isolated-surface → IsolatedPluginSurface 实体；
 * first-party 组件 → Solid 贡献组件（solid lazy 经 Suspense）；外层恒为
 * PluginContributionBoundary（React class 边界的 Solid 同语义移植）。
 */
export default function PluginSettingsPageHost(props: { pageId: string }) {
  const registry = getPluginSettingsPageRegistry()
  const store = getPluginSettingsStore()
  const optionsRegistry = getPluginSettingOptionsRegistry()
  const snapshot = createRegistrySignal(registry, () => registry.getSnapshot())
  const entry = createMemo(() => snapshot().entries.find(candidate => candidate.contributionId === props.pageId))
  const pluginId = () => entry()?.ownerPluginId ?? ''
  const adapter = createMemo(() => {
    const current = entry()
    return current?.value.schema
      ? current.value.valueAdapter ?? (pluginId() ? createPluginSettingsValueAdapter({ store, ownerPluginId: pluginId(), contributionId: props.pageId, namespace: 'plugin-page' }) : undefined)
      : undefined
  })

  // values / adapter 快照订阅：adapter（或无 adapter 时的 pluginId）身份变化即重订阅
  // （React useSyncExternalStore 依赖 subscribe 函数身份的语义等价）。
  type AdapterSnapshot = Readonly<{ values: Readonly<Record<string, SettingsValue>>; unavailable: Readonly<Record<string, { readonly value?: SettingsValue; readonly code: string; readonly message: string }>>; revision: number }>
  const [values, setValues] = createSignal<Readonly<Record<string, SettingsValue>>>(EMPTY_VALUES)
  const [adapterSnapshot, setAdapterSnapshot] = createSignal<AdapterSnapshot>(EMPTY_ADAPTER_SNAPSHOT)
  createEffect(on([adapter, pluginId], ([currentAdapter]) => {
    const sync = () => {
      setValues(() => currentAdapter?.getSnapshot().values ?? (pluginId() ? store.getSnapshot(pluginId()) : EMPTY_VALUES))
      setAdapterSnapshot(() => currentAdapter?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT)
    }
    sync()
    const unsubscribe = currentAdapter
      ? currentAdapter.subscribe(sync)
      : pluginId() ? store.subscribe(pluginId(), () => sync()) : () => {}
    onCleanup(unsubscribe)
  }))
  const optionSnapshot = createRegistrySignal(optionsRegistry, () => optionsRegistry.getSnapshot())

  const schemaFieldOptions = createMemo(() => {
    const current = entry()
    if (!current?.value.schema) return {} as Record<string, readonly RendererSettingOption[]>
    return Object.fromEntries(current.value.schema.groups.flatMap(group => group.fields.map(field => {
      const key = settingFieldKey(field)
      if (field.type !== 'choice' && field.type !== 'multi-choice' && field.type !== 'color') return []
      const target = 'optionTarget' in field && field.optionTarget
        ? field.optionTarget
        : `plugin-page.${encodeURIComponent(pluginId()).replaceAll('.', '%2E')}.${encodeURIComponent(props.pageId).replaceAll('.', '%2E')}.${encodeURIComponent(key).replaceAll('.', '%2E')}`
      const base = 'options' in field ? field.options : []
      return [[key, resolvePluginSettingOptions(target, base, optionSnapshot().entries)]] as const
    })))
  })

  return (
    <Show when={entry()} keyed fallback={
      <div class="settings-empty-state"><h3>插件设置页已不可用</h3><p>插件可能已停用或更新。</p></div>
    }>
      {(current) => (
        <section class="plugin-settings-page" aria-label={current.value.label}>
          <header><span>{current.ownerPluginId}</span><h3>{current.value.label}</h3><Show when={current.value.description}><p>{current.value.description}</p></Show></header>
          <PluginContributionBoundary contributionId={current.contributionId}>
              {(() => {
                const pluginId = current.ownerPluginId ?? ''
                const schemaHost = current.value.schema && adapter() ? (
                  <RendererSettingsSchemaHost
                    schema={current.value.schema}
                    anchorPrefix={`schema:${props.pageId}`}
                    values={adapterSnapshot().values}
                    unavailable={adapterSnapshot().unavailable}
                    options={schemaFieldOptions()}
                    onChange={(key, value) => { void adapter()?.setValue(key, value) }}
                    onReset={key => { void adapter()?.reset(key) }}
                    onRestoreUnavailable={key => { adapter()?.restoreUnavailable?.(key) }}
                  />
                ) : null
                if (current.value.renderKind === 'isolated-surface') {
                  if (!current.value.surfaceId) return null
                  return (
                    <>
                      {schemaHost}
                      <IsolatedPluginSurface
                        surfaceId={current.value.surfaceId}
                        className="plugin-settings-surface"
                        input={{ pluginId, pageId: props.pageId, values: values() }}
                        onEvent={(event, detail) => {
                          if (event === 'settings:set' && detail && typeof detail === 'object') {
                            const { key, value } = detail as { key?: unknown; value?: unknown }
                            if (typeof key === 'string') {
                              const active = adapter()
                              if (active) void active.setValue(key, value as never)
                              else store.set(pluginId, key, value as never)
                            }
                          }
                          if (event === 'settings:remove' && typeof detail === 'string') {
                            const active = adapter()
                            if (active) void active.removeValue(detail)
                            else store.remove(pluginId, detail)
                          }
                        }}
                      />
                    </>
                  )
                }
                const Contribution = current.value.renderKind === 'first-party-solid' ? current.value.component : null
                return (
                  <>
                    {schemaHost}
                    <Suspense fallback={<div class="settings-empty-state">正在加载插件设置…</div>}>
                      {Contribution && (
                        <Contribution
                          pluginId={pluginId}
                          values={values()}
                          setValue={(key, value) => adapter() ? adapter()!.setValue(key, value) : store.set(pluginId, key, value)}
                          removeValue={key => adapter() ? adapter()!.removeValue(key) : store.remove(pluginId, key)}
                        />
                      )}
                    </Suspense>
                  </>
                )
              })()}
          </PluginContributionBoundary>
        </section>
      )}
    </Show>
  )
}

/** React 薄桥（PluginSettingsPageHost.tsx）经 eager glob 调用的挂载缝。 */
export const renderPluginSettingsPageHost = createSolidMount(PluginSettingsPageHost)
