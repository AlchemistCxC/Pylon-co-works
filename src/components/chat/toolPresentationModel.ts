import type { Message } from './messageTypes.ts'
import { normalizeToolStatus, toolStatePresentation, type ToolVisualState } from '../../domains/tool/status.ts'
import { toolIdFromMessage } from '../../domains/tool/id.ts'
import { truncateToWidth } from '../../utils/textWidth.ts'
import { buildToolRenderModel, type ToolKind } from '../../domains/tool/toolPresentation.ts'
import type { DiffPayload } from '../../domains/tool/diffPresentation.ts'

export interface ToolPresentationModel {
  toolId: string | null
  name: string
  /** P1-10：kind 归一后摘要（title 直通回退） */
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
  /** P1-10：语义 kind（工具卡 data-kind） */
  kind: ToolKind
  /** P1-10：contentBlocks 携带的结构化 diff（tool_diff_content） */
  diffPayload: DiffPayload | null
}

const COLLAPSIBLE_OUTPUT_CHAR_LIMIT = 1200
const COLLAPSIBLE_OUTPUT_LINE_LIMIT = 30

function outputLineCount(output: string): number {
  if (!output) return 0
  return output.split('\n').filter(line => line.trim().length > 0).length
}

/**
 * 将持久化 Message 转成 ToolCard 使用的展示模型。
 * 展示模型经 domains/tool 的 KIND_RENDERERS（kind 归一，title 直通，contentBlocks 按 type）；
 * 不假设原始 ACP object 仍然存在（input/output 为已保存字符串）。
 */
export function buildToolPresentationModel(
  message: Message,
  visualState?: ToolVisualState,
): ToolPresentationModel {
  const name = message.toolName || message.sender.replace(/^tool:/, '') || '未知工具'
  const render = buildToolRenderModel({
    name,
    toolKind: message.toolKind,
    input: message.toolInput,
    output: message.toolOutput,
    contentBlocks: message.contentBlocks,
  })
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
    name: render.name,
    summary: render.summary,
    inputText,
    outputText,
    outputLines,
    state,
    hasOutput,
    canCollapseOutput,
    isDiffCandidate: render.isDiffCandidate,
    statusLabel: toolStatePresentation(state, hasOutput).label,
    outputLabel: render.outputLabel,
    errorText: state === 'failed' || state === 'cancelled' ? outputText || undefined : undefined,
    kind: render.kind,
    diffPayload: render.diffPayload,
  }
}

export function truncateToolSummary(summary: string, maxLength = 60): string {
  return truncateToWidth(summary, maxLength)
}

export const TOOL_PRESENTATION_LIMITS = {
  collapsibleOutputCharLimit: COLLAPSIBLE_OUTPUT_CHAR_LIMIT,
  collapsibleOutputLineLimit: COLLAPSIBLE_OUTPUT_LINE_LIMIT,
} as const
