/**
 * Backend-agnostic boundary for Workspace data access.
 *
 * This module intentionally contains no Tauri, fetch, or command implementation.
 * F-14 can register a concrete adapter against this interface once the backend
 * contract is confirmed.
 */

import type { WorkspaceEntry, WorkspaceTextPreview, WorkspaceTree } from './rightPanelTypes'

/** The only session scope that crosses the Workspace adapter boundary. */
export interface WorkspaceApiScope {
  source: string
}

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

export interface WorkspaceRootRequest {
  scope: WorkspaceApiScope
}

export interface WorkspaceListRequest {
  scope: WorkspaceApiScope
  path?: string
}

export interface WorkspaceReadRequest {
  scope: WorkspaceApiScope
  path: string
}

/**
 * Backend response types remain caller-supplied. The defaults deliberately do
 * not assert any response fields before the backend contract is registered.
 */
export interface WorkspaceApiAdapter<TRoot = unknown, TList = unknown, TRead = unknown> {
  root(request: WorkspaceRootRequest): Promise<TRoot>
  list(request: WorkspaceListRequest): Promise<TList>
  read(request: WorkspaceReadRequest): Promise<TRead>
}

export type WorkspaceRootResult<TAdapter extends WorkspaceApiAdapter> = Awaited<ReturnType<TAdapter['root']>>
export type WorkspaceListResult<TAdapter extends WorkspaceApiAdapter> = Awaited<ReturnType<TAdapter['list']>>
export type WorkspaceReadResult<TAdapter extends WorkspaceApiAdapter> = Awaited<ReturnType<TAdapter['read']>>
