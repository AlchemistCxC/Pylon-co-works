import { useWorkspaceStore } from '../workspaceStore'
import type { SheetContext, SheetRecord } from './sheetTypes'
import ContextPanelHost from '../components/right-panel/ContextPanelHost.tsx'
import { getContextPanelRegistry } from '../plugin-runtime/runtimeServices.ts'
import { useSyncExternalStore } from 'react'

/**
 * SheetRightSlot — 右栏壳（W1-03 预留，W1-04 接 ContextPanel）。
 *
 * 布局层按 activeSheet.kind 查渲染注册表的 rightPanel 声明；'none'/缺失/右栏折叠
 * （workspaceStore.rightPanelCollapsed）→ 不渲染。旧 RightPanel（App 单例）在
 * W2-12 退役前暂留。
 */
export default function SheetRightSlot({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const rightPanelCollapsed = useWorkspaceStore(s => s.rightPanelCollapsed)
  const registry = getContextPanelRegistry()
  const snapshot = useSyncExternalStore(
    listener => registry.subscribe(listener),
    () => registry.getSnapshot(),
    () => registry.getSnapshot(),
  )
  const enabled = snapshot.entries.some(entry => entry.value.workspaceKind === sheet.kind)
  if (!enabled || rightPanelCollapsed) return null
  return <ContextPanelHost sheet={sheet} ctx={ctx} />
}
