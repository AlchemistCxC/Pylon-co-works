export type RuntimeIndicatorState = 'ready' | 'running' | 'offline'

export interface RuntimeIndicatorInput {
  generating: boolean
  prismOn: boolean
}

export interface RuntimeIndicatorResult {
  state: RuntimeIndicatorState
  label: string
  colorToken: 'ok' | 'run' | 'dim'
}

export function resolveRuntimeIndicator({ generating, prismOn }: RuntimeIndicatorInput): RuntimeIndicatorResult {
  if (!prismOn) return { state: 'offline', label: '离线', colorToken: 'dim' }
  if (generating) return { state: 'running', label: '运行中', colorToken: 'run' }
  return { state: 'ready', label: '就绪', colorToken: 'ok' }
}
