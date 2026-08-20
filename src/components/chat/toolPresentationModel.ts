import type { Message } from './messageTypes.ts'
import type { ContentBlock } from '../../infrastructure/acp/chatContracts.ts'
import { normalizeToolStatus, toolStatePresentation, type ToolVisualState } from '../../domains/tool/status.ts'
import { toolIdFromMessage } from '../../domains/tool/id.ts'
import { truncateToWidth } from '../../utils/textWidth.ts'
import { buildToolRenderModel, type ToolAction, type ToolKind, type ToolResolution } from '../../domains/tool/toolPresentation.ts'
import type { DiffPayload } from '../../domains/tool/diffPresentation.ts'
import { getAgentInstance } from '../../domains/agent/agentRegistry.ts'

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
  /** 统一动作（不同 Agent 的同类工具共享） */
  action: ToolAction
  /** 归一化证据，供 trace/调试使用 */
  resolution: ToolResolution
  /** P0-2：owner AgentContext 的 agentId（trace/调试用；旧消息缺省） */
  agentId?: string
  /** P1-10：contentBlocks 携带的结构化 diff（tool_diff_content） */
  diffPayload: DiffPayload | null
}

const COLLAPSIBLE_OUTPUT_CHAR_LIMIT = 1200
const COLLAPSIBLE_OUTPUT_LINE_LIMIT = 30

function collectToolOutput(output: string | undefined, blocks: readonly ContentBlock[] | undefined): string {
  const collected: string[] = []
  for (const block of blocks ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      collected.push(block.text)
    } else if (block.type === 'tool_diff_content') {
      // diff 块没有 text 字段，但仍是可展开输出；收集 title/old/new 供文本回退，
      // 结构化渲染仍走 render.diffPayload（DiffCard payload）。
      const diffText = [block.title, block.oldText, block.newText]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join('\n')
      if (diffText) collected.push(diffText)
    }
  }
  return output || collected.join('\n')
}

function outputLineCount(output: string): number {
  if (!output) return 0
  return output.split('\n').filter(line => line.trim().length > 0).length
}

/**
 * 工具标题与摘要去重：部分 Agent 的 title 本身已经带上参数（如 "Read a.txt"、
 * "Bash(npm run build)"），而 summary 也解析出同一参数，导致卡片显示成
 * "工具名 参数（参数）"。这里仅在摘要作为标题边界内片段出现时把标题恢复为纯工具名，
 * 渲染层仍然保持 "工具名（参数）"。
 */
function splitToolNameAndSummary(name: string, summary: string): { name: string; summary: string } {
  const rawName = (name || '').trim()
  const rawSummary = (summary || '').trim()
  if (!rawName || !rawSummary) return { name: rawName, summary: rawSummary }
  if (rawName === rawSummary) return { name: rawName, summary: '' }
  const index = rawName.indexOf(rawSummary)
  if (index <= 0) return { name: rawName, summary: rawSummary }
  const suffix = rawName.slice(index + rawSummary.length)
  const before = rawName[index - 1]
  const boundaryBefore = /[\s(（:：,，'"“”‘’-]/.test(before)
  const boundaryAfter = /^[\s)）:：,，'"“”‘’-]*$/.test(suffix)
  if (!boundaryBefore || !boundaryAfter) return { name: rawName, summary: rawSummary }
  const cleaned = rawName.slice(0, index).replace(/[\s(（:：,，'"“”‘’-]*$/, '')
  return { name: cleaned || rawName, summary: rawSummary }
}

/**
 * 将持久化 Message 转成 ToolCard 使用的展示模型。
 * 展示模型经 v2 Tool Renderer Registry（kind 归一，title 直通，contentBlocks 按 type）；
 * 不假设原始 ACP object 仍然存在（input/output 为已保存字符串）。
 */
export function buildToolPresentationModel(
  message: Message,
  visualState?: ToolVisualState,
): ToolPresentationModel {
  const name = message.toolName || message.sender.replace(/^tool:/, '') || '未知工具'
  // P0-2：owner agent 经 instance registry 解析 provider；无 agentId/实例缺失时
  // 回退名称解析（旧消息/已删 agent），不阻塞渲染。
  const provider = message.agentId ? getAgentInstance(message.agentId)?.provider : undefined
  const render = buildToolRenderModel({
    name,
    toolKind: message.toolKind,
    agentId: message.agentId,
    provider,
    input: message.toolInput,
    output: message.toolOutput,
    contentBlocks: message.contentBlocks,
  })
  const inputText = message.toolInput || ''
  const outputText = collectToolOutput(message.toolOutput, message.contentBlocks)
  const outputLines = message.toolOutputLines ?? outputLineCount(outputText)
  const hasOutput = outputText.length > 0 || render.hasDiffContentBlock
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
  const display = splitToolNameAndSummary(render.name, render.summary)

  return {
    toolId: toolIdFromMessage(message),
    name: display.name,
    summary: display.summary,
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
    action: render.action,
    resolution: render.resolution,
    agentId: render.agentId,
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
