/**
 * chatRowPipeline — 消息列表渲染编排（纯函数模块）。
 *
 * 把 preparedMessages + messageLookups 转成每行的渲染描述符
 * （key / 工具视觉状态 / 连续 Tool 连接线 / 搜索命中），ChatView 只消费描述符渲染 JSX。
 * 编排逻辑从 ChatView 抽出后可以独立测试（scripts/test-chat-row-pipeline.mts），
 * 输入不变输出不变——渲染行为由测试锁定，拆分不会影响业务。
 */

import type { Message, RenderMessage } from './messageTypes.ts'
import type { MessageLookups } from './messageLookups.ts'
import { normalizeToolStatus, resolveToolPresentationState } from '../../domains/tool/status.ts'

export interface ChatRowDescriptor {
  /** 稳定 key：行与连接线共享（React key 语义不变） */
  key: string
  renderMessage: RenderMessage
  /** 当前行的工具视觉状态（动画兼容真实 tool-* id 与浏览器 mock id） */
  toolVisualState?: string
  /** 前一行也是 Tool 时渲染连接线 */
  showConnector: boolean
  /** 连接线状态取上一个 Tool 的解析结果（follow 色用） */
  connectorStatus?: 'ok' | 'err' | 'run'
  connectorVisualState?: string
  isSearchMatch: boolean
}

export function isToolRenderMessage(renderMessage: RenderMessage | undefined): renderMessage is RenderMessage {
  return renderMessage?.type === 'tool_call' || renderMessage?.type === 'tool_result'
}

export function resolveRowToolVisualState(message: Message | undefined, lookups: MessageLookups): string | undefined {
  if (!message || message.role !== 'tool') return undefined
  if (message.id.startsWith('tool-')) {
    const toolId = message.id.slice('tool-'.length)
    if (lookups.failedToolIds.has(toolId)) return 'failed'
    if (lookups.runningToolIds.has(toolId)) return 'running'
    if (lookups.resolvedToolIds.has(toolId)) return 'completed'
  }
  if (message.running === true) return 'running'
  return normalizeToolStatus(message.toolStatus)
}

export function resolveRowToolConnectorStatus(message: Message | undefined): 'ok' | 'err' | 'run' {
  if (!message || message.role !== 'tool') return 'run'
  return resolveToolPresentationState(message.toolStatus, message.toolOutput !== undefined).tone
}

/**
 * 生成行描述符列表。纯函数：输入（消息列表 + lookups + 搜索命中 id）不变则输出不变。
 * 连接线从上一个连续 Tool 延伸，因此 follow 色也取上一个 Tool 的状态。
 */
export function buildChatRowDescriptors(
  preparedMessages: RenderMessage[],
  messageLookups: MessageLookups,
  searchMatchId: string | undefined,
): ChatRowDescriptor[] {
  return preparedMessages.map((renderMessage, index) => {
    const previous = preparedMessages[index - 1]
    const isToolRow = isToolRenderMessage(renderMessage)
    const hasPreviousTool = isToolRow && isToolRenderMessage(previous)
    const currentVisualState = resolveRowToolVisualState(renderMessage.message, messageLookups)
    const previousConnectorStatus = hasPreviousTool
      ? resolveRowToolConnectorStatus(previous.message)
      : undefined
    const previousConnectorVisualState = hasPreviousTool
      ? resolveRowToolVisualState(previous.message, messageLookups)
      : undefined
    return {
      key: renderMessage.message.id,
      renderMessage,
      toolVisualState: currentVisualState,
      showConnector: hasPreviousTool,
      connectorStatus: previousConnectorStatus,
      connectorVisualState: previousConnectorVisualState,
      isSearchMatch: searchMatchId === renderMessage.message.id,
    }
  })
}
