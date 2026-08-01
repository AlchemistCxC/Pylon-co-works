/**
 * Workspace 数据归一化纯函数。
 *
 * 真实 Tauri 调用由 RightPanel 直接 invoke（见 RightPanel.tsx）：
 *   list_workspace_entries { source, relativePath? } → WorkspaceBackendEntry[]
 *   read_workspace_text    { source, relativePath }   → WorkspaceTextResponse
 * 本模块不包含任何 Tauri/fetch 实现；仅负责把后端响应归一化为渲染模型。
 */

import type { WorkspaceEntry, WorkspaceTextPreview, WorkspaceTree } from './rightPanelTypes'

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
