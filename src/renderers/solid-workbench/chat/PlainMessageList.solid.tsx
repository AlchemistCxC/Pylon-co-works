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
  /**
   * #213：包装层 `data-streaming` 的判据。缺省回落 `message.running`（legacy 夹具不变），
   * 生产接权威活性。
   *
   * 为什么单列一个 prop：正文行自己的 `data-streaming` 走 `MessageRow` 的 `live()`，
   * 但 CSS 里还有一条只看**包装层**属性的旁路（`.plain-message-list__row[data-streaming]`
   * 的 sweep 动画与脉冲竖条）。只改内层会让"重放出的无终态行"永久播放生成动画——
   * 正是 #213 要消灭的症状。
   */
  rowLive?: (item: MessageListItem) => boolean
}

/**
 * #212 S3b：渐进挂载窗口。
 *
 * 整发把**文本**一次给全（不再逐字铺开），但 DOM 按窗口分批出现——首帧的解析量因此从
 * "整屏行数"降到"窗口行数"（markdown 解析实测约 4.5ms/千字符，冷开长会话时整屏新行会在
 * 同一帧里全部首次解析）。窗口锚在**尾部**向上扩：贴底姿态下用户先看到最新内容、历史从
 * 上方长出来，视口不 churn——这正是别家共识「历史只渐进挂载行数，不渐进显示文本」。
 */
