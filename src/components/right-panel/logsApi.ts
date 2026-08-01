import type { LogEntry } from './rightPanelTypes'

/**
 * 日志数据归一化纯函数。
 *
 * 真实 Tauri 调用由 RightPanel 直接 invoke（见 RightPanel.tsx）：
 *   list_runtime_logs { query: { session: source } } → RuntimeLogResponse[]
 * 本模块不包含任何 Tauri/fetch 实现；仅负责把后端响应归一化为渲染模型。
 */

export interface RuntimeLogResponse {
  id: number | string
  timestamp: string
  level: string
  source: string
  message: string
}

export function normalizeRuntimeLogs(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): LogEntry[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Partial<RuntimeLogResponse>
    if (item.id === undefined || typeof item.timestamp !== 'string' || typeof item.source !== 'string' || typeof item.message !== 'string') return []
    const level = item.level === 'debug' || item.level === 'info' || item.level === 'warn' || item.level === 'error'
      ? item.level
      : 'info'
    return [{
      id: String(item.id),
      time: item.timestamp,
      level,
      source: item.source,
      message: item.message,
    }]
  })
}
