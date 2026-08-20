import {
  EMPTY_MESSAGE_VIEWPORT_STATE,
  type MeasurementInvalidationReason,
  type MessageListAnchor,
  type MessageListItem,
  type MessageListPort,
  type MessageViewportState,
} from './messageListPort.ts'

export type FakeMessageListCall =
  | { type: 'set-items'; itemKeys: string[] }
  | { type: 'scroll-to'; anchor: MessageListAnchor }
  | { type: 'scroll-to-bottom'; behavior: ScrollBehavior }
  | { type: 'invalidate'; reason: MeasurementInvalidationReason }
  | { type: 'destroy' }

export interface FakeMessageListPort extends MessageListPort {
  readonly calls: readonly FakeMessageListCall[]
  readonly items: readonly MessageListItem[]
  setViewportState(state: MessageViewportState): void
  setAvailableMessageIds(messageIds: readonly string[]): void
}

export function createFakeMessageListPort(): FakeMessageListPort {
  const calls: FakeMessageListCall[] = []
  let items: readonly MessageListItem[] = []
  let viewportState = EMPTY_MESSAGE_VIEWPORT_STATE
  let availableMessageIds = new Set<string>()
  let destroyed = false

  return {
    get calls() { return calls },
    get items() { return items },
    setItems(nextItems) {
      if (destroyed) return
      items = [...nextItems]
      availableMessageIds = new Set(nextItems.map(item => item.descriptor.renderMessage.message.id))
      calls.push({ type: 'set-items', itemKeys: nextItems.map(item => item.key) })
    },
    async scrollTo(anchor) {
      if (destroyed) return false
      calls.push({ type: 'scroll-to', anchor: { ...anchor } })
      return availableMessageIds.has(anchor.messageId)
    },
    scrollToBottom(behavior) {
      if (destroyed) return
      calls.push({ type: 'scroll-to-bottom', behavior })
    },
    getViewportState() {
      return viewportState
    },
    invalidateMeasurements(reason) {
      if (destroyed) return
      calls.push({ type: 'invalidate', reason })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      items = []
      calls.push({ type: 'destroy' })
    },
    setViewportState(state) {
      if (destroyed) return
      viewportState = { ...state }
    },
    setAvailableMessageIds(messageIds) {
      if (destroyed) return
      availableMessageIds = new Set(messageIds)
    },
  }
}
