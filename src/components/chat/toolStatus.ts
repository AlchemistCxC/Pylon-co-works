export type ToolVisualState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type ToolVisualStatus = 'run' | 'ok' | 'err'

export function assertNeverToolStatus(value: never): never {
  throw new Error(`未处理的工具状态: ${String(value)}`)
}

export function normalizeToolStatus(toolStatus?: string): ToolVisualState {
  switch (toolStatus) {
    case 'pending':
    case 'queued':
      return 'queued'
    case 'in_progress':
    case 'running':
      return 'running'
    case 'waiting':
      return 'waiting'
    case 'completed':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case undefined:
      return 'unknown'
    default:
      return 'unknown'
  }
}

export function resolveToolVisualStatus(toolStatus?: string, hasOutput = false): ToolVisualStatus {
  const normalized = normalizeToolStatus(toolStatus)
  switch (normalized) {
    case 'failed':
    case 'cancelled':
      return 'err'
    case 'completed':
      return 'ok'
    case 'queued':
    case 'running':
    case 'waiting':
      return 'run'
    case 'unknown':
      return hasOutput ? 'ok' : 'run'
    default:
      return assertNeverToolStatus(normalized)
  }
}
