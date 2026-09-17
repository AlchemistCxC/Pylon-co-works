import { useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  useRightRailStore,
  clampLeftRailWidth,
  LEFT_RAIL_MAX_WIDTH,
  LEFT_RAIL_MIN_WIDTH,
} from '../rightRailStore.ts'

/**
 * LeftRailResizeHandle — 左栏拖拽实时调宽（#154）。
 *
 * 与右栏手柄同形（`role="separator"` + 指针捕获 + 方向键），但**实时**改宽：
 * 拖拽过程中直接把唯一宽度真值 `--sheet-sidebar-track-width` 写到 `.app` 上，
 * 标题栏左轨道、左列外壳、布局分割线因此同一帧一起动。
 *
 * 为什么用命令式写 CSS 变量而不是 React 状态：
 * - 宽度真值住在 `.app`（skin surface），而手柄在 `.layout` 里；用状态驱动就得把它
 *   提回 App 或加 context，且每次 pointermove 都要重渲染整棵 Sheet 子树。
 * - 这里同时给 `.layout` 挂 `is-resizing` 关掉宽度过渡，否则每个 pointermove 的过渡
 *   会互相打断，拖出尾迹。
 *
 * 落库仍走既有单一事务：`setLeftRailWidth`（clamp 160/520 + v3 持久化）。与右栏一样
 * **只在抬起时提交**，避免每帧写一次 localStorage。
 */
export default function LeftRailResizeHandle() {
  const width = useRightRailStore(s => s.leftRailWidth)
  const setWidth = useRightRailStore(s => s.setLeftRailWidth)
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)

  const container = (element: HTMLElement | null) => ({
    app: element?.closest('.app') as HTMLElement | null,
    layout: element?.closest('.layout') as HTMLElement | null,
  })

  // 实时值只写在 .app 上，不改 store——store 是持久化真值，拖拽只是它的预览。
  const paint = (element: HTMLElement | null, next: number) => {
    const { app } = container(element)
    app?.style.setProperty('--sheet-sidebar-track-width', `${next}px`)
  }

  const beginDrag = (element: HTMLElement | null) => {
    container(element).layout?.classList.add('is-resizing')
  }

  const endDrag = (element: HTMLElement | null) => {
    const { app, layout } = container(element)
    app?.style.removeProperty('--sheet-sidebar-track-width')
    layout?.classList.remove('is-resizing')
  }

  const widthFromPointer = (drag: { startX: number; startWidth: number }, clientX: number) =>
    clampLeftRailWidth(drag.startWidth + clientX - drag.startX)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return
    event.preventDefault()
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
    beginDrag(event.currentTarget)
    paint(event.currentTarget, width)
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    paint(event.currentTarget, widthFromPointer(drag, event.clientX))
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const next = widthFromPointer(drag, event.clientX)
    endDrag(event.currentTarget)
    dragRef.current = null
    setWidth(next)
  }

  const cancelDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    endDrag(event.currentTarget)
    dragRef.current = null
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setWidth(width + (event.key === 'ArrowRight' ? 8 : -8))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setWidth(LEFT_RAIL_MIN_WIDTH)
    } else if (event.key === 'End') {
      event.preventDefault()
      setWidth(LEFT_RAIL_MAX_WIDTH)
    }
  }

  return (
    <div
      className="left-rail-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="调整左栏宽度"
      aria-valuemin={LEFT_RAIL_MIN_WIDTH}
      aria-valuemax={LEFT_RAIL_MAX_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      data-left-rail-resize="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
      onKeyDown={onKeyDown}
    />
  )
}
