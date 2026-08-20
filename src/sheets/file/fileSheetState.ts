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
  activeSection: string
  targetSessionId: string | null
}

export type FileSheetAction =
  | { type: 'set-section'; section: string }
  | { type: 'set-target-session'; sessionId: string | null }

export function createFileSheetState(sessionId: string | null): FileSheetState {
  return { activeSection: 'builtin.file.explorer', targetSessionId: sessionId }
}

export function resetFileSheetTransientState() {
  return {
    truncated: false,
    instruction: '',
    fileContent: '',
  }
}

export function fileSheetReducer(state: FileSheetState, action: FileSheetAction): FileSheetState {
  switch (action.type) {
    case 'set-section':
      return { ...state, activeSection: action.section }
    case 'set-target-session':
      return { ...state, targetSessionId: action.sessionId }
  }
}
// ── W2-04 → v2：metadata openTabs 版本化 tab 记录（ISSUE-08 D-02/D-04 统一 file/diff tab identity） ──
// 旧 `openTabs: string[]`（v1）在 parseFileTabs 内迁移为 file-mode tabs；损坏数据回退为空。
// tab 单例 key = `${mode}:${path}`：同路径 file/diff 并存且不互相覆盖（关闭/切换不串 mode）。

export type FileTabMode = 'file' | 'diff'

export interface FileTabRecord {
  path: string
  /** Open string namespace; first-party values are file.text and git.diff. */
  viewType?: string
  /** @deprecated v2 compatibility input only. */
  mode?: FileTabMode
  /** diff-mode tab 的 SCM 范围：true = staged（HEAD ↔ Index） */
  staged?: boolean
}

export interface FileTabState {
  version: 2 | 3
  tabs: FileTabRecord[]
  activeKey: string | null
}

export const EMPTY_FILE_TAB_STATE: FileTabState = { version: 3, tabs: [], activeKey: null }

/** tab 单例 key：mode 参与 identity——同路径 file/diff 不互相覆盖 */
export function fileTabViewType(tab: Pick<FileTabRecord, 'viewType' | 'mode'>): string {
  return tab.viewType ?? (tab.mode === 'diff' ? 'git.diff' : 'file.text')
}

export function fileTabKey(tab: Pick<FileTabRecord, 'path' | 'viewType' | 'mode'>): string {
  return `${fileTabViewType(tab)}:${tab.path}`
}

export function serializeFileTabs(state: FileTabState): string {
  return JSON.stringify(state)
}

function isFileTabRecord(value: unknown): value is FileTabRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string' && record.path.length > 0 &&
    (typeof record.viewType === 'string' && record.viewType.length > 0 || record.mode === 'file' || record.mode === 'diff')
}

/** 按 tab 单例 key 去重：同 key 只保留一条（保留最后一条），非法/重复记录不产生双 tab */
function dedupeTabs(tabs: FileTabRecord[]): FileTabRecord[] {
  const seen = new Map<string, FileTabRecord>()
  for (const tab of tabs) seen.set(fileTabKey(tab), tab)
  return [...seen.values()]
}

/** v2 规范化：过滤非法条目 + 按 key 去重；activeKey 失效 → 回退最后一个 tab 的 key */
function normalizeFileTabState(parsed: { tabs?: unknown; activeKey?: unknown }): FileTabState {
  const tabs = Array.isArray(parsed.tabs) ? dedupeTabs(parsed.tabs.filter(isFileTabRecord).map(tab => ({
    path: tab.path,
    viewType: fileTabViewType(tab),
    ...(tab.staged === undefined ? {} : { staged: tab.staged }),
  }))) : []
  const lastKey = tabs.length > 0 ? fileTabKey(tabs[tabs.length - 1]) : null
  const migratedActiveKey = typeof parsed.activeKey === 'string'
    ? parsed.activeKey.replace(/^file:/, 'file.text:').replace(/^diff:/, 'git.diff:')
    : parsed.activeKey
  const normalizedActiveKey = typeof migratedActiveKey === 'string' && tabs.some(tab => fileTabKey(tab) === migratedActiveKey)
    ? migratedActiveKey
    : lastKey
  return { version: 3, tabs, activeKey: normalizedActiveKey }
}

/**
 * 宽容解析 + 版本迁移：
 * - v1 `openTabs: string[]` → 全部迁移为 file-mode tab；activeKey 取最后一条。
 * - v2 `{version:2,tabs:[...],activeKey}` → 规范化过滤。
 * - 损坏 JSON / 非 v1 数组 / 非 v2 对象 → 空（不清整个 persistence）。
 */
export function parseFileTabs(raw: string | undefined): FileTabState {
  if (!raw) return EMPTY_FILE_TAB_STATE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const tabs = dedupeTabs(parsed
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map(path => ({ path, mode: 'file' as const })))
      return { version: 3, tabs: tabs.map(tab => ({ path: tab.path, viewType: 'file.text' })), activeKey: tabs.length > 0 ? `file.text:${tabs[tabs.length - 1].path}` : null }
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as Record<string, unknown>
      if (candidate.version === 2 || candidate.version === 3) return normalizeFileTabState(candidate)
    }
    return EMPTY_FILE_TAB_STATE
  } catch {
    return EMPTY_FILE_TAB_STATE
  }
}

/** 由文件路径推断高亮语言（md 走渲染器；其余走 highlightCode scope） */
export function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json', css: 'css', html: 'html', rs: 'rust', py: 'python', go: 'go', md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml', sh: 'shell' }
  return map[ext] ?? 'text'
}
