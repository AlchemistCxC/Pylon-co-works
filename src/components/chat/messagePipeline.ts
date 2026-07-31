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
