import { Suspense, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { useWorkspaceStore } from '../../workspaceStore.ts'
import { getContextPanelRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { IsolatedPluginSurface } from '../../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../../plugin-runtime/ui/PluginContributionBoundary.tsx'
import type { ContextPanelContributionProps } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { useStore } from '../../store.ts'
import { selectAvailableContextPanels } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'

export default function ContextPanelHost({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const rightWidth = useStore(state => state.rightWidth)
  const registry = getContextPanelRegistry()
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
  const [activeId, setActiveId] = useState<string>('')
  const active = entries.find(entry => entry.contributionId === activeId) ?? entries[0]

  if (!active) return null

  const renderActive = () => {
    if (active.value.renderKind === 'isolated-surface') {
      return <IsolatedPluginSurface
        surfaceId={active.value.surfaceId}
        className="context-panel-plugin-surface"
        input={{
          workspaceKind: sheet.kind,
          sheet: { id: sheet.id, kind: sheet.kind, title: sheet.title, agentId: sheet.agentId, metadata: sheet.metadata },
          activeSessionId: ctx.activeSession,
        }}
        onEvent={(event, detail) => {
          if (event === 'host:collapse') useWorkspaceStore.getState().setRightPanelCollapsed(true)
          if (event === 'host:select-session' && (typeof detail === 'string' || detail === null)) ctx.selectSession(detail)
        }}
      />
    }
    const Contribution = active.value.component
    const props: ContextPanelContributionProps = { sheet, ctx }
    return <Suspense fallback={null}><Contribution {...props} /></Suspense>
  }

  return (
    <aside className="context-panel" aria-label={`${sheet.title} 右栏`} style={{ '--right-width': `${rightWidth}px` } as CSSProperties}>
      <div className="context-panel-head">
        <div className="context-panel-tabs" role="tablist" aria-label="右栏面板">
          {entries.map(entry => (
            <button key={entry.contributionId} type="button" role="tab" aria-selected={entry.contributionId === active.contributionId} className={`context-panel-mode ${entry.contributionId === active.contributionId ? 'active' : ''}`} onClick={() => setActiveId(entry.contributionId)}>{entry.value.label}</button>
          ))}
        </div>
        <button type="button" className="context-panel-collapse" onClick={() => useWorkspaceStore.getState().setRightPanelCollapsed(true)} aria-label="收起右栏">»</button>
      </div>
      <div className="context-panel-body">
        <PluginContributionBoundary key={`${active.ownerRuntimeInstanceId}:${active.contributionId}`} contributionId={active.contributionId}>{renderActive()}</PluginContributionBoundary>
      </div>
    </aside>
  )
}
