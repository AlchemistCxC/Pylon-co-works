/**
 * workspaceContracts — 工作区 wire 收窄（W2-02）。
 *
 * 从 components/right-panel/workspaceApi 迁入（旧文件保留 compat re-export 供 RightPanel
 * 过渡）：list_workspace_entries / read_workspace_text 响应 normalize + workspace_error
 * 错误按 code 分支（absolute/traversal/outside/not_found/not_readable/not_file/binary/
 * too_many/io）。损坏 DTO/二进制不崩。
 */

import type { WorkspaceEntry, WorkspaceTextPreview, WorkspaceTree } from '../../components/right-panel/rightPanelTypes'

export interface WorkspaceTextResponse {
  relativePath: string
  content: string
  bytesRead: number
  totalBytes: number
  truncated: boolean
  encoding?: string
}

export interface WorkspaceBackendEntry {
  name: string
  relativePath: string
  kind: 'directory' | 'file' | 'symlink' | 'other'
  expandable?: boolean
}

export function normalizeWorkspaceEntries(entries: unknown): WorkspaceEntry[] {
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry): WorkspaceEntry[] => {
    if (!entry || typeof entry !== 'object') return []
    const value = entry as Partial<WorkspaceBackendEntry>
    if (typeof value.name !== 'string' || typeof value.relativePath !== 'string') return []
    if (value.kind !== 'directory' && value.kind !== 'file') return []
    return [{
      path: value.relativePath,
      label: value.name,
      kind: value.kind === 'directory' ? 'folder' : 'file',
      expandable: value.kind === 'directory' && value.expandable !== false,
    }]
  })
}

export function mergeWorkspaceEntries(
  entries: readonly WorkspaceEntry[],
  path: string,
  children: readonly WorkspaceEntry[],
): WorkspaceEntry[] {
  return entries.map(entry => {
    if (entry.path === path) return { ...entry, expandable: false, entries: children }
    if (!entry.entries) return entry
    return { ...entry, entries: mergeWorkspaceEntries(entry.entries, path, children) }
  })
}

export function normalizeWorkspaceText(value: unknown): WorkspaceTextPreview | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<WorkspaceTextPreview>
  if (typeof item.relativePath !== 'string' || typeof item.content !== 'string') return null
  if (typeof item.bytesRead !== 'number' || typeof item.totalBytes !== 'number' || typeof item.truncated !== 'boolean') return null
  return {
    relativePath: item.relativePath,
    content: item.content,
    bytesRead: item.bytesRead,
    totalBytes: item.totalBytes,
    truncated: item.truncated,
    encoding: typeof item.encoding === 'string' ? item.encoding : 'utf-8',
  }
}

export function workspaceTreeFromEntries(entries: unknown): WorkspaceTree {
  return { entries: normalizeWorkspaceEntries(entries), selectedPath: null }
}

/** workspace_error 错误码分类（§4：absolute/traversal/outside/not_found/not_readable/not_file/binary/too_many/io） */
export type WorkspaceErrorCode =
  | 'absolute' | 'traversal' | 'outside' | 'not_found' | 'not_readable' | 'not_file' | 'binary' | 'too_many' | 'io' | 'unknown'

export interface WorkspaceErrorDetail {
  code: WorkspaceErrorCode
  message: string
}

export function classifyWorkspaceError(error: unknown): WorkspaceErrorDetail {
  // Tauri invoke 拒绝值为 { code, message } 结构化对象（非 Error）——提取 message 而非 [object Object]
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error)
  const message = raw && raw !== '[object Object]' ? raw : '工作区操作失败'
  const normalized = message.toLowerCase()
  const match = /(absolute|traversal|outside|not_found|not readable|not_file|not a file|binary|too_many|too many|io error|io)/.exec(normalized)
  const code = (match?.[1].replace(/[\s_]+/g, '_') ?? 'unknown') as WorkspaceErrorCode
  return { code, message }
}
