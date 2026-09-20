import { For, createSignal, onCleanup, onMount, untrack, type JSX } from 'solid-js'
import type {
  MeasurementInvalidationReason,
  MessageListAnchor,
  MessageListItem,
  MessageListPort,
} from '../../../domains/workbench/messageListPort.ts'
import { selectMessageViewportState } from '../../../domains/workbench/messageViewportState.ts'
import { createFrameTask } from '../frameTask.ts'

/** #212 S4：小于该像素的差量视为无变化（避免亚像素抖动的写入循环）。 */
const ANCHOR_EPSILON_PX = 1

export interface PlainMessageListProps {
  initialItems?: readonly MessageListItem[]
  renderItem: (item: MessageListItem) => JSX.Element
  onPortReady?: (port: MessageListPort) => void
  onContentResize?: () => void
  /**
   * #212 S4：滚动视口（补偿的写入目标）。不传即不做锚点补偿（原生锚定行为）。
   */
  scrollViewport?: () => HTMLElement | undefined
  /**
   * #212 S4：滚动姿态。`'follow'` = 贴底跟随（由上层把它钉在底部，本组件不补偿）；
   * `'pin'` = 用户自己控制位置——上方内容的高度变化必须补偿，否则用户正在读的行会被挤走。
   */
  scrollPosture?: () => 'follow' | 'pin'
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
        syncAnchorCompensation()
        props.onContentResize?.()
      })
      resizeObserver.observe(container)
      for (const node of rowElements.values()) resizeObserver.observe(node)
    }
    props.onPortReady?.(port)
  })

  // ── #212 S4 自管锚点 ────────────────────────────────────────
  // 上层已显式关闭原生锚定（`overflow-anchor: none`，见 ChatView.css），因此用户自己控制
  // 位置时（`'pin'`），视口上方任何高度变化都必须由我们补回：
  // 记下视口顶部那一行的**文档空间偏移**，变化后把 scrollTop 调整同样的差量。
  // 贴底跟随（`'follow'`）时不做补偿——那一姿态下"内容长了就跟到底"才是意图。
  let anchor: { messageId: string; top: number } | undefined

  /** 相对容器内容原点的行顶（与 getViewportState 同一口径）。 */
  const rowTop = (messageId: string): number | undefined => {
    const node = rowElements.get(messageId)
    if (!node || !container) return undefined
    const rect = node.getBoundingClientRect()
    return rect.top - container.getBoundingClientRect().top + container.scrollTop
  }

  const captureAnchor = () => {
    if (!container) { anchor = undefined; return }
    const scrollTop = container.scrollTop
    let best: { messageId: string; top: number } | undefined
    for (const [messageId, node] of rowElements) {
      const rect = node.getBoundingClientRect()
      const top = rect.top - container.getBoundingClientRect().top + scrollTop
      const bottom = top + rect.height
      if (bottom <= scrollTop) continue
      if (best === undefined || top < best.top) best = { messageId, top }
    }
    anchor = best
  }

  const syncAnchorCompensation = () => {
    const posture = props.scrollPosture?.() ?? 'follow'
    if (posture === 'follow' || props.scrollViewport === undefined) {
      anchor = undefined
      return
    }
    if (anchor === undefined) { captureAnchor(); return }
    const viewport = props.scrollViewport()
    if (!viewport) { anchor = undefined; return }
    const top = rowTop(anchor.messageId)
    if (top === undefined) { anchor = undefined; return }
    const delta = top - anchor.top
    if (Math.abs(delta) < ANCHOR_EPSILON_PX) return
    viewport.scrollTop = Math.max(0, viewport.scrollTop + delta)
    anchor = { messageId: anchor.messageId, top }
  }

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
