import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Bot, FileCode2, Globe2, History, LayoutDashboard, MoreHorizontal, Network, Puzzle, Search, X } from 'lucide-react'
import { useIdentityStore } from '../identityStore'
import { useWorkspaceStore } from '../workspaceStore'
import { activateAgentSheet } from './activateAgentSheet'
import { selectAgentStatus, type AgentStatus } from '../components/settings/agentTypes'

import type { SheetRecord } from './sheetTypes'
import WorkspaceMenu, { type WorkspaceMenuActions } from './WorkspaceMenu'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'

interface SheetTabStripProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  /** Agent 状态仅保留语义/无障碍信息，不再渲染可见圆点。 */
  agentStatuses?: Record<string, AgentStatus>
  onFocus: (id: string) => void
  onClose: (id: string) => void
  menuActions: WorkspaceMenuActions
  canReopen: boolean
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
  const agents = useIdentityStore(state => state.agents)
  const profiles = useIdentityStore(state => state.profiles)
  const activeProfileId = useIdentityStore(state => state.activeProfileId)
  const sheetAgentStates = useWorkspaceStore(state => state.sheetAgentStates)
  const modernGui = useInterfaceModeStore(state => state.interfaceMode === 'modern-gui')
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const stripRef = useRef<HTMLDivElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  const overflowMenuRef = useRef<HTMLDivElement>(null)
  const switchingSheetRef = useRef<string | null>(null)
  const [switchingSheetId, setSwitchingSheetId] = useState<string | null>(null)
  const [menuSheetId, setMenuSheetId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
  const [overflowState, setOverflowState] = useState({ left: false, right: false, overflowed: false })
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false)
  const [overflowMenuPosition, setOverflowMenuPosition] = useState({ top: 0, right: 0 })
  // 稳定回调：避免菜单打开期间父组件重渲染导致 document 监听反复重绑
  const onCloseMenu = useCallback(() => {
    setMenuSheetId(null)
    setMenuPosition(null)
  }, [])

  useEffect(() => {
    if (!activeSheetId) return
    tabRefs.current.get(activeSheetId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    requestAnimationFrame(() => {
      const strip = stripRef.current
      if (!strip) return
      const max = Math.max(0, strip.scrollWidth - strip.clientWidth)
      setOverflowState({ left: strip.scrollLeft > 1, right: strip.scrollLeft < max - 1, overflowed: max > 1 })
    })
  }, [activeSheetId, sheets.length])

  const updateOverflow = useCallback(() => {
    const strip = stripRef.current
    if (!strip) return
    const max = Math.max(0, strip.scrollWidth - strip.clientWidth)
    setOverflowState({ left: strip.scrollLeft > 1, right: strip.scrollLeft < max - 1, overflowed: max > 1 })
  }, [])

  useEffect(() => {
    updateOverflow()
    const strip = stripRef.current
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateOverflow)
    if (strip) observer?.observe(strip)
    window.addEventListener('resize', updateOverflow)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateOverflow)
    }
  }, [sheets.length, updateOverflow])

  useEffect(() => {
    if (!overflowMenuOpen) return
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node
      if (!regionRef.current?.contains(target) && !overflowMenuRef.current?.contains(target)) setOverflowMenuOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverflowMenuOpen(false)
    }
    document.addEventListener('mousedown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [overflowMenuOpen])

  const focusSheet = useCallback(async (sheet: SheetRecord): Promise<boolean> => {
    const targetAgentId = sheet.kind === 'agent' ? sheet.agentId : undefined
    const currentActiveAgent = useIdentityStore.getState().activeAgent || activeAgent
    if (!targetAgentId || targetAgentId === currentActiveAgent) {
      onFocus(sheet.id)
      return true
    }
    if (switchingSheetRef.current) return false

    switchingSheetRef.current = sheet.id
    setSwitchingSheetId(sheet.id)
    const agentName = agents.find(agent => agent.id === targetAgentId)?.name || sheet.title || targetAgentId
    const activated = await activateAgentSheet(targetAgentId, agentName, () => onFocus(sheet.id))
    switchingSheetRef.current = null
    setSwitchingSheetId(null)
    return activated
  }, [activeAgent, agents, onFocus])

  const moveFocus = (sheetId: string, direction: -1 | 1) => {
    const index = sheets.findIndex(sheet => sheet.id === sheetId)
    if (index < 0 || sheets.length < 2) return
    const next = sheets[(index + direction + sheets.length) % sheets.length]
    void focusSheet(next).then(focused => {
      if (focused) requestAnimationFrame(() => tabRefs.current.get(next.id)?.querySelector<HTMLButtonElement>('.sheet-tab-focus')?.focus())
    })
  }

  return (
    <div ref={regionRef} className={`sheet-tab-region ${overflowState.overflowed ? 'overflowed' : ''} ${overflowState.left ? 'can-scroll-left' : ''} ${overflowState.right ? 'can-scroll-right' : ''}`}>
    <div ref={stripRef} className="sheet-tab-strip" role="tablist" aria-label="Workspace Sheets" onScroll={updateOverflow}>
      {sheets.map(sheet => {
        const active = sheet.id === activeSheetId
        const agentState = sheet.kind === 'agent' && sheet.agentId
          ? selectAgentStatus(sheet.agentId, activeAgent, agentStatuses ?? {}).status
          : undefined
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
              aria-busy={switchingSheetId === sheet.id}
              disabled={switchingSheetId === sheet.id}
              tabIndex={active ? 0 : -1}
              onClick={() => { void focusSheet(sheet) }}
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
              <SheetKindMark kind={sheet.kind} modern={modernGui} />
              <span className="sheet-tab-title">{displayTitle}</span>
              {agentState && <span className="sr-only" aria-label={`Agent 状态：${agentState}`} />}

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
                {modernGui ? <X size={13} aria-hidden="true" /> : '×'}
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
    {overflowState.overflowed && <button type="button" className="sheet-tab-overflow-trigger" aria-label="显示所有 Sheet" aria-expanded={overflowMenuOpen} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      setOverflowMenuPosition({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
      setOverflowMenuOpen(open => !open)
    }}><MoreHorizontal size={17} /></button>}
    {overflowMenuOpen && createPortal(
      <div ref={overflowMenuRef} className="sheet-tab-overflow-menu" role="menu" aria-label="所有 Sheet" style={{ top: overflowMenuPosition.top, right: overflowMenuPosition.right }}>
        {sheets.map(sheet => {
          const displayTitle = resolveSheetTitle(sheet, agents, profiles, activeAgent, activeProfileId, sheetAgentStates)
          return <button key={sheet.id} type="button" role="menuitem" className={sheet.id === activeSheetId ? 'active' : ''} onClick={() => {
            setOverflowMenuOpen(false)
            void focusSheet(sheet)
          }}><SheetKindMark kind={sheet.kind} modern={modernGui} /><span>{displayTitle}</span></button>
        })}
      </div>,
      document.body,
    )}
    </div>
  )
}

function SheetKindMark({ kind, modern }: { kind: string; modern: boolean }) {
  if (!modern) return <span className="sheet-tab-kind-mark" aria-hidden="true" />
  const Icon = kind === 'agent' ? Bot
    : kind === 'overview' ? LayoutDashboard
      : kind === 'file' ? FileCode2
        : kind === 'search' ? Search
          : kind === 'history' ? History
            : kind === 'browser' ? Globe2
              : kind === 'runtime' ? Activity
                : kind === 'gateway' ? Network
                  : Puzzle
  return <span className="sheet-tab-kind-mark sheet-tab-kind-icon" aria-hidden="true"><Icon size={14} strokeWidth={1.8} /></span>
}
