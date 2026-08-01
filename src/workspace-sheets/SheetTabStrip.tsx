import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { AgentStatus } from '../components/settings/agentTypes'
import type { SheetRecord } from './sheetTypes'
import WorkspaceMenu, { type WorkspaceMenuActions } from './WorkspaceMenu'

interface SheetTabStripProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  agentStatuses: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: (id: string) => void
  menuActions: WorkspaceMenuActions
  canReopen: boolean
}

function resolveAgentState(sheet: SheetRecord, activeAgent: string, agentStatuses: Record<string, AgentStatus>) {
  if (sheet.kind !== 'agent' || !sheet.agentId) return undefined
  if (sheet.agentId !== activeAgent) return 'inactive'
  return agentStatuses[sheet.agentId]?.status || 'disconnected'
}

function resolveSheetTitle(
  sheet: SheetRecord,
  agents: { id: string; name: string }[],
  profiles: { id: string; name: string }[],
  activeAgent: string,
  activeProfileId: string,
  sheetAgentStates: Record<string, { activeProfileId?: string }>,
) {
  if (sheet.kind !== 'agent' || !sheet.agentId) return sheet.title
  const agentName = agents.find(agent => agent.id === sheet.agentId)?.name || sheet.title || sheet.agentId
  const profileId = sheetAgentStates[sheet.agentId]?.activeProfileId
    || (sheet.agentId === activeAgent ? activeProfileId : '')
  const profileName = profiles.find(profile => profile.id === profileId)?.name || profileId || 'default'
  return `${agentName}\\${profileName}`
}

export default function SheetTabStrip({
  sheets,
  activeSheetId,
  activeAgent,
  agentStatuses,
  onFocus,
  onClose,
  menuActions,
  canReopen,
}: SheetTabStripProps) {
  const agents = useStore(state => state.agents)
  const profiles = useStore(state => state.profiles)
  const activeProfileId = useStore(state => state.activeProfileId)
  const sheetAgentStates = useStore(state => state.sheetAgentStates)
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const [menuSheetId, setMenuSheetId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  // 稳定回调：避免菜单打开期间父组件重渲染导致 document 监听反复重绑
  const onCloseMenu = useCallback(() => {
    setMenuSheetId(null)
    setMenuPosition(null)
  }, [])

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
        const displayTitle = resolveSheetTitle(sheet, agents, profiles, activeAgent, activeProfileId, sheetAgentStates)
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
            onContextMenu={event => {
              event.preventDefault()
              const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0
              const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0
              setMenuPosition({
                x: Math.max(0, Math.min(event.clientX, viewportWidth - 210)),
                y: Math.max(0, Math.min(event.clientY, viewportHeight - 160)),
              })
              setMenuSheetId(sheet.id)
            }}
          >
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
              title={displayTitle}
            >
              <span className="sheet-tab-title">{displayTitle}</span>
              {agentState && <span className="sheet-tab-status" aria-label={`Agent 状态：${agentState}`} />}
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
      <WorkspaceMenu
        {...menuActions}
        sheet={sheets.find(sheet => sheet.id === menuSheetId) || null}
        canReopen={canReopen}
        open={menuSheetId !== null}
        onCloseMenu={onCloseMenu}
        className="workspace-menu-tab-context"
        position={menuPosition}
      />
    </div>
  )
}
