import type { LogEntry } from './rightPanelTypes'

/** Backend-agnostic boundary for Logs data access. */
export interface LogsApiScope {
  sessionId: string
  source: string
}

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

export interface LogsListQuery {
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  source?: string
  session?: string
  search?: string
  limit?: number
}

export interface LogsListRequest {
  query?: LogsListQuery
}

export interface LogsClearRequest {}

export interface LogsApiAdapter<TList = unknown, TClear = unknown> {
  list(request: LogsListRequest): Promise<TList>
  clear(request: LogsClearRequest): Promise<TClear>
}

export type LogsListResult<TAdapter extends LogsApiAdapter> = Awaited<ReturnType<TAdapter['list']>>
export type LogsClearResult<TAdapter extends LogsApiAdapter> = Awaited<ReturnType<TAdapter['clear']>>
