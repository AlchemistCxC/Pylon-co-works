export type ToolVisualStatus = 'run' | 'ok' | 'err'

export function resolveToolVisualStatus(toolStatus?: string, hasOutput = false): ToolVisualStatus {
  if (toolStatus === 'failed' || toolStatus === 'error') return 'err'
  if (toolStatus === 'completed') return 'ok'
  if (toolStatus === 'pending' || toolStatus === 'in_progress') return 'run'
  return hasOutput ? 'ok' : 'run'
}
