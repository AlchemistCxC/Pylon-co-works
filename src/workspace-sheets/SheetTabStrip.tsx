import { useEffect, useRef } from 'react'
import type { AgentStatus } from '../components/settings/agentTypes'
import type { SheetRecord } from './sheetTypes'

interface SheetTabStripProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  agentStatuses: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: (id: string) => void
}

function resolveAgentState(sheet: SheetRecord, activeAgent: string, agentStatuses: Record<string, AgentStatus>) {
  if (sheet.kind !== 'agent' || !sheet.agentId) return undefined
  if (sheet.agentId !== activeAgent) return 'inactive'
  return agentStatuses[sheet.agentId]?.status || 'disconnected'
}

export default function SheetTabStrip({
  sheets,
  activeSheetId,
  activeAgent,
  agentStatuses,
  onFocus,
  onClose,
}: SheetTabStripProps) {
  const tabRefs = useRef(new Map<string, HTMLDivElement>())

  useEffect(() => {
    if (!activeSheetId) return
    tabRefs.current.get(activeSheetId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeSheetId, sheets.length])

  const moveFocus = (sheetId: string, direction: -1 | 1) => {
    const index = sheets.findIndex(sheet => sheet.id === sheetId)
    if (index < 0 || sheets.length < 2) return
    const next = sheets[(index + direction + sheets.length) % sheets.length]
    onFocus(next.id)
    requestAnimationFrame(() => tabRefs.current.get(next.id)?.querySelector<HTMLButtonElement>('.sheet-tab-focus')?.focus())
  }

  return (
    <div className="sheet-tab-strip" role="tablist" aria-label="Workspace Sheets">
      {sheets.map(sheet => {
        const active = sheet.id === activeSheetId
        const agentState = resolveAgentState(sheet, activeAgent, agentStatuses)
        return (
          <div
            key={sheet.id}
            ref={node => {
              if (node) tabRefs.current.set(sheet.id, node)
              else tabRefs.current.delete(sheet.id)
            }}
            className={`sheet-tab ${active ? 'active' : ''}`}
            data-kind={sheet.kind}
            data-agent-state={agentState}
            role="presentation"
          >
            {agentState && <span className="sheet-tab-status" aria-label={`Agent 状态：${agentState}`} />}
            <button
              type="button"
              className="sheet-tab-focus"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onFocus(sheet.id)}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') {
                  event.preventDefault()
                  moveFocus(sheet.id, -1)
                } else if (event.key === 'ArrowRight') {
                  event.preventDefault()
                  moveFocus(sheet.id, 1)
                } else if ((event.key === 'Delete' || event.key === 'Backspace') && !sheet.pinned) {
                  event.preventDefault()
                  onClose(sheet.id)
                }
              }}
              title={sheet.title}
            >
              <span className="sheet-tab-title">{sheet.title}</span>
            </button>
            {!sheet.pinned && (
              <button
                type="button"
                className="sheet-tab-close"
                onClick={event => {
                  event.stopPropagation()
                  onClose(sheet.id)
                }}
                title={`关闭 ${sheet.title}`}
                aria-label={`关闭 ${sheet.title}`}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
