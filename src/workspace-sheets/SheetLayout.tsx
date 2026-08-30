import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useWorkspaceStore } from '../workspaceStore'
import { useIdentityStore } from '../identityStore'
import { useStore } from '../store'
import { useHydrationStore } from '../app/bootstrap/hydrationState'
import { resolveSessionSource } from '../components/chat/sessionCommandState'
import { belongsToProfile } from '../components/chat/sessionProfile'
import { resolveSheetRender } from './sheetRegistry.tsx'
import { activateAgentSheet } from './activateAgentSheet'
import SheetHost from './SheetHost'
import SheetSidebarSlot from './SheetSidebarSlot'
import SheetRightSlot from './SheetRightSlot'
import type { SheetContext, SheetRecord } from './sheetTypes'
import { getWorkspaceRegistrySnapshot, subscribeWorkspaceRegistry } from './workspaceRegistry'
import { closeWorkspace } from './workspaceController'

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
}

function buildSheetContext(props: SheetLayoutProps, sidebarCollapsed: boolean): SheetContext {
  const { openSheet, focusSheet } = useWorkspaceStore.getState()
  return {
    openSheet,
    focusSheet,
    closeSheet: id => { void closeWorkspace(id) },
    activeSession: props.activeSession,
    selectSession: props.onSelectSession,
    openProfileEdit: props.onProfileEdit,
    openSessionSettings: props.onSessionSettings,
    // I09-A-FE-01（L1）：响应式订阅——原 getState() 快照在折叠变化后不触发重渲染（ctx 陈旧）
    sidebarCollapsed,
    // 右栏由 SheetRightSlot 作为 .layout 的 flex sibling 占位，主区宽度已天然扣除；
    // renderer 再消费 rightInset 会二次挤压内容，并在折叠切换时产生异常跳宽。
    rightInset: 0,
    ccEditMode: useStore.getState().ccEditMode,
    // active 主区的 context；非 active 的 keep-alive Sheet 会在下方显式覆盖为 false。
    isActive: true,
    sessionSource: sessionId => resolveSessionSource(sessionId, useIdentityStore.getState().sessions),
    sessionBySource: source => useIdentityStore.getState().sessions.find(session => session.source === source),
  }
}

