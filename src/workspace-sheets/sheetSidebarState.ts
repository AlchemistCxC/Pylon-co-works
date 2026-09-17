import type { SheetRecord } from './sheetTypes.ts'
import { resolveSheetRender } from './sheetRegistry.tsx'

export const SHEET_SIDEBAR_COLLAPSED_KEY = 'pylon.sidebarCollapsed'

/** Sheet 左栏折叠状态按 sheet id 隔离；未写入时一律展开，禁止继承其他 Sheet。 */
export function resolveSheetSidebarCollapsed(sheet: SheetRecord | undefined): boolean {
  return sheet?.metadata?.[SHEET_SIDEBAR_COLLAPSED_KEY] === 'true'
}

export function sheetSidebarCollapsedMetadata(collapsed: boolean): Record<string, string> {
  return { [SHEET_SIDEBAR_COLLAPSED_KEY]: String(collapsed) }
}

/**
 * #154：布局层是否会为这个 Sheet 渲染左列。
 *
 * 判据是 `sidebarMode`（`'workspace'` / `'sheet'` 两类都渲染左列；`'none'` 显式不要）。
 * 不要用「注册表是否声明了 `sidebar` 组件」判——`sidebar:` 只是把*内容*交给布局层
 * 渲染的通道（agent 走这条），其余 7 个 kind 由各自的视图渲染左栏内容。两者都要求
 * 那个左列外壳挂共享几何类 `.sidebar`，这正是 `src/sheets/__tests__/SheetInternalSidebars`
 * 与 `src/workspace-sheets/__tests__/sidebarUnifiedModel.css.test.ts` 钉住的契约。
 *
 * 本函数是 App（标题栏轨道是否占位）与 SheetLayout（`data-sidebar` 状态）的**同一份**
 * 判据——两处各算一套会让标题栏与左列对「本 Sheet 有没有左栏」得出两个结论。
 */
export function sheetHasLeftColumn(sheet: SheetRecord | undefined): boolean {
  if (!sheet) return false
  const entry = resolveSheetRender(sheet.kind)
  if (!entry) return false
  return entry.sidebarMode !== 'none'
}

