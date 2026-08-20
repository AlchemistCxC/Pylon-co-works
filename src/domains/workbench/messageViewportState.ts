import type { MessageViewportState } from './messageListPort.ts'

export const MESSAGE_LIST_BOTTOM_THRESHOLD_PX = 48

export interface MessageRowGeometry {
  messageId: string
  top: number
  bottom: number
}

export interface MessageViewportMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  rows: readonly MessageRowGeometry[]
}

export function selectMessageViewportState(metrics: MessageViewportMetrics): MessageViewportState {
  const scrollTop = finiteOrZero(metrics.scrollTop)
  const scrollHeight = Math.max(0, finiteOrZero(metrics.scrollHeight))
  const clientHeight = Math.max(0, finiteOrZero(metrics.clientHeight))
  const viewportBottom = scrollTop + clientHeight
  const distanceFromBottom = Math.max(0, scrollHeight - viewportBottom)
  const visibleRows = metrics.rows.filter(row => row.bottom > scrollTop && row.top < viewportBottom)

  return {
    scrollTop,
    scrollHeight,
    clientHeight,
    distanceFromBottom,
    atBottom: distanceFromBottom <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX,
    firstVisibleMessageId: visibleRows[0]?.messageId ?? null,
    lastVisibleMessageId: visibleRows.at(-1)?.messageId ?? null,
  }
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0
}
