import { For, createSignal, onCleanup, onMount, untrack, type JSX } from 'solid-js'
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
  onContentResize?: () => void
}

export function PlainMessageList(props: PlainMessageListProps) {
  const [items, setItems] = createSignal<readonly MessageListItem[]>(props.initialItems ?? [])
  const [rows, setRows] = createSignal<readonly StableMessageListRow[]>(
    (props.initialItems ?? []).map(createStableMessageListRow),
  )
  const rowElements = new Map<string, HTMLElement>()
  let container: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let bottomAnchor: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let destroyed = false
  let resizeObserver: ResizeObserver | undefined

  const port: MessageListPort = {
    setItems(nextItems) {
      if (destroyed) return
      const previousRows = new Map(untrack(rows).map(row => [row.key, row]))
      const nextRows = nextItems.map(item => {
        const existing = previousRows.get(item.key)
        if (!existing) return createStableMessageListRow(item)
        existing.update(item)
        return existing
      })
      setItems([...nextItems])
      setRows(nextRows)
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
      setRows([])
      container?.replaceChildren()
    },
  }

  onMount(() => {
    if (typeof ResizeObserver !== 'undefined' && container) {
      resizeObserver = new ResizeObserver(() => {
        port.invalidateMeasurements('container-resized')
        props.onContentResize?.()
      })
      resizeObserver.observe(container)
      for (const node of rowElements.values()) resizeObserver.observe(node)
    }
    props.onPortReady?.(port)
  })

  onCleanup(() => port.destroy())

  const bindRow = (item: MessageListItem, node: HTMLElement) => {
    const messageId = item.descriptor.renderMessage.message.id
    rowElements.set(messageId, node)
    resizeObserver?.observe(node)
    onCleanup(() => {
      resizeObserver?.unobserve(node)
      if (rowElements.get(messageId) === node) rowElements.delete(messageId)
    })
  }

  return (
    <div
      ref={container}
      class="plain-message-list"
      data-message-list="plain"
      data-measurement-revision="0"
    >
      <For each={rows()}>{row => {
        const item = row.item
        return (
          <div
            ref={node => bindRow(item, node)}
            class="plain-message-list__row"
            data-message-id={item.descriptor.renderMessage.message.id}
            data-message-key={row.key}
          >
            {props.renderItem(item)}
          </div>
        )
      }}</For>
      <div ref={bottomAnchor} class="plain-message-list__bottom" aria-hidden="true" />
    </div>
  )
}

interface StableMessageListRow {
  readonly key: string
  readonly item: MessageListItem
  update(item: MessageListItem): void
}

function createStableMessageListRow(initialItem: MessageListItem): StableMessageListRow {
  const [current, setCurrent] = createSignal(initialItem)
  const item: MessageListItem = {
    get key() { return current().key },
    get descriptor() { return current().descriptor },
    get estimatedHeight() { return current().estimatedHeight },
  }
  return {
    key: initialItem.key,
    item,
    update: setCurrent,
  }
}

export function resolveMessageScrollIntoViewOptions(anchor: MessageListAnchor): ScrollIntoViewOptions {
  return { block: anchor.align }
}
