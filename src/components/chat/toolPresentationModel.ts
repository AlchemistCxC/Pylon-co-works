import type { Message } from './messageTypes.ts'
import { normalizeToolStatus, toolStatePresentation, type ToolVisualState } from '../../domains/tool/status.ts'
import { toolIdFromMessage } from '../../domains/tool/id.ts'
import { truncateToWidth } from '../../utils/textWidth.ts'
import { resolveToolRenderer } from './toolPresentation.ts'

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

function outputLineCount(output: string): number {
  if (!output) return 0
  return output.split('\n').filter(line => line.trim().length > 0).length
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
  const renderer = resolveToolRenderer(name)
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
    // 仅 renderer 定义 diff 判定（Edit/Write）；本地回退恒 false（已删死代码）
    isDiffCandidate: renderer.isDiffCandidate ? renderer.isDiffCandidate(outputText) : false,
    statusLabel: toolStatePresentation(state, hasOutput).label,
    outputLabel: renderer.outputLabel
      ? renderer.outputLabel(outputLines, outputText)
      : outputLabelFor(name, outputLines),
    errorText: state === 'failed' || state === 'cancelled' ? outputText || undefined : undefined,
  }
}

export function truncateToolSummary(summary: string, maxLength = 60): string {
  return truncateToWidth(summary, maxLength)
}

export const TOOL_PRESENTATION_LIMITS = {
  collapsibleOutputCharLimit: COLLAPSIBLE_OUTPUT_CHAR_LIMIT,
  collapsibleOutputLineLimit: COLLAPSIBLE_OUTPUT_LINE_LIMIT,
} as const
