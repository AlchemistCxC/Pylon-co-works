import { useEffect } from 'react'
import { useWorkspaceStore } from '../workspaceStore'
import { useIdentityStore } from '../identityStore'
import { useStore } from '../store'
import { useHydrationStore } from '../app/bootstrap/hydrationState'
import { resolveSessionSource } from '../components/chat/sessionCommandState'
import { belongsToProfile } from '../components/chat/sessionProfile'
import { resolveSheetRender } from './sheetRegistry.tsx'
import SheetHost from './SheetHost'
import SheetSidebarSlot from './SheetSidebarSlot'
import SheetRightSlot from './SheetRightSlot'
import type { SheetContext, SheetRecord } from './sheetTypes'

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

function buildSheetContext(props: SheetLayoutProps, sidebarCollapsed: boolean): SheetContext {
  const { openSheet, focusSheet, closeSheet } = useWorkspaceStore.getState()
  return {
    openSheet,
    focusSheet,
    closeSheet,
    activeSession: props.activeSession,
    selectSession: props.onSelectSession,
    openProfileEdit: props.onProfileEdit,
    openSessionSettings: props.onSessionSettings,
    // I09-A-FE-01（L1）：响应式订阅——原 getState() 快照在折叠变化后不触发重渲染（ctx 陈旧）
    sidebarCollapsed,
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
  // I09-A-FE-01（L1）：sidebarCollapsed 响应式订阅——折叠变化必须触发本层重渲染并注入新 ctx
  const sidebarCollapsed = useWorkspaceStore(s => s.sidebarCollapsed)

  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const sessions = useIdentityStore(s => s.sessions)
  const setSheetAgentState = useWorkspaceStore(s => s.setSheetAgentState)
  // 报告 2.3：ready 前禁止 Workspace 写操作——避免启动期用未 hydrate 状态覆盖持久化
  const hydrationReady = useHydrationStore(s => s.status === 'ready')

  // W1-03 原样搬运：启动时从权威记忆（sheetAgentStates）恢复当前 agent 的 profile 投影与会话，
  // 不写回——写回只发生在用户显式 setActiveProfile / 选会话（下方 effect）。
  // 修复：hydrate 就绪后才恢复（子 effect 先于 bootstrap hydrate 执行会读到空记忆）
  useEffect(() => {
    if (!hydrationReady) return
    const memory = useWorkspaceStore.getState().sheetAgentStates[activeAgent]
    if (memory?.activeProfileId && memory.activeProfileId !== activeProfileId) {
      useIdentityStore.getState().setActiveProfile(memory.activeProfileId)
    }
    if (memory?.activeSessionId && memory.activeSessionId !== props.activeSession) {
      props.onSelectSession(memory.activeSessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationReady])

  // W1-03 原样搬运：会话选择持久化到该 agent 记忆（profile 已由 setActiveProfile 同步）。
  // 修复：hydrate 就绪前跳过——否则用初始空 sheets 覆盖持久化（刷新丢 sheets → 启动页）
  useEffect(() => {
    if (!hydrationReady) return
    setSheetAgentState(activeAgent, { activeSessionId: props.activeSession || undefined })
  }, [hydrationReady, activeAgent, props.activeSession, setSheetAgentState])

  // W1-03 原样搬运：profile 越界清理（切 profile 后 activeSession 不属于新 profile → 清空）
  useEffect(() => {
    if (!belongsToProfile(props.activeSession, activeProfileId, sessions)) props.onSelectSession(null)
    // onSelectSession 是 App 传入的稳定 setActiveSession；props 对象本身每 render 变化，不入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfileId, props.activeSession, sessions])

  const ctx = buildSheetContext(props, sidebarCollapsed)
  const ccEditMode = useStore(s => s.ccEditMode)
  // FE-AUD-001 / 1C L1：工作区与用户配置（Profile/Session）写盘失败可见（报告 1A.5/1C）
  const workspacePersistError = useWorkspaceStore(s => s.lastPersistError)
  const identityPersistError = useIdentityStore(s => s.lastPersistError)
  const persistWarning = (workspacePersistError ?? identityPersistError)
    ? <div className="workspace-persist-warning" role="status">配置未能保存到本地存储（本次操作仅在内存生效）</div>
    : null

  if (!activeSheet) {
    // W1-05：无 active sheet → 虚拟 overview 接管空态（不写入持久 sheet 数组）
    const overviewEntry = resolveSheetRender('overview')
    return (
      <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`}>
        {persistWarning}
        {overviewEntry ? overviewEntry.render(VIRTUAL_OVERVIEW_SHEET, ctx) : <EmptySheetHost />}
      </div>
    )
  }

  return (
    <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`}>
      {persistWarning}
      <SheetSidebarSlot sheet={activeSheet} ctx={ctx} />
      <SheetHost sheet={activeSheet} ctx={ctx} />
      <SheetRightSlot sheet={activeSheet} ctx={ctx} />
      {/* G5（FE-AUD-006）：browser sheet 保活——非 active 时隐藏渲染（WebView 不销毁），
          真正 close sheet（从 sheets 移除）才卸载触发 browser_close */}
      {sheets.filter(sheet => sheet.kind === 'browser' && sheet.id !== activeSheetId).map(sheet => (
        <div key={sheet.id} className="browser-keep-alive" style={{ display: 'none' }} aria-hidden="true">
          {resolveSheetRender('browser')?.render(sheet, ctx)}
        </div>
      ))}
    </div>
  )
}

/** 虚拟 overview sheet（空态专用，不持久化） */
const VIRTUAL_OVERVIEW_SHEET: SheetRecord = {
  id: 'overview-virtual',
  kind: 'overview',
  title: 'Overview',
  createdAt: 0,
  lastFocusedAt: 0,
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
