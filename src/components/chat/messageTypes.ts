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
  toolStatus?: string
}

export type RenderMessage =
  | { type: 'user'; message: Message }
  | { type: 'assistant'; message: Message }
  | { type: 'reasoning'; message: Message }
  | { type: 'tool_call'; message: Message; toolId: string | null }
  | { type: 'tool_result'; message: Message; toolId: string | null }

export type RenderDecision =
  | { kind: 'render'; message: RenderMessage }
  | { kind: 'skip'; reason: VisibilityReason }

export type VisibilityReason = 'empty-assistant'

function toolIdFromMessage(message: Message): string | null {
  if (message.role !== 'tool' || !message.id.startsWith('tool-')) return null
  const toolId = message.id.slice('tool-'.length)
  return toolId || null
}

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
  }
}

export function renderMessageType(message: RenderMessage): RenderMessage['type'] {
  switch (message.type) {
    case 'user':
    case 'assistant':
    case 'reasoning':
    case 'tool_call':
    case 'tool_result':
      return message.type
    default:
      return assertNever(message, '未处理的 RenderMessage 类型')
  }
}
