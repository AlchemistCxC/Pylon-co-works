/**
 * fileSheetState — FileSheet 分区状态纯域（W2-03）。
 *
 * 五分区（会话/文件/搜索/SCM/视图）+ targetSource（当前指向的会话 source）。
 * targetSource 是本地态：sheet 的 singletonKey = file:{初始 source}（同工作区复用），
 * 内部允许改指向；metadata 由组件经 workspaceStore patch（不串 source）。
 */

export const FILE_SHEET_SECTIONS = ['sessions', 'files', 'search', 'scm', 'views'] as const
export type FileSheetSection = (typeof FILE_SHEET_SECTIONS)[number]

export interface FileSheetState {
  activeSection: FileSheetSection
  targetSource: string | null
}

export type FileSheetAction =
  | { type: 'set-section'; section: FileSheetSection }
  | { type: 'set-source'; source: string | null }

export function createFileSheetState(source: string | null): FileSheetState {
  return { activeSection: 'files', targetSource: source }
}

export function fileSheetReducer(state: FileSheetState, action: FileSheetAction): FileSheetState {
  switch (action.type) {
    case 'set-section':
      return { ...state, activeSection: action.section }
    case 'set-source':
      return { ...state, targetSource: action.source }
  }
}
