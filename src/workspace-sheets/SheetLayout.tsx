import { useEffect } from 'react'
import { useWorkspaceStore } from '../workspaceStore'
import { useIdentityStore } from '../identityStore'
import { useStore } from '../store'
import { resolveSessionSource } from '../components/chat/sessionCommandState'
import { belongsToProfile } from '../components/chat/sessionProfile'
import SheetHost from './SheetHost'
import SheetSidebarSlot from './SheetSidebarSlot'
import SheetRightSlot from './SheetRightSlot'
import type { SheetContext } from './sheetTypes'

/**
 * SheetLayout — sheet 布局层（W1-03 侧栏上移，行为敏感）。
 *
 * 接盘 App 布局段：解析 activeSheet、构建 SheetContext、按 registry 声明渲染
 * [侧栏壳 | 主区 | 右栏壳]。profile 投影与会话记忆 effects 从 App 原样搬运（行为不变）。
 * 无 sheet → 空态。Settings/对话框保持 App 单例挂载，不进本层。
 */

interface SheetLayoutProps {
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
  onSessionSettings: (id: string) => void
  rightInset: number
}

function buildSheetContext(props: SheetLayoutProps): SheetContext {
  const { openSheet, focusSheet, closeSheet } = useWorkspaceStore.getState()
  return {
    openSheet,
    focusSheet,
    closeSheet,
    activeSession: props.activeSession,
    selectSession: props.onSelectSession,
    openProfileEdit: props.onProfileEdit,
    openSessionSettings: props.onSessionSettings,
    sidebarCollapsed: useWorkspaceStore.getState().sidebarCollapsed,
    rightInset: props.rightInset,
    ccEditMode: useStore.getState().ccEditMode,
    sessionSource: sessionId => resolveSessionSource(sessionId, useIdentityStore.getState().sessions),
    sessionBySource: source => useIdentityStore.getState().sessions.find(session => session.source === source),
  }
}

export default function SheetLayout(props: SheetLayoutProps) {
  const sheets = useWorkspaceStore(s => s.workspaceSheets.sheets)
  const activeSheetId = useWorkspaceStore(s => s.workspaceSheets.activeSheetId)
  const activeSheet = sheets.find(sheet => sheet.id === activeSheetId)

  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const sessions = useIdentityStore(s => s.sessions)
  const setSheetAgentState = useWorkspaceStore(s => s.setSheetAgentState)

  // W1-03 原样搬运：启动时从权威记忆（sheetAgentStates）恢复当前 agent 的 profile 投影与会话，
  // 不写回——写回只发生在用户显式 setActiveProfile / 选会话（下方 effect）
  useEffect(() => {
    const memory = useWorkspaceStore.getState().sheetAgentStates[activeAgent]
    if (memory?.activeProfileId && memory.activeProfileId !== activeProfileId) {
      useIdentityStore.getState().setActiveProfile(memory.activeProfileId)
    }
    if (memory?.activeSessionId && memory.activeSessionId !== props.activeSession) {
      props.onSelectSession(memory.activeSessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // W1-03 原样搬运：会话选择持久化到该 agent 记忆（profile 已由 setActiveProfile 同步）
  useEffect(() => {
    setSheetAgentState(activeAgent, { activeSessionId: props.activeSession || undefined })
  }, [activeAgent, props.activeSession, setSheetAgentState])

  // W1-03 原样搬运：profile 越界清理（切 profile 后 activeSession 不属于新 profile → 清空）
  useEffect(() => {
    if (!belongsToProfile(props.activeSession, activeProfileId, sessions)) props.onSelectSession(null)
    // onSelectSession 是 App 传入的稳定 setActiveSession；props 对象本身每 render 变化，不入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, props.activeSession, sessions])

  const ctx = buildSheetContext(props)
  const ccEditMode = useStore(s => s.ccEditMode)

  if (!activeSheet) {
    return (
      <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`}>
        <EmptySheetHost />
      </div>
    )
  }

  return (
    <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`}>
      <SheetSidebarSlot sheet={activeSheet} ctx={ctx} />
      <SheetHost sheet={activeSheet} ctx={ctx} />
      <SheetRightSlot sheet={activeSheet} ctx={ctx} />
    </div>
  )
}

function EmptySheetHost() {
  const openSheet = useWorkspaceStore(s => s.openSheet)
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">WORKSPACE</div>
      <h2>没有打开的 Sheet</h2>
      <p>打开一个 Agent 工作现场，或从工具入口选择 Sheet。</p>
      <button type="button" onClick={() => openSheet({ kind: 'agent', title: 'Riccati', agentId: 'riccati' })}>
        打开 Riccati
      </button>
    </div>
  )
}
