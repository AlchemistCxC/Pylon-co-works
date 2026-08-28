import { useWorkspaceStore } from '../workspaceStore'
import type { SheetContext, SheetRecord } from './sheetTypes'
import ContextPanelHost from '../components/right-panel/ContextPanelHost.tsx'
import { getContextPanelRegistry } from '../plugin-runtime/runtimeServices.ts'
import { useSyncExternalStore } from 'react'
import { selectAvailableContextPanels } from '../plugin-runtime/context-panel/contextPanelSelection.ts'

const contextPanelRegistry = getContextPanelRegistry()
const subscribeContextPanels = (listener: () => void) => contextPanelRegistry.subscribe(listener)
const getContextPanelSnapshot = () => contextPanelRegistry.getSnapshot()

/**
 * SheetRightSlot — 右栏壳（W1-03 预留，W1-04 接 ContextPanel）。
 *
 * 布局层按 activeSheet.kind 查渲染注册表的 rightPanel 声明；'none'/缺失/右栏折叠
 * （workspaceStore.rightPanelCollapsed）→ 不渲染。旧 RightPanel（App 单例）在
 * W2-12 退役前暂留。
 */
export default function SheetRightSlot({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const rightPanelCollapsed = useWorkspaceStore(s => s.rightPanelCollapsed)
  const snapshot = useSyncExternalStore(
    subscribeContextPanels,
    getContextPanelSnapshot,
    getContextPanelSnapshot,
  )
  const enabled = selectAvailableContextPanels(snapshot.entries, {
    workspaceKind: sheet.kind,
    sheetId: sheet.id,
    activeSessionId: ctx.activeSession,
  }).length > 0
  if (!enabled || rightPanelCollapsed) return null
  return <ContextPanelHost sheet={sheet} ctx={ctx} />
}
