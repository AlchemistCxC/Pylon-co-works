import { For, createSignal, onCleanup, onMount, type JSX } from 'solid-js'
import type {
  MeasurementInvalidationReason,
  MessageListAnchor,
  MessageListItem,
  MessageListPort,
} from '../../../domains/workbench/messageListPort.ts'
import { selectMessageViewportState } from '../../../domains/workbench/messageViewportState.ts'

export interface PlainMessageListProps {
  initialItems?: readonly MessageListItem[]
  renderItem: (item: MessageListItem) => JSX.Element
  onPortReady?: (port: MessageListPort) => void
}

export function PlainMessageList(props: PlainMessageListProps) {
  const [items, setItems] = createSignal<readonly MessageListItem[]>(props.initialItems ?? [])
  const rowElements = new Map<string, HTMLElement>()
  let container: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let bottomAnchor: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let destroyed = false
  let resizeObserver: ResizeObserver | undefined

  const port: MessageListPort = {
    setItems(nextItems) {
      if (destroyed) return
      setItems([...nextItems])
      queueMicrotask(() => port.invalidateMeasurements('items-changed'))
    },
    async scrollTo(anchor) {
      if (destroyed) return false
      await Promise.resolve()
      const node = rowElements.get(anchor.messageId)
      if (!node) return false
      node.scrollIntoView(resolveMessageScrollIntoViewOptions(anchor))
      return true
    },
    scrollToBottom(behavior) {
      if (destroyed) return
      bottomAnchor?.scrollIntoView({ behavior, block: 'end' })
    },
    getViewportState() {
      if (!container || destroyed) {
        return selectMessageViewportState({ scrollTop: 0, scrollHeight: 0, clientHeight: 0, rows: [] })
      }
      const containerRect = container.getBoundingClientRect()
      return selectMessageViewportState({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        rows: items().flatMap(item => {
          const node = rowElements.get(item.descriptor.renderMessage.message.id)
          if (!node) return []
          const rect = node.getBoundingClientRect()
          const top = rect.top - containerRect.top + container.scrollTop
          return [{
            messageId: item.descriptor.renderMessage.message.id,
            top,
            bottom: top + rect.height,
          }]
        }),
      })
    },
    invalidateMeasurements(reason: MeasurementInvalidationReason) {
      if (!container || destroyed) return
      container.dataset.measurementRevision = String(Number(container.dataset.measurementRevision || 0) + 1)
      container.dataset.measurementReason = reason
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      resizeObserver?.disconnect()
      resizeObserver = undefined
      rowElements.clear()
      setItems([])
      container?.replaceChildren()
    },
  }

  onMount(() => {
    if (typeof ResizeObserver !== 'undefined' && container) {
      resizeObserver = new ResizeObserver(() => port.invalidateMeasurements('container-resized'))
      resizeObserver.observe(container)
    }
    props.onPortReady?.(port)
  })

  onCleanup(() => port.destroy())

  const bindRow = (messageId: string, node: HTMLElement) => {
    rowElements.set(messageId, node)
    onCleanup(() => rowElements.delete(messageId))
  }

  return (
    <div
      ref={container}
      class="plain-message-list"
      data-message-list="plain"
      data-measurement-revision="0"
    >
      <For each={items()}>{item => {
        const messageId = item.descriptor.renderMessage.message.id
        return (
          <div
            ref={node => bindRow(messageId, node)}
            class="plain-message-list__row"
            data-message-id={messageId}
            data-message-key={item.key}
          >
            {props.renderItem(item)}
          </div>
        )
      }}</For>
      <div ref={bottomAnchor} class="plain-message-list__bottom" aria-hidden="true" />
    </div>
  )
}

export function resolveMessageScrollIntoViewOptions(anchor: MessageListAnchor): ScrollIntoViewOptions {
  return { block: anchor.align }
}
