/**
 * workspaceSearchContracts — 工作区搜索契约（W2-06）。
 *
 * workspace_search 已由后端提供并注册（workspace_cmds.rs / lib.rs invoke_handler）：
 * wire camelCase {path, line, lineText}（pylon-foundations workspace.rs，path 相对
 * root、`/` 分隔），normalize 按该形状宽容收窄。命令不可用（旧版二进制，invoke 报
 * not found）→ blocked 阻塞态；其余错误 → error 透传消息。
 */

export interface WorkspaceSearchResult {
  path: string
  line: number
  lineText: string
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function normalizeWorkspaceSearchResults(raw: unknown): WorkspaceSearchResult[] {
  if (!Array.isArray(raw)) return []
  const results: WorkspaceSearchResult[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    // 后端 wire 形状：path/line/lineText（camelCase，pylon-foundations workspace.rs）
    const path = typeof item.path === 'string' && item.path.length > 0 ? item.path : undefined
    const lineText = typeof item.lineText === 'string' ? item.lineText : typeof item.text === 'string' ? item.text : ''
    if (!path) continue
    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? item.line : 1
    results.push({ path, line, lineText })
  }
  return results
}

export type WorkspaceSearchSaveStatus =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string }

/** invoke 错误分类：命令不存在（旧版二进制）→ blocked；其余 → error */
export function classifyWorkspaceSearchError(error: unknown): Exclude<WorkspaceSearchSaveStatus, { kind: 'idle' } | { kind: 'searching' }> {
  const message = error instanceof Error ? error.message : String(error)
  if (/not ?found|不存在|unknown command|unrecognized|no such command/i.test(message)) {
    return { kind: 'blocked' }
  }
  return { kind: 'error', message: message && message !== '[object Object]' ? message : '搜索失败' }
}
