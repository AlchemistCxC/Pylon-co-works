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

export function resetFileSheetTransientState() {
  return {
    activeDiff: null as { path: string; staged: boolean } | null,
    truncated: false,
    instruction: '',
    fileContent: '',
  }
}

export function fileSheetReducer(state: FileSheetState, action: FileSheetAction): FileSheetState {
  switch (action.type) {
    case 'set-section':
      return { ...state, activeSection: action.section }
    case 'set-source':
      return { ...state, targetSource: action.source }
  }
}
// ── W2-04 → v2：metadata openTabs 版本化 tab 记录（ISSUE-08 D-02/D-04 统一 file/diff tab identity） ──
// 旧 `openTabs: string[]`（v1）在 parseFileTabs 内迁移为 file-mode tabs；损坏数据回退为空。
// tab 单例 key = `${mode}:${path}`：同路径 file/diff 并存且不互相覆盖（关闭/切换不串 mode）。

export type FileTabMode = 'file' | 'diff'

export interface FileTabRecord {
  path: string
  mode: FileTabMode
  /** diff-mode tab 的 SCM 范围：true = staged（HEAD ↔ Index） */
  staged?: boolean
}

export interface FileTabState {
  version: 2
  tabs: FileTabRecord[]
  activeKey: string | null
}

export const EMPTY_FILE_TAB_STATE: FileTabState = { version: 2, tabs: [], activeKey: null }

// ── 已弃用：v1 openTabs:string[] 编解码，仅保留至 FileSheetView 迁移到版本化 tab（临时，勿新增消费） ──
export function serializeOpenTabs(paths: readonly string[]): string {
  return JSON.stringify(paths)
}

/** 宽容解析：损坏 JSON/非数组 → 空 */
export function parseOpenTabs(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** tab 单例 key：mode 参与 identity——同路径 file/diff 不互相覆盖 */
export function fileTabKey(tab: Pick<FileTabRecord, 'path' | 'mode'>): string {
  return `${tab.mode}:${tab.path}`
}

export function serializeFileTabs(state: FileTabState): string {
  return JSON.stringify(state)
}

function isFileTabRecord(value: unknown): value is FileTabRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string' && record.path.length > 0 &&
    (record.mode === 'file' || record.mode === 'diff')
}

/** v2 规范化：过滤非法条目；activeKey 失效 → 回退最后一个 tab 的 key */
function normalizeFileTabState(parsed: { tabs?: unknown; activeKey?: unknown }): FileTabState {
  const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isFileTabRecord) : []
  const lastKey = tabs.length > 0 ? fileTabKey(tabs[tabs.length - 1]) : null
  const activeKey = typeof parsed.activeKey === 'string' && tabs.some(tab => fileTabKey(tab) === parsed.activeKey)
    ? parsed.activeKey
    : lastKey
  return { version: 2, tabs, activeKey }
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
      const tabs = parsed
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
        .map(path => ({ path, mode: 'file' as const }))
      return { version: 2, tabs, activeKey: tabs.length > 0 ? fileTabKey(tabs[tabs.length - 1]) : null }
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const candidate = parsed as Record<string, unknown>
      if (candidate.version === 2) return normalizeFileTabState(candidate)
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
