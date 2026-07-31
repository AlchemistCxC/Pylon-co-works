import type { ToolVisualState } from './toolStatus.ts'

export type ToolIndicatorMotion = 'static' | 'breathe' | 'pulse' | 'settle' | 'flash'

/**
 * Tool 指示器动画只描述时间表现；颜色仍由现有 ok / run / err 主题色解析。
 * completed / failed 使用一次性动画，避免历史记录持续闪烁。
 */
export function resolveToolIndicatorMotion(state: ToolVisualState): ToolIndicatorMotion {
  switch (state) {
    case 'queued':
    case 'cancelled':
    case 'unknown':
      return 'static'
    case 'running':
      return 'breathe'
    case 'waiting':
      return 'pulse'
    case 'completed':
      return 'settle'
    case 'failed':
      return 'flash'
  }
}

export function toolIndicatorMotionClass(state: ToolVisualState): string {
  return `term-tool-indicator--${resolveToolIndicatorMotion(state)}`
}

/** Connector 与其起点 Tool 同步，但只改变线本身的透明度，不触发布局重排。 */
export function toolConnectorMotionClass(state: ToolVisualState): string {
  return `term-tool-connector--${resolveToolIndicatorMotion(state)}`
}
