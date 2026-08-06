/**
 * workspaceSearchContracts — 工作区搜索契约（W2-06 桩化）。
 *
 * workspace_search 待产品侧后端命令（后端 DTO 未定——contract 以实际返回为准再施工）。
 * 桩化先行：前端只消费正式命令（不以前端遍历文件冒充搜索），命令不可用 → 明确「待后端」
 * 阻塞态；宽松 normalize 假设形状（path/line/lineText），后端契约到位后对齐字段名。
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
    // 桩形状：path/line/lineText（后端契约到位后对齐）
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

/** invoke 错误分类：命令不存在 → blocked（待后端）；其余 → error */
export function classifyWorkspaceSearchError(error: unknown): Exclude<WorkspaceSearchSaveStatus, { kind: 'idle' } | { kind: 'searching' }> {
  const message = error instanceof Error ? error.message : String(error)
  if (/not ?found|不存在|unknown command|unrecognized|no such command/i.test(message)) {
    return { kind: 'blocked' }
  }
  return { kind: 'error', message: message && message !== '[object Object]' ? message : '搜索失败' }
}