const MOUNT_WINDOW_INITIAL = 16
const MOUNT_WINDOW_STEP = 32

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

  // ── #212 S3b 渐进挂载窗口 ──────────────────────────────────
  // `mounted` = 从尾部算起渲染的行数（单调不减：窗内已经建好的行不重挂，避免每次追加都
  // 让整窗行重建）。整批换代（会话切换）时重置为初始值再逐帧扩。
  const [mounted, setMounted] = createSignal((props.initialItems ?? []).length)
  let mountFrame: number | undefined
  let mountExpansionTarget = 0
  const stopMountExpansion = () => {
    if (mountFrame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(mountFrame)
    mountFrame = undefined
  }
  /**
   * 逐帧扩窗（**只调度，不立即推进**——初始窗口由调用方同步建立）。
   * `total` 必须显式传入：调用点可能早于 `setRows`，读 `rows()` 会拿到旧长度。
   */
  const scheduleMountExpansion = (total: number) => {
    // 目标存进**可变变量**而不是 rAF 闭包：换代（冷开 A 的扩窗还没跑完就切到更长的 B）
    // 时必须用最新总长，否则挂起的帧会按旧会话的行数收敛，新会话头部行永远不挂载。
    mountExpansionTarget = total
    if (destroyed || mountFrame !== undefined) return
    if (untrack(mounted) >= total) return
    if (typeof requestAnimationFrame !== 'function') { setMounted(total); return }
    mountFrame = requestAnimationFrame(() => {
      mountFrame = undefined
      const target = mountExpansionTarget
      setMounted(Math.min(target, untrack(mounted) + MOUNT_WINDOW_STEP))
      scheduleMountExpansion(target)
    })
  }
  /** 行集合变化后决定窗口：整体换代重置、尾部追加不动、整批增长逐帧扩。 */
  const reconcileMountWindow = (nextItems: readonly MessageListItem[]): void => {
    const total = nextItems.length
    // 用户自己控制位置时不挂窗口——少挂几行会让他的视口对着错误的行。
    if (props.scrollPosture?.() === 'pin') { stopMountExpansion(); setMounted(total); return }
    const current = untrack(mounted)
    const renderedRows = untrack(rows)
    const firstRenderedKey = renderedRows[Math.max(0, renderedRows.length - current)]?.key
    const freshSet = firstRenderedKey !== undefined && !nextItems.some(item => item.key === firstRenderedKey)
    if (freshSet || current === 0) {
      // 整体换代（冷开/切换会话）：只先挂尾部 INITIAL 行，其余逐帧扩。
      // 此时缩小窗口是安全的——整行集都被换掉，没有哪一行的身份值得保。
      setMounted(Math.min(total, MOUNT_WINDOW_INITIAL))
      scheduleMountExpansion(total)
      return
    }
    // 同一会话内的行集变化：窗口**只增不减**（收缩会把正在显示的行卸掉再挂回）。
    // 渐进只服务"整体换代的首屏"，增量增长交给跟随/锚点（它们才有几何信息）。
    setMounted(Math.max(current, Math.min(total, MOUNT_WINDOW_INITIAL)))
    if (total > untrack(mounted)) scheduleMountExpansion(total)
  }

  /**
   * 渲染窗口：从尾部算起 `count` 行（全部挂载时返回原数组，不复制）。
   *
   * `count` 取 `max(mounted, min(len, INITIAL))`——**窗口不小于初始窗口**。这不是节省，
   * 而是身份正确性：窗口更新与行集替换是两次信号写，Solid 每次都渲染，中间那次会拿
   * "旧行集 + 新窗口"算一次可见集；若窗口能在行集缩小前先缩，正在显示的行会被卸掉再挂回，
   * DOM 身份就断了（`For` 会重建节点）。
   */
  const visibleRows = (): readonly StableMessageListRow[] => {
    const all = rows()
    const count = Math.max(mounted(), Math.min(all.length, MOUNT_WINDOW_INITIAL))
    if (count >= all.length) return all
    return all.slice(all.length - count)
  }

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
      // 先定窗口再换行集：反过来会让一次渲染用旧窗口渲染新列表，把首行卸掉又挂回来（DOM 身份断）。
      reconcileMountWindow(nextItems)
      setRows(nextRows)
      measurements.schedule('items-changed')
    },
    async scrollTo(anchor) {
      if (destroyed) return false
      await Promise.resolve()
      let node = rowElements.get(anchor.messageId)
      // #212 S3b：目标还在窗口外（搜索结果跳转）——立即全开再等一次刷新。
      if (!node) {
        stopMountExpansion()
        setMounted(untrack(rows).length)
        await Promise.resolve()
        node = rowElements.get(anchor.messageId)
      }
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
      stopMountExpansion()
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

  /**
   * 相对**滚动视口**内容原点的行顶。基准必须是真正的滚动容器（App 传进来的
   * `scrollViewport`，生产里是 `.chat-view`）——`container`（`.plain-message-list`）
   * 自己不滚动，用它做基准时 `scrollTop` 恒为 0、且容器与行会一起被上方内容平移，
   * 差量恒为 0 ⇒ 补偿变成死代码（而本组件同时关掉了原生锚定，等于完全没有锚定）。
   */
  const rowTop = (messageId: string): number | undefined => {
    const node = rowElements.get(messageId)
    const viewport = props.scrollViewport?.()
    if (!node || !viewport) return undefined
    const rect = node.getBoundingClientRect()
    return rect.top - viewport.getBoundingClientRect().top + viewport.scrollTop
  }

  const captureAnchor = () => {
    const viewport = props.scrollViewport?.()
    if (!viewport) { anchor = undefined; return }
    const scrollTop = viewport.scrollTop
    const viewportRect = viewport.getBoundingClientRect()
    let best: { messageId: string; top: number } | undefined
    for (const [messageId, node] of rowElements) {
      const rect = node.getBoundingClientRect()
      const top = rect.top - viewportRect.top + scrollTop
      const bottom = top + rect.height
      // 视口下方、且离视口顶部最近的那一行 = 用户正在读的锚。
      if (bottom <= scrollTop) continue
      if (best === undefined || top < best.top) best = { messageId, top }
    }
    anchor = best
  }

  const syncAnchorCompensation = () => {
    const viewport = props.scrollViewport?.()
    const posture = props.scrollPosture?.() ?? 'follow'
    if (posture === 'follow' || viewport === undefined) {
      anchor = undefined
      return
    }
    if (anchor === undefined) { captureAnchor(); return }
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
      <For each={visibleRows()}>{row => {
        const item = row.item
        return (
          <div
            ref={node => bindRow(item, node)}
            class="plain-message-list__row"
            data-message-id={item.descriptor.renderMessage.message.id}
            data-message-key={row.key}
            data-entry={row.entering ? 'new' : undefined}
            data-message-role={item.descriptor.renderMessage.message.role}
            data-streaming={(props.rowLive?.(item) ?? item.descriptor.renderMessage.message.running === true) ? 'true' : undefined}
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
