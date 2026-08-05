import type { SheetContext, SheetRecord } from './sheetTypes'
import { SHEET_RENDER_REGISTRY } from './sheetRegistry.tsx'

/**
 * SheetRightSlot — 右栏壳（W1-03 预留，W1-04 接 ContextPanel）。
 *
 * 布局层按 activeSheet.kind 查渲染注册表的 rightPanel 声明；当前无 sheet 声明右栏
 * （'none' 或缺失）→ 不渲染。旧 RightPanel（App 单例）在 W2-12 退役前暂留。
 */
export default function SheetRightSlot({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const entry = SHEET_RENDER_REGISTRY[sheet.kind]
  const rightPanel = entry?.rightPanel
  if (!rightPanel || rightPanel === 'none') return null
  const RightPanelComponent = rightPanel
  return <RightPanelComponent ctx={ctx} />
}