export default function SheetLayout(props: SheetLayoutProps) {
  useSyncExternalStore(
    subscribeWorkspaceRegistry,
    getWorkspaceRegistrySnapshot,
    getWorkspaceRegistrySnapshot,
  )
  const sheets = useWorkspaceStore(s => s.workspaceSheets.sheets)
  const activeSheetId = useWorkspaceStore(s => s.workspaceSheets.activeSheetId)
  const activeSheet = sheets.find(sheet => sheet.id === activeSheetId)
  // 左栏是统一应用布局；切换任何 Sheet 都保持同一折叠状态。
  const sidebarCollapsed = useWorkspaceStore(s => s.sidebarCollapsed)

  const identityActiveAgent = useIdentityStore(s => s.activeAgent)
  const sheetOwnerAgentId = activeSheet?.kind === 'agent' ? activeSheet.agentId : undefined
  // 冷启动：激活 agent sheet 时，activeAgent 以恢复出的 sheet owner 为准，避免固定回退 peri。
  const activeAgent = sheetOwnerAgentId ?? (identityActiveAgent || 'peri')
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const sessions = useIdentityStore(s => s.sessions)
  const sheetAgentStates = useWorkspaceStore(s => s.sheetAgentStates)
  const setSheetAgentState = useWorkspaceStore(s => s.setSheetAgentState)
  // 报告 2.3：ready 前禁止 Workspace 写操作——避免启动期用未 hydrate 状态覆盖持久化
  const hydrationReady = useHydrationStore(s => s.status === 'ready')
  const didColdStartActivate = useRef(false)

  // A（冷启动自动恢复）：hydrate 就绪后，若恢复出的激活 sheet owner ≠ 当前 activeAgent，
  // 自动切到该 owner（连接对应 Agent），避免默认连 peri 导致 Hermes sheet 报错。
  useEffect(() => {
    if (!hydrationReady || didColdStartActivate.current) return
    if (!sheetOwnerAgentId) return
    const current = useIdentityStore.getState().activeAgent
    if (current === sheetOwnerAgentId) return
    didColdStartActivate.current = true
    const agentName = useIdentityStore.getState().agents.find(agent => agent.id === sheetOwnerAgentId)?.name ?? sheetOwnerAgentId
    void activateAgentSheet(sheetOwnerAgentId, agentName, () => {}, { silent: true })
  }, [hydrationReady, sheetOwnerAgentId])

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
  const activeSessionOwner = sessions.find(session => session.id === props.activeSession)?.agentId
  const contextForAgentSheet = (sheet: SheetRecord): SheetContext => {
    const rememberedSession = sheet.agentId ? sheetAgentStates[sheet.agentId]?.activeSessionId ?? null : null
    const sessionId = activeSessionOwner === sheet.agentId ? props.activeSession : rememberedSession
    const active = sheet.id === activeSheetId
    return {
      ...ctx,
      activeSession: sessionId,
      selectSession: id => {
        if (sheet.agentId) setSheetAgentState(sheet.agentId, { activeSessionId: id ?? undefined })
        if (active) props.onSelectSession(id)
      },
    }
  }
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
      <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`} data-pylon-surface="workspace" data-agent-id={activeAgent}>
        {persistWarning}
        {overviewEntry ? <overviewEntry.component sheet={VIRTUAL_OVERVIEW_SHEET} ctx={ctx} state={overviewEntry.deserialize(undefined)} /> : <EmptySheetHost />}
      </div>
    )
  }

  return (
    <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`} data-pylon-surface="workspace" data-agent-id={activeAgent}>
      {persistWarning}
      <SheetSidebarSlot sheet={activeSheet} ctx={ctx} />
      {activeSheet.kind !== 'agent' && activeSheet.kind !== 'file' && activeSheet.kind !== 'browser' && <SheetHost sheet={activeSheet} ctx={ctx} />}
      {sheets.filter(sheet => sheet.kind === 'agent').map(sheet => {
        const active = sheet.id === activeSheetId
        return (
          <div key={sheet.id} className="agent-sheet-keep-alive" data-sheet-id={sheet.id}
            aria-hidden={active ? undefined : true} style={{ display: active ? 'contents' : 'none' }}>
            <SheetHost sheet={sheet} ctx={contextForAgentSheet(sheet)} />
          </div>
        )
      })}
      {/* FileSheet owns in-memory editor drafts. Keep every open FileSheet at one stable
          React position so ordinary Sheet navigation cannot unmount and discard them. */}
      {sheets.filter(sheet => sheet.kind === 'file').map(sheet => {
        const active = sheet.id === activeSheetId
        return (
          <div key={sheet.id} className="file-sheet-keep-alive" data-file-sheet-id={sheet.id}
            aria-hidden={active ? undefined : true} style={{ display: active ? 'contents' : 'none' }}>
            <SheetHost sheet={sheet} ctx={ctx} />
          </div>
        )
      })}
      <SheetRightSlot sheet={activeSheet} ctx={ctx} />
      {/* G5（FE-AUD-006）：Browser 与 Agent/File 一样固定在稳定位置保活。
          活动态用 display:contents 进入主舞台，非活动态只隐藏 DOM；真正 close
          （从 sheets 移除）才卸载并触发 browser_close，避免标签/页面状态丢失。 */}
      {sheets.filter(sheet => sheet.kind === 'browser').map(sheet => {
        const active = sheet.id === activeSheetId
        const browserEntry = resolveSheetRender('browser')
        const BrowserComponent = browserEntry?.component
        return (
          <div key={sheet.id} data-sheet-id={sheet.id} className="browser-keep-alive"
            aria-hidden={active ? undefined : true} style={{ display: active ? 'contents' : 'none' }}>
            {BrowserComponent && browserEntry
              ? <BrowserComponent sheet={sheet} ctx={{ ...ctx, isActive: active }} state={browserEntry.deserialize(sheet.state)} />
              : null}
          </div>
        )
      })}
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
      <button type="button" onClick={() => openSheet({ kind: 'agent', title: 'Peri', agentId: 'peri' })}>
        打开 Peri
      </button>
    </div>
  )
}
