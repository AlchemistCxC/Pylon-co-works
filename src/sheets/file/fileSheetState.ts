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
// ── W2-04：metadata openTabs/activeFile 编解码（metadata 为 Record<string,string>，JSON 串承载） ──

export function serializeOpenTabs(paths: readonly string[]): string {
  return JSON.stringify(paths)
}

/** 宽容解析：损坏 JSON/非数组 → 空（metadata JSON 损坏需 normalize 为空，不使整个 persistence 变 EMPTY） */
export function parseOpenTabs(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 由文件路径推断高亮语言（md 走渲染器；其余走 highlightCode scope） */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', css: 'css', html: 'html', rs: 'rust', py: 'python', go: 'go', md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml', sh: 'shell' }
  return map[ext] ?? 'text'
}
