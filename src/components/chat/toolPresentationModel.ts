import type { Message } from './messageTypes.ts'
import { normalizeToolStatus, type ToolVisualState } from './toolStatus.ts'
import { truncateToWidth } from '../../utils/textWidth.ts'

export interface ToolPresentationModel {
  toolId: string | null
  name: string
  summary: string
  inputText: string
  outputText: string
  outputLines: number
  state: ToolVisualState
  hasOutput: boolean
  canCollapseOutput: boolean
  isDiffCandidate: boolean
  statusLabel: string
  outputLabel: string
  errorText?: string
}

const COLLAPSIBLE_OUTPUT_CHAR_LIMIT = 1200
const COLLAPSIBLE_OUTPUT_LINE_LIMIT = 30

function toolIdFromMessage(message: Message): string | null {
  if (message.role !== 'tool' || !message.id.startsWith('tool-')) return null
  const toolId = message.id.slice('tool-'.length)
  return toolId || null
}

function outputLineCount(output: string): number {
  if (!output) return 0
  return output.split('\n').filter(line => line.trim().length > 0).length
}

function isDiffCandidate(name: string, output: string): boolean {
  return (name === 'Edit' || name === 'Write') && output.length > 0
}

function statusLabelFor(state: ToolVisualState): string {
  switch (state) {
    case 'queued': return '排队中'
    case 'running': return '运行中'
    case 'waiting': return '等待中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'unknown': return '状态未知'
  }
}

function outputLabelFor(name: string, outputLines: number): string {
  if (outputLines <= 0) return ''
  if (name === 'Grep' || name === 'Glob') return `${outputLines} matches`
  if (name === 'Read') return `${outputLines} lines`
  if (name === 'Edit' || name === 'Write') return `${outputLines} lines changed`
  return `${outputLines} lines`
}

/**
 * 将持久化 Message 转成 ToolCard 使用的展示模型。
 * 这里只处理当前前端已经保存的字符串 input/output，不假设原始 ACP object 仍然存在。
 */
export function buildToolPresentationModel(
  message: Message,
  visualState?: ToolVisualState,
): ToolPresentationModel {
  const name = message.toolName || message.sender.replace(/^tool:/, '') || '未知工具'
  const inputText = message.toolInput || ''
  const outputText = message.toolOutput || ''
  const outputLines = message.toolOutputLines ?? outputLineCount(outputText)
  const hasOutput = message.toolOutput !== undefined && outputText.length > 0
  const state = visualState ?? (
    message.running
      ? 'running'
      : message.toolStatus !== undefined
        ? normalizeToolStatus(message.toolStatus)
        : message.toolOutput !== undefined
          ? 'completed'
          : 'unknown'
  )
  const canCollapseOutput = hasOutput && (
    outputText.length > COLLAPSIBLE_OUTPUT_CHAR_LIMIT ||
    outputLines > COLLAPSIBLE_OUTPUT_LINE_LIMIT
  )

  return {
    toolId: toolIdFromMessage(message),
    name,
    summary: inputText,
    inputText,
    outputText,
    outputLines,
    state,
    hasOutput,
    canCollapseOutput,
    isDiffCandidate: isDiffCandidate(name, outputText),
    statusLabel: statusLabelFor(state),
    outputLabel: outputLabelFor(name, outputLines),
    errorText: state === 'failed' || state === 'cancelled' ? outputText || undefined : undefined,
  }
}

export function toolPresentationStatus(model: ToolPresentationModel): 'run' | 'ok' | 'err' {
  switch (model.state) {
    case 'failed':
    case 'cancelled':
      return 'err'
    case 'completed':
      return 'ok'
    case 'queued':
    case 'running':
    case 'waiting':
    case 'unknown':
      return 'run'
  }
}

export function truncateToolSummary(summary: string, maxLength = 60): string {
  return truncateToWidth(summary, maxLength)
}

export const TOOL_PRESENTATION_LIMITS = {
  collapsibleOutputCharLimit: COLLAPSIBLE_OUTPUT_CHAR_LIMIT,
  collapsibleOutputLineLimit: COLLAPSIBLE_OUTPUT_LINE_LIMIT,
} as const
