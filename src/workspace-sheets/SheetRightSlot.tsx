import { useWorkspaceStore } from '../workspaceStore'
import type { SheetContext, SheetRecord } from './sheetTypes'
import { SHEET_RENDER_REGISTRY } from './sheetRegistry.tsx'

/**
 * SheetRightSlot — 右栏壳（W1-03 预留，W1-04 接 ContextPanel）。
 *
 * 布局层按 activeSheet.kind 查渲染注册表的 rightPanel 声明；'none'/缺失/右栏折叠
 * （workspaceStore.rightPanelCollapsed）→ 不渲染。旧 RightPanel（App 单例）在
 * W2-12 退役前暂留。
 */
export default function SheetRightSlot({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const rightPanelCollapsed = useWorkspaceStore(s => s.rightPanelCollapsed)
  const entry = SHEET_RENDER_REGISTRY[sheet.kind]
  const rightPanel = entry?.rightPanel
  if (!rightPanel || rightPanel === 'none' || rightPanelCollapsed) return null
  const RightPanelComponent = rightPanel
  return <RightPanelComponent ctx={ctx} />
}
