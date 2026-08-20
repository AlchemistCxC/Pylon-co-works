import { useStore } from '../store'
import type { SheetContext, SheetRecord } from './sheetTypes'
import { resolveSheetRender } from './sheetRegistry.tsx'

/**
 * SheetSidebarSlot — 侧栏壳（W1-03 侧栏上移）。
 *
 * 布局层按 activeSheet.kind 查渲染注册表的 sidebar 声明渲染；entry 无 sidebar → 自然收起
 * （能力差异不判断，F2-A）。showSidebar 主题开关消费点从 AgentSheetView 移入本壳
 * （细化路线 §4 W1-03 步骤 2）。
 */
export default function SheetSidebarSlot({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const showSidebar = useStore(s => s.showSidebar !== false)
  const entry = resolveSheetRender(sheet.kind)
  const SidebarComponent = entry?.sidebar
  if (!showSidebar || !SidebarComponent) return null
  try {
    return <SidebarComponent sheet={sheet} ctx={ctx} state={entry.deserialize(sheet.state)} />
  } catch {
    return null
  }
}
