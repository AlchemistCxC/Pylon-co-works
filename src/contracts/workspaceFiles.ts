/**
 * workspaceFiles — 文件树/文本预览契约（结构审查 B-3/B-2 收敛件）。
 *
 * 原 shapes 分别住在 components/right-panel/rightPanelTypes.ts（视图）与
 * plugin-runtime/file-workbench/fileViewContracts.ts（本地副本）；契约上收后
 * infrastructure/tauri/workspaceContracts、plugin-runtime、视图共用同一份。
 */

export interface WorkspaceEntry {
  path: string
  label: string
  kind: 'file' | 'folder'
  expandable?: boolean
  entries?: readonly WorkspaceEntry[]
}

export interface WorkspaceTextPreview {
  relativePath: string
  content: string
  bytesRead: number
  totalBytes: number
  truncated: boolean
  encoding: string
}

export interface WorkspaceTree {
  entries: readonly WorkspaceEntry[]
  selectedPath: string | null
}
