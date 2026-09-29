/**
 * fileViewContracts — 文件工作台贡献契约的本地形状（结构审查 B-2）。
 *
 * plugin-runtime 不得反向依赖视图目录；这里以**结构等价**的最小契约描述右栏文件树
 * 条目与文件页签记录，正身分别住在：
 * - `components/right-panel/rightPanelTypes.ts`（WorkspaceEntry / WorkspaceTextPreview）
 * - `sheets/file/fileSheetState.ts`（FileTabRecord / fileTabViewType）
 * 两侧形状由 fileWorkbenchApi 的消费面（视图侧实现 FileProvider）在编译期结构校验；
 * 改动正身字段时必须同步本文件（与 launchIcons 双份键表同一防漂移纪律）。
 */

export type FileTabMode = 'file' | 'diff'


export type { WorkspaceEntry, WorkspaceTextPreview } from '../../contracts/workspaceFiles.ts'

export interface FileTabRecord {
  path: string
  /** Open string namespace; first-party values are file.text and git.diff. */
  viewType?: string
  /** @deprecated v2 compatibility input only. */
mode?: FileTabMode
  /** diff-mode tab 的 SCM 范围：true = staged（HEAD ↔ Index） */
  staged?: boolean
  /** Optional 1-based reveal line, e.g. from workspace search. */
  line?: number
}

export function fileTabViewType(tab: Pick<FileTabRecord, 'viewType' | 'mode'>): string {
  return tab.viewType ?? (tab.mode === 'diff' ? 'git.diff' : 'file.text')
}
