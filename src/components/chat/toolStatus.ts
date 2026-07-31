export type ToolVisualState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type ToolVisualStatus = 'run' | 'ok' | 'err'

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
  if (normalized === 'failed' || normalized === 'cancelled') return 'err'
  if (normalized === 'completed') return 'ok'
  if (normalized === 'queued' || normalized === 'running' || normalized === 'waiting') return 'run'
  return hasOutput ? 'ok' : 'run'
}
