/**
 * status — 工具视觉状态单一真值（B2）。
 *
 * 合并 toolStatus.resolveToolVisualStatus / toolPresentationModel.toolPresentationStatus
 * + statusLabelFor / toolIndicatorAssets.ariaLabel 四张平行表。unknown 统一 hasOutput 语义。
 * 全部消费方（行管线/工具卡/连接线/指示器 aria）经此取 tone 与中文标签。
 */

export type ToolVisualState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type ToolTone = 'run' | 'ok' | 'err'

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

/** 7 态中文状态标签（单一真值：工具卡状态栏/指示器 aria 共用） */
export const TOOL_STATE_LABELS: Record<ToolVisualState, string> = {
  queued: '排队中',
  running: '运行中',
  waiting: '等待中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
}

export interface ToolPresentation {
  state: ToolVisualState
  tone: ToolTone
  label: string
}

/** 由已归一化状态派生 tone/label（unknown 分支按 hasOutput 兜底：有输出视为完成） */
export function toolStatePresentation(state: ToolVisualState, hasOutput = false): ToolPresentation {
  let tone: ToolTone
  switch (state) {
    case 'failed':
    case 'cancelled':
      tone = 'err'
      break
    case 'completed':
      tone = 'ok'
      break
    case 'queued':
    case 'running':
    case 'waiting':
      tone = 'run'
      break
    case 'unknown':
      tone = hasOutput ? 'ok' : 'run'
      break
    default:
      assertNeverToolStatus(state)
  }
  return { state, tone, label: TOOL_STATE_LABELS[state] }
}

/** 由原始状态字符串派生（归一化 + tone/label）——行管线/连接线入口 */
export function resolveToolPresentationState(rawStatus: string | undefined, hasOutput = false): ToolPresentation {
  return toolStatePresentation(normalizeToolStatus(rawStatus), hasOutput)
}
