import { toRenderMessage, type Message, type RenderDecision, type RenderMessage, renderDecisionKind } from './messageTypes.ts'

export function prepareMessages(messages: Message[]): RenderMessage[] {
  return messages.map(toRenderMessage)
}

export function decideMessageVisibility(message: RenderMessage): RenderDecision {
  if (message.type === 'assistant' && !message.message.content && !message.message.running) {
    return { kind: 'skip', reason: 'empty-assistant' }
  }
  return { kind: 'render', message }
}

export function prepareRenderableMessages(messages: Message[]): RenderMessage[] {
  return prepareMessages(messages).filter(message => renderDecisionKind(decideMessageVisibility(message)) === 'render')
}

/**
 * 消息静态化判定（参考 CC components/Messages.tsx::shouldRenderStatically 的保守子集）：
 * 静态消息跳过入场动画，只有可能继续变化的动态消息保留动画。
 * - running 中 → 动态
 * - tool_call（未 settle，等待 tool_call_update）→ 动态
 * - 其余（user/assistant/reasoning/tool_result/error/system）→ 静态
 */
export function isMessageStatic(renderMessage: RenderMessage): boolean {
  if (renderMessage.message.running === true) return false
  if (renderMessage.type === 'tool_call') return false
  return true
}
