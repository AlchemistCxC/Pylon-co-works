import { Suspense, useMemo, useSyncExternalStore } from 'react'
import { getPluginSettingsPageRegistry, getPluginSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'

export default function PluginSettingsPageHost({ pageId }: { pageId: string }) {
  const registry = getPluginSettingsPageRegistry()
  const store = getPluginSettingsStore()
  const snapshot = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  )
  const entry = snapshot.entries.find(candidate => candidate.contributionId === pageId)
  const pluginId = entry?.ownerPluginId ?? ''
  const adapter = useMemo(() => entry?.value.schema
    ? entry.value.valueAdapter ?? (pluginId ? createPluginSettingsValueAdapter({ store, ownerPluginId: pluginId, contributionId: pageId, namespace: 'plugin-page' }) : undefined)
    : undefined, [entry, pageId, pluginId, store])
  const values = useSyncExternalStore(
    listener => adapter ? adapter.subscribe(listener) : pluginId ? store.subscribe(pluginId, listener) : () => {},
    () => adapter?.getSnapshot().values ?? (pluginId ? store.getSnapshot(pluginId) : EMPTY_VALUES),
    () => adapter?.getSnapshot().values ?? (pluginId ? store.getSnapshot(pluginId) : EMPTY_VALUES),
  )

  if (!entry) return <div className="settings-empty-state"><h3>插件设置页已不可用</h3><p>插件可能已停用或更新。</p></div>

  const Contribution = entry.value.renderKind === 'first-party-react' ? entry.value.component : null

  const content = entry.value.renderKind === 'isolated-surface'
    ? <IsolatedPluginSurface
        surfaceId={entry.value.surfaceId}
        className="plugin-settings-surface"
        input={{ pluginId, pageId, values }}
        onEvent={(event, detail) => {
          if (event === 'settings:set' && detail && typeof detail === 'object') {
            const { key, value } = detail as { key?: unknown; value?: unknown }
            if (typeof key === 'string') {
              if (adapter) adapter.setValue(key, value as never)
              else store.set(pluginId, key, value as never)
            }
          }
          if (event === 'settings:remove' && typeof detail === 'string') {
            if (adapter) adapter.removeValue(detail)
            else store.remove(pluginId, detail)
          }
        }}
      />
    : <Suspense fallback={<div className="settings-empty-state">正在加载插件设置…</div>}>
        {Contribution && <Contribution
          pluginId={pluginId}
          values={values}
          setValue={(key, value) => adapter ? adapter.setValue(key, value) : store.set(pluginId, key, value)}
          removeValue={key => adapter ? adapter.removeValue(key) : store.remove(pluginId, key)}
        />}
      </Suspense>

  return (
    <section className="plugin-settings-page" aria-label={entry.value.label}>
      <header><span>{pluginId}</span><h3>{entry.value.label}</h3>{entry.value.description && <p>{entry.value.description}</p>}</header>
      <PluginContributionBoundary contributionId={entry.contributionId}>{content}</PluginContributionBoundary>
    </section>
  )
}

const EMPTY_VALUES = Object.freeze({})
