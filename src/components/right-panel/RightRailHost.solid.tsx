import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { getContextPanelRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { selectContextPanels, resolveContextPanelDefault } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore, clampRightRailWidth, RIGHT_RAIL_MAX_WIDTH, RIGHT_RAIL_MIN_WIDTH } from '../../domains/workspace/layoutRailsStore.ts'
import ContextPanelHost from './ContextPanelHost.solid.tsx'
import { useStore } from '../../domains/theme/themeStore.ts'
import { createBackgroundPresentation } from '../../infrastructure/skin/backgroundImage.ts'
import { createSolidMount } from '../../host/solidBridge.solid'
import { createZustandSignal } from '../../host/solidStoreBridge.ts'
import type { SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import type { ShellContext } from '../../plugin-runtime/context-panel/contextPanelTypes.ts'
import type { RightRailHostProps } from './rightPanelTypes.ts'

const registry = getContextPanelRegistry()

/** 外部 store（subscribe/getSnapshot 快照语义）→ Solid 信号（快照引用等值）。 */
function createRegistrySignal<T>(store: { subscribe(listener: () => void): () => void; getSnapshot(): T }): () => T {
  const [value, setValue] = createSignal<T>(store.getSnapshot())
  onCleanup(store.subscribe(() => setValue(() => store.getSnapshot())))
  return value
}

const VIRTUAL_SHEET: SheetRecord = {
  id: 'right-rail-virtual', kind: 'overview', title: 'Workspace', createdAt: 0, lastFocusedAt: 0,
}

/** Application-level right rail host. Sheet context is input only; the rail
 * itself stays mounted while navigating between Sheets. */
export default function RightRailHost(props: RightRailHostProps) {
  const collapsed = createZustandSignal(useRightRailStore, state => state.collapsed)
  const width = createZustandSignal(useRightRailStore, state => state.width)
  const activePanelId = createZustandSignal(useRightRailStore, state => state.activePanelId)
  const backgroundImage = createZustandSignal(useStore, state => state.rightBgImage)
  const background = createZustandSignal(useRightRailStore, state => state.background)
  const [dragWidth, setDragWidth] = createSignal<number | null>(null)
  const panelSnapshot = createRegistrySignal(registry)
  let dragRef: { pointerId: number; startX: number; startWidth: number } | null = null

  const shellContext = createMemo<ShellContext>(() => ({
    workspaceKind: props.sheet?.kind,
    sheetId: props.sheet?.id ?? null,
    activeSessionId: props.ctx.activeSession,
    activeAgent: props.activeAgent,
  }))
  // 面板清单**不再按 Sheet 种类过滤**（种类只决定默认选中谁）：用户显式选过的面板跨 Sheet 保持，
  // 没选过才回落到当前种类的亲和面板。见 `contextPanelSelection.ts`。
  const entries = createMemo(() => selectContextPanels(panelSnapshot().entries, shellContext()))
  const effectivePanelId = createMemo(() => entries().some(entry => entry.contributionId === activePanelId())
    ? activePanelId()
    : resolveContextPanelDefault(entries(), props.sheet?.kind)?.contributionId)

  // maxWidth 依赖 window.innerWidth：保持「读取时求值」（React 版每次渲染现算），不缓存
  // 进 memo——窗口 resize 后的下一次渲染/拖拽拿到的都是新值。
  const maxWidth = () => Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, window.innerWidth - 360))
  const renderedWidth = () => dragWidth() ?? width()

  createEffect(() => {
    const image = backgroundImage()
    if (!image) return
    const current = background()
    if (current?.src === image) return
    useRightRailStore.getState().setBackground(createBackgroundPresentation(image, width(), current?.sizing ?? 'fill'))
  })

  const cancelDrag = () => {
    dragRef = null
    setDragWidth(null)
  }

  return (
    <Show when={entries().length > 0}>
      {/* Keep the rail mounted while collapsed. The application-level host owns
          the rail lifetime; retaining the DOM lets the shell animate its width and
          preserves an active panel's local state across a collapse/expand cycle. */}
      <div
        class={`right-rail-host${collapsed() ? ' is-collapsed' : ''}${dragWidth() !== null ? ' is-resizing' : ''}`}
        data-collapsed={collapsed() ? 'true' : 'false'}
        aria-hidden={collapsed() ? 'true' : undefined}
        data-background-sizing={background()?.sizing ?? 'fill'}
        style={{
          '--right-rail-width': `${Math.min(renderedWidth(), maxWidth())}px`,
          '--right-bg-image': background()?.src ? `url(${JSON.stringify(background()!.src)})` : 'var(--right-bg-image, none)',
        }}
      >
        <div
          class="right-rail-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={RIGHT_RAIL_MIN_WIDTH}
          aria-valuemax={maxWidth()}
          aria-valuenow={Math.min(renderedWidth(), maxWidth())}
          tabIndex={collapsed() ? -1 : 0}
          onPointerDown={event => {
            if (collapsed() || event.button !== 0 || dragRef) return
            event.preventDefault()
            dragRef = { pointerId: event.pointerId, startX: event.clientX, startWidth: Math.min(width(), maxWidth()) }
            setDragWidth(Math.min(width(), maxWidth()))
            event.currentTarget.setPointerCapture?.(event.pointerId)
          }}
          onPointerMove={event => {
            const drag = dragRef
            if (!drag || drag.pointerId !== event.pointerId) return
            if (collapsed()) { cancelDrag(); return }
            setDragWidth(Math.min(maxWidth(), clampRightRailWidth(drag.startWidth + drag.startX - event.clientX)))
          }}
          onPointerUp={event => {
            const drag = dragRef
            if (!drag || drag.pointerId !== event.pointerId) return
            if (!collapsed()) useRightRailStore.getState().setWidth(Math.min(maxWidth(), clampRightRailWidth(drag.startWidth + drag.startX - event.clientX)))
            cancelDrag()
          }}
          onPointerCancel={event => { if (dragRef?.pointerId === event.pointerId) cancelDrag() }}
          onLostPointerCapture={event => { if (dragRef?.pointerId === event.pointerId) cancelDrag() }}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              useRightRailStore.getState().setWidth(clampRightRailWidth(width() + (event.key === 'ArrowLeft' ? 8 : -8)))
            } else if (event.key === 'Home') useRightRailStore.getState().setWidth(RIGHT_RAIL_MIN_WIDTH)
            else if (event.key === 'End') useRightRailStore.getState().setWidth(maxWidth())
          }}
          aria-label="调整右侧栏宽度"
        />
        <ContextPanelHost sheet={props.sheet ?? VIRTUAL_SHEET} ctx={props.ctx} activePanelId={effectivePanelId()} />
      </div>
    </Show>
  )
}

/** React 薄桥（RightRailHost.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const renderRightRailHost = createSolidMount(RightRailHost)
