import { For, createSignal, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import type {
  MeasurementInvalidationReason,
  MessageListAnchor,
  MessageListItem,
  MessageListPort,
} from '../../../domains/workbench/messageListPort.ts'
import { selectMessageViewportState } from '../../../domains/workbench/messageViewportState.ts'
import { createFrameTask } from '../frameTask.ts'

export interface PlainMessageListProps {
  initialItems?: readonly MessageListItem[]
  renderItem: (item: MessageListItem) => JSX.Element
  onPortReady?: (port: MessageListPort) => void
  onContentResize?: () => void
}

export function PlainMessageList(props: PlainMessageListProps) {
  const [items, setItems] = createSignal<readonly MessageListItem[]>(props.initialItems ?? [])
  const [rows, setRows] = createSignal<readonly StableMessageListRow[]>(
    (props.initialItems ?? []).map(item => createStableMessageListRow(item)),
  )
  // Keep the initial history quiet. Rows created by a later projection are
  // marked once so CSS can animate the actual send/append boundary without
  // replaying the whole transcript on mount.
  const seenKeys = new Set((props.initialItems ?? []).map(item => item.key))
  const rowElements = new Map<string, HTMLElement>()
  let container: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let bottomAnchor: HTMLDivElement | undefined // Solid ref 会在 mount 时赋值
  let destroyed = false
  let resizeObserver: ResizeObserver | undefined
  const measurements = createFrameTask((reason: MeasurementInvalidationReason) => port.invalidateMeasurements(reason))

  const port: MessageListPort = {
    setItems(nextItems) {
      if (destroyed || nextItems === untrack(items)) return
      const previousRows = untrack(rows)
      // Streaming updates usually keep every key in place. Build a lookup only
      // when reconciliation encounters an insertion, removal or reorder.
      let previousRowsByKey: Map<string, StableMessageListRow> | undefined
      let changed = false
      const nextRows = nextItems.map((item, index) => {
        const existing = previousRows[index]?.key === item.key ? previousRows[index]
          : (previousRowsByKey ??= new Map(previousRows.map(row => [row.key, row]))).get(item.key)
        if (!existing) {
          changed = true
          const entering = !seenKeys.has(item.key)
          seenKeys.add(item.key)
          return createStableMessageListRow(item, entering)
        }
        // 顺序/裁剪也是结构变化；同 key 且同序才允许沿用既有行。
        if (index >= previousRows.length || previousRows[index].key !== item.key) changed = true
        // P57 S2-R3：引用相等门——当前 item 与行已应用的 item 全等时跳过 signal 写入，
        // 零成本通过（上层 items memo 的 per-key 复用保证未变化行引用稳定）。
        if (!existing.isCurrent(item)) {
          existing.update(item)
          changed = true
        }
        return existing
      })
      if (!changed && nextItems.length === previousRows.length) return
      setItems(nextItems)
      setRows(nextRows)
      measurements.schedule('items-changed')
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
      measurements.dispose()
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
            data-entry={row.entering ? 'new' : undefined}
            data-message-role={item.descriptor.renderMessage.message.role}
            data-streaming={item.descriptor.renderMessage.message.running === true ? 'true' : undefined}
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
  readonly entering: boolean
  update(item: MessageListItem): void
  /** P57 S2-R3：当前已应用的 item 引用，供引用相等门跳过冗余 update。 */
  isCurrent(item: MessageListItem): boolean
}

function createStableMessageListRow(initialItem: MessageListItem, entering = false): StableMessageListRow {
  const [current, setCurrent] = createSignal(initialItem)
  let appliedItem = initialItem
  const item: MessageListItem = {
    get key() { return current().key },
    get descriptor() { return current().descriptor },
    get estimatedHeight() { return current().estimatedHeight },
  }
  return {
    key: initialItem.key,
    item,
    entering,
    update(next) {
      appliedItem = next
      setCurrent(next)
    },
    isCurrent: next => appliedItem === next,
  }
}

export function resolveMessageScrollIntoViewOptions(anchor: MessageListAnchor): ScrollIntoViewOptions {
  return { block: anchor.align }
}
