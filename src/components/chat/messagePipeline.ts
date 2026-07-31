import { toRenderMessage, type Message, type RenderDecision, type RenderMessage } from './messageTypes'

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
  return prepareMessages(messages).filter(message => decideMessageVisibility(message).kind === 'render')
}
