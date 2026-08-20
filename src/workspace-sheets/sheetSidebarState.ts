import type { SheetRecord } from './sheetTypes.ts'

export const SHEET_SIDEBAR_COLLAPSED_KEY = 'pylon.sidebarCollapsed'

/** Sheet 左栏折叠状态按 sheet id 隔离；未写入时一律展开，禁止继承其他 Sheet。 */
export function resolveSheetSidebarCollapsed(sheet: SheetRecord | undefined): boolean {
  return sheet?.metadata?.[SHEET_SIDEBAR_COLLAPSED_KEY] === 'true'
}

export function sheetSidebarCollapsedMetadata(collapsed: boolean): Record<string, string> {
  return { [SHEET_SIDEBAR_COLLAPSED_KEY]: String(collapsed) }
}
