import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes.ts'
import { getContextPanelRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { selectAvailableContextPanels } from '../../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore, clampRightRailWidth, RIGHT_RAIL_MAX_WIDTH, RIGHT_RAIL_MIN_WIDTH } from '../../rightRailStore.ts'
import ContextPanelHost from './ContextPanelHost.tsx'

const registry = getContextPanelRegistry()
const subscribe = (listener: () => void) => registry.subscribe(listener)
const snapshot = () => registry.getSnapshot()

const VIRTUAL_SHEET: SheetRecord = {
  id: 'right-rail-virtual', kind: 'overview', title: 'Workspace', createdAt: 0, lastFocusedAt: 0,
}

/** Application-level right rail host. Sheet context is input only; the rail
 * itself stays mounted while navigating between Sheets. */
export default function RightRailHost({ sheet, ctx, activeAgent }: { sheet: SheetRecord | null; ctx: SheetContext; activeAgent?: string }) {
  const collapsed = useRightRailStore(state => state.collapsed)
  const width = useRightRailStore(state => state.width)
  const activePanelId = useRightRailStore(state => state.activePanelId)
  const setWidth = useRightRailStore(state => state.setWidth)
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const panelSnapshot = useSyncExternalStore(subscribe, snapshot, snapshot)
  const shellContext = {
    workspaceKind: sheet?.kind,
    sheetId: sheet?.id ?? null,
    activeSessionId: ctx.activeSession,
    activeAgent,
  }
  const entries = useMemo(() => selectAvailableContextPanels(panelSnapshot.entries, shellContext), [panelSnapshot, sheet?.kind, sheet?.id, ctx.activeSession, activeAgent])
  const effectivePanelId = entries.some(entry => entry.contributionId === activePanelId) ? activePanelId : entries[0]?.contributionId

  useEffect(() => {
    if (!dragRef.current) return
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const next = clampRightRailWidth(drag.startWidth + drag.startX - event.clientX)
      setDragWidth(next)
    }
    const onUp = () => {
      if (!dragRef.current) return
      const next = dragWidth ?? width
      setWidth(next)
      dragRef.current = null
      setDragWidth(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
  }, [dragWidth, setWidth, width])

  if (collapsed || entries.length === 0) return null
  const activeSheet = sheet ?? VIRTUAL_SHEET
  const renderedWidth = dragWidth ?? width
  const maxWidth = Math.min(RIGHT_RAIL_MAX_WIDTH, Math.max(RIGHT_RAIL_MIN_WIDTH, window.innerWidth - 360))
  return (
    <div className="right-rail-host" style={{ '--right-rail-width': `${Math.min(renderedWidth, maxWidth)}px` } as CSSProperties}>
      <div
        className="right-rail-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={RIGHT_RAIL_MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.min(renderedWidth, maxWidth)}
        tabIndex={0}
        onPointerDown={event => {
          event.preventDefault()
          dragRef.current = { startX: event.clientX, startWidth: width }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            setWidth(clampRightRailWidth(width + (event.key === 'ArrowLeft' ? 8 : -8)))
          } else if (event.key === 'Home') setWidth(RIGHT_RAIL_MIN_WIDTH)
          else if (event.key === 'End') setWidth(maxWidth)
        }}
        aria-label="调整右侧栏宽度"
      />
      <ContextPanelHost sheet={activeSheet} ctx={ctx} activePanelId={effectivePanelId} />
    </div>
  )
}
