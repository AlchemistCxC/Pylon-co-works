import type { ChatRowDescriptor } from '../../components/chat/chatRowPipeline.ts'

export interface MessageListItem {
  key: string
  descriptor: ChatRowDescriptor
  estimatedHeight?: number
}

export interface MessageListAnchor {
  messageId: string
  align: 'start' | 'center' | 'end' | 'nearest'
}

export interface MessageViewportState {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
  atBottom: boolean
  firstVisibleMessageId: string | null
  lastVisibleMessageId: string | null
}

export type MeasurementInvalidationReason =
  | 'items-changed'
  | 'theme-changed'
  | 'font-changed'
  | 'container-resized'
  | 'manual'

export interface MessageListPort {
  setItems(items: readonly MessageListItem[]): void
  scrollTo(anchor: MessageListAnchor): Promise<boolean>
  scrollToBottom(behavior: ScrollBehavior): void
  getViewportState(): MessageViewportState
  invalidateMeasurements(reason: MeasurementInvalidationReason): void
  destroy(): void
}

export const EMPTY_MESSAGE_VIEWPORT_STATE: MessageViewportState = Object.freeze({
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  distanceFromBottom: 0,
  atBottom: true,
  firstVisibleMessageId: null,
  lastVisibleMessageId: null,
})

export function createMessageListItems(descriptors: readonly ChatRowDescriptor[]): MessageListItem[] {
  return descriptors.map(descriptor => ({
    key: descriptor.key,
    descriptor,
  }))
}
