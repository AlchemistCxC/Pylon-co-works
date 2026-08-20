export type ToolKind = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think' | 'other'
export type ToolProvider = 'peri' | 'hermes' | 'mcp' | 'unknown'
export type ToolMatch = 'wire' | 'provider-dictionary' | 'alias-dictionary' | 'heuristic' | 'fallback'
export type ToolAction =
  | 'read'
  | 'write'
  | 'edit'
  | 'search'
  | 'execute'
  | 'fetch'
  | 'navigate'
  | 'click'
  | 'type'
  | 'snapshot'
  | 'delegate'
  | 'plan'
  | 'skill'
  | 'unknown'

export interface ToolResolution {
  kind: ToolKind
  action: ToolAction
  canonicalName: string
  rawName: string
  provider: ToolProvider
  matchedBy: ToolMatch
  /** 跨 provider 统一显示名（缺省回退 canonicalName/rawName） */
  displayName?: string
  /** 工具级摘要提取字段（覆盖 kind 默认 renderer） */
  summaryFields?: readonly string[]
  /** 工具级输出标签（覆盖 kind 默认 renderer） */
  outputLabel?: 'lines' | 'matches' | 'changed-lines'
  /** title 内嵌参数（如 "terminal: npm test" 的 "npm test"），输入为 null 时的摘要来源 */
  embeddedSummary?: string
}

export const TOOL_KINDS: readonly ToolKind[] = ['read', 'edit', 'execute', 'search', 'fetch', 'think', 'other']
