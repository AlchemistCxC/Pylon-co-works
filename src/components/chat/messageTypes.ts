import { toolIdFromMessage } from '../../domains/tool/id.ts'
import type { ContentBlock } from '../../infrastructure/acp/chatContracts.ts'

export function assertNever(value: never, context = '未处理的消息状态'): never {
  throw new Error(`${context}: ${String(value)}`)
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'reasoning'
  sender: string
  content: string
  time: string
  toolName?: string
  toolInput?: string
  toolOutput?: string
  toolOutputLines?: number
  running?: boolean
  thoughtStartedAt?: number
  thoughtDurationMs?: number
  toolStatus?: string
  /** P1-04：语义工具 kind（协议化渲染主键；旧消息无此字段 → 渲染回退按名字，向后兼容） */
  toolKind?: string
  /** P1-04：结构化内容块（含 tool_diff_content；raw 保留，消费方式后变） */
  contentBlocks?: ContentBlock[]
}

export type RenderMessage =
  | { type: 'user'; message: Message }
  | { type: 'assistant'; message: Message }
  | { type: 'reasoning'; message: Message }
  | { type: 'tool_call'; message: Message; toolId: string | null }
  | { type: 'tool_result'; message: Message; toolId: string | null }
  | { type: 'error'; message: Message }
  | { type: 'system'; message: Message; reason: 'unknown-role' }

export type RenderDecision =
  | { kind: 'render'; message: RenderMessage }
  | { kind: 'skip'; reason: VisibilityReason }

export type VisibilityReason = 'empty-assistant'

export function renderDecisionKind(decision: RenderDecision): RenderDecision['kind'] {
  switch (decision.kind) {
    case 'render':
    case 'skip':
      return decision.kind
    default:
      return assertNever(decision, '未处理的渲染决策')
  }
}

export function toRenderMessage(message: Message): RenderMessage {
  if (message.sender === 'system' && message.role === 'assistant') {
    return { type: 'error', message }
  }

  switch (message.role) {
    case 'user':
      return { type: 'user', message }
    case 'assistant':
      return { type: 'assistant', message }
    case 'reasoning':
      return { type: 'reasoning', message }
    case 'tool':
      return message.toolOutput !== undefined
        ? { type: 'tool_result', message, toolId: toolIdFromMessage(message) }
        : { type: 'tool_call', message, toolId: toolIdFromMessage(message) }
    default:
      return { type: 'system', reason: 'unknown-role', message }
  }
}
