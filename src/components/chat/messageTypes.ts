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
  | { type: 'tool'; message: Message }

export type RenderDecision =
  | { kind: 'render'; message: RenderMessage }
  | { kind: 'skip'; reason: string }

export function toRenderMessage(message: Message): RenderMessage {
  switch (message.role) {
    case 'user':
      return { type: 'user', message }
    case 'assistant':
      return { type: 'assistant', message }
    case 'reasoning':
      return { type: 'reasoning', message }
    case 'tool':
      return { type: 'tool', message }
  }
}
