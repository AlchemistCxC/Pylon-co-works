import { Suspense, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getContextPanelRegistry, getPluginSettingOptionsRegistry, getPluginSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import { settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'
import type { ContextPanelContributionProps } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { selectAvailableContextPanels } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../../rightRailStore.ts'
import { RendererSettingsSchemaHost } from '../settings/RendererSettingField.tsx'

export default function ContextPanelHost({ sheet, ctx, activePanelId }: { sheet: SheetRecord; ctx: SheetContext; activePanelId?: string | null }) {
  const rightWidth = useRightRailStore(state => state.width)
  const registry = getContextPanelRegistry()
  const store = getPluginSettingsStore()
  const optionsRegistry = getPluginSettingOptionsRegistry()
  const snapshot = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  )
  const entries = useMemo(() => selectAvailableContextPanels(snapshot.entries, {
    workspaceKind: sheet.kind,
    sheetId: sheet.id,
    activeSessionId: ctx.activeSession,
  }), [ctx.activeSession, sheet.id, sheet.kind, snapshot])
  const [activeId, setActiveId] = useState<string>(activePanelId ?? '')
  useEffect(() => {
    if (activePanelId !== undefined) setActiveId(activePanelId ?? '')
  }, [activePanelId])
  const active = entries.find(entry => entry.contributionId === activeId) ?? entries[0]

  const adapter = useMemo(() => active?.value.schema
    ? active.value.valueAdapter ?? (active.ownerPluginId
      ? createPluginSettingsValueAdapter({ store, ownerPluginId: active.ownerPluginId, contributionId: active.contributionId, namespace: 'context-panel' })
      : undefined)
    : undefined, [active, store])
  const adapterSnapshot = useSyncExternalStore(
    listener => adapter ? adapter.subscribe(listener) : () => {},
    () => adapter?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT,
    () => adapter?.getSnapshot() ?? EMPTY_ADAPTER_SNAPSHOT,
  )
  const optionSnapshot = useSyncExternalStore(
    listener => optionsRegistry.subscribe(listener),
    () => optionsRegistry.getSnapshot(),
    () => optionsRegistry.getSnapshot(),
  )

  if (!active) return null

  const renderActive = () => {
    if (active.value.renderKind === 'isolated-surface') {
      const surface = <IsolatedPluginSurface
          surfaceId={active.value.surfaceId}
          className="context-panel-plugin-surface"
          input={{
            workspaceKind: sheet.kind,
            sheet: { id: sheet.id, kind: sheet.kind, title: sheet.title, agentId: sheet.agentId, metadata: sheet.metadata },
            activeSessionId: ctx.activeSession,
            values: adapterSnapshot.values,
          }}
          onEvent={(event, detail) => {
            if (event === 'host:collapse') {
              useRightRailStore.getState().setCollapsed(true)
            }
            if (event === 'host:select-session' && (typeof detail === 'string' || detail === null)) ctx.selectSession(detail)
            if (event === 'settings:set' && detail && typeof detail === 'object' && adapter) {
              const { key, value } = detail as { key?: unknown; value?: unknown }
              if (typeof key === 'string') void adapter.setValue(key, value as never)
            }
            if (event === 'settings:remove' && typeof detail === 'string' && adapter) void adapter.removeValue(detail)
          }}
        />
      return active.value.schema && adapter ? <><RendererSettingsSchemaHost
        schema={active.value.schema}
        values={adapterSnapshot.values}
        unavailable={adapterSnapshot.unavailable}
        onChange={(key, value) => { void adapter.setValue(key, value) }}
        onReset={key => { void adapter.reset(key) }}
        onRestoreUnavailable={key => { adapter.restoreUnavailable?.(key) }}
      />{surface}</> : surface
    }
    const Contribution = active.value.component
    const props: ContextPanelContributionProps = { sheet, ctx }
    const schemaContent = active.value.schema && adapter ? <RendererSettingsSchemaHost
      schema={active.value.schema}
      values={adapterSnapshot.values}
      unavailable={adapterSnapshot.unavailable}
      options={Object.fromEntries(active.value.schema.groups.flatMap(group => group.fields.map(field => {
        const key = settingFieldKey(field)
        if (!('options' in field)) return []
        const target = 'optionTarget' in field && field.optionTarget
          ? field.optionTarget
          : `context-panel.${encodeURIComponent(active.ownerPluginId ?? '').replaceAll('.', '%2E')}.${encodeURIComponent(active.contributionId).replaceAll('.', '%2E')}.${encodeURIComponent(key).replaceAll('.', '%2E')}`
        return [[key, resolvePluginSettingOptions(target, field.options, optionSnapshot.entries)]] as const
      })))}
      onChange={(key, value) => { void adapter.setValue(key, value) }}
      onReset={key => { void adapter.reset(key) }}
      onRestoreUnavailable={key => { adapter.restoreUnavailable?.(key) }}
    /> : null
    return <>
      {schemaContent}
      <Suspense fallback={null}><Contribution {...props} /></Suspense>
    </>
  }

  return (
    <aside className="context-panel" aria-label={`${sheet.title} 右栏`} style={{ '--right-width': `${rightWidth}px` } as CSSProperties}>
      <div className="context-panel-head">
        <div className="context-panel-tabs" role="tablist" aria-label="右栏面板">
          {entries.map(entry => (
            <button key={entry.contributionId} type="button" role="tab" aria-selected={entry.contributionId === active.contributionId} className={`context-panel-mode ${entry.contributionId === active.contributionId ? 'active' : ''}`} onClick={() => setActiveId(entry.contributionId)}>{entry.value.label}</button>
          ))}
        </div>
        <button type="button" className="context-panel-collapse" onClick={() => {
          useRightRailStore.getState().setCollapsed(true)
        }} aria-label="收起右栏">»</button>
      </div>
      <div className="context-panel-body">
        <PluginContributionBoundary key={`${active.ownerRuntimeInstanceId}:${active.contributionId}`} contributionId={active.contributionId}>{renderActive()}</PluginContributionBoundary>
      </div>
    </aside>
  )
}

const EMPTY_ADAPTER_SNAPSHOT = Object.freeze({ values: Object.freeze({}), unavailable: Object.freeze({}), revision: 0 })
