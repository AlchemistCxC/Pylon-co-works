import { Suspense, useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getContextPanelRegistry, getPluginSettingOptionsRegistry, getPluginSettingsStore } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import { resolvePluginSettingOptions } from '../../plugin-runtime/settings/pluginSettingOptionsRegistry.ts'
import { settingFieldKey } from '../../plugin-runtime/renderers/rendererSettingsTypes.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'
import type { ContextPanelContributionProps } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'
import type { ContextPanelSurfaceInput } from '../../plugin-runtime/context-panel/contextPanelSurfaceProtocol.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { selectContextPanels, resolveContextPanelDefault } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from './rightRailStore.ts'
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
  // 可切换的面板 = 通过 `when` 闸门的全部面板（与 Sheet 种类无关）；种类只影响「没选过时默认看谁」。
  const entries = useMemo(() => selectContextPanels(snapshot.entries, {
    workspaceKind: sheet.kind,
    sheetId: sheet.id,
    activeSessionId: ctx.activeSession,
  }), [ctx.activeSession, sheet.id, sheet.kind, snapshot])
  const [activeId, setActiveId] = useState<string>(activePanelId ?? '')
  useEffect(() => {
    if (activePanelId !== undefined) setActiveId(activePanelId ?? '')
  }, [activePanelId])
  const active = entries.find(entry => entry.contributionId === activeId)
    ?? resolveContextPanelDefault(entries, sheet.kind)

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
          } satisfies ContextPanelSurfaceInput}
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
        anchorPrefix={`schema:${active.contributionId}`}
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
      anchorPrefix={`schema:${active.contributionId}`}
      values={adapterSnapshot.values}
      unavailable={adapterSnapshot.unavailable}
      options={Object.fromEntries(active.value.schema.groups.flatMap(group => group.fields.map(field => {
        const key = settingFieldKey(field)
        if (field.type !== 'choice' && field.type !== 'multi-choice' && field.type !== 'color') return []
        const target = 'optionTarget' in field && field.optionTarget
          ? field.optionTarget
          : `context-panel.${encodeURIComponent(active.ownerPluginId ?? '').replaceAll('.', '%2E')}.${encodeURIComponent(active.contributionId).replaceAll('.', '%2E')}.${encodeURIComponent(key).replaceAll('.', '%2E')}`
        const base = 'options' in field ? field.options : []
        return [[key, resolvePluginSettingOptions(target, base, optionSnapshot.entries)]] as const
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

  // aria-label 用稳定文案（#250）：sheet.title 是建会话时刻的快照，会话切换/
  // 重命名后陈旧，实机 a11y 树出现指向过期会话的右栏名；归属上下文已由页签与
  // 下方面板 tablist 承载，这里不需要会话名。
  return (
    <aside className="context-panel" data-sheet-kind={sheet.kind} aria-label="右栏" style={{ '--right-width': `${rightWidth}px` } as CSSProperties}>
      <div className="context-panel-head">
        {/* 切换器列出**所有可显示的面板**（`when` 闸门之上的全部），不再按 Sheet 种类裁剪：
            按种类裁剪时，单面板的 Sheet 只剩一个撑满的标签，看上去是标题而不是切换器
            （用户实机报「侧栏内部没有切换侧栏种类的按钮」）。 */}
        <div className="context-panel-tabs" role="tablist" aria-label="右栏面板">
          {entries.map(entry => (
            <button
              key={entry.contributionId}
              type="button"
              role="tab"
              aria-selected={entry.contributionId === active.contributionId}
              className={`context-panel-mode ${entry.contributionId === active.contributionId ? 'active' : ''}`}
              title={entry.value.label}
              onClick={() => {
                // 选择要落到 store（而不仅是本地 state）：它是「用户显式选过」的唯一凭据——
                // 决定跨 Sheet 是否保持、重载后是否还记得。只写本地 state 的话，切一次 Sheet
                // 就会被亲和默认值抢回去。
                setActiveId(entry.contributionId)
                useRightRailStore.getState().setActivePanel(entry.contributionId)
              }}
            >
              {entry.value.label}
            </button>
          ))}
        </div>
      </div>
      <div className="context-panel-body">
        <PluginContributionBoundary key={`${active.ownerRuntimeInstanceId}:${active.contributionId}`} contributionId={active.contributionId}>{renderActive()}</PluginContributionBoundary>
      </div>
    </aside>
  )
}

const EMPTY_ADAPTER_SNAPSHOT = Object.freeze({ values: Object.freeze({}), unavailable: Object.freeze({}), revision: 0 })
