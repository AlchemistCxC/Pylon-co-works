// W1-01（F1-A 方案 A）：9 kind 原地替换——删 diff/changes/git-history（FileSheet 分区化，
// 从未有内容），增 overview/search/history/browser/gateway；旧 kind 由 schema v2 normalize 清洗。
// #154 阶段 4：增 settings（设置由固定覆盖层迁入 sheet 体系），10 kind。
// #371：增 docs（离线文档站），11 kind。
// #484：删 prism（演示 sheet 出树）；遗留 prism 落盘值由 kind 清洗兜底。
// 结构审查 B-2：Sheet 纯类型正身迁 src/contracts/sheets.ts（plugin-runtime 与视图共用），
// 本文件保留内置 kind 表与 kind 有效性值件。
import { isSheetKind } from '../plugin-runtime/workspaces/workspaceRegistry.ts'

export {
  type SheetContext,
  type SheetId,
  type SheetInput,
  type SheetKind,
  type SheetRecord,
  type SidebarMode,
} from '../contracts/sheets.ts'
export type { BuiltinSheetKind } from './sheetKinds.ts'

/** 内置 workspace 种子；动态 kind 的有效性以 Workspace Registry 为准。 */
export const SHEET_KINDS = [
  'agent',
  'runtime',
  'file',
  'overview',
  'search',
  'history',
  'browser',
  'gateway',
  'settings',
  'docs',
] as const

export { isSheetKind }
