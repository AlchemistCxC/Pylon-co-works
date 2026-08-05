import { useState, useEffect, lazy, Suspense, useRef, useMemo } from 'react'
import SheetHost from './workspace-sheets/SheetHost'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar'
import { useStore } from './store'
import { useIdentityStore, type AgentEntry } from './identityStore'
import { useRuntimeStore } from './runtimeStore'
import { useWorkspaceStore } from './workspaceStore'
import { IS_TAURI } from './infrastructure/tauri/env'
import { belongsToProfile } from './components/chat/sessionProfile'
import { useShallow } from 'zustand/react/shallow'
import './App.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { loadWindowSize, persistWindowSize } from './windowSizePersistence'
import { reportRuntimeError } from './runtimeError'
import { toCssBackgroundImage } from './backgroundImage'
import { THEME_CSS_VAR_MAP, THEME_FIELD_DEFS } from './themeFieldDefs'
import { listen } from '@tauri-apps/api/event'
import { normalizeAgentStatus, type AgentStatusPayload } from './components/settings/agentTypes'
import { createPermissionController, registerPermissionController } from './infrastructure/acp/permissionController'
import PermissionDialog from './components/PermissionDialog'
import DevMetricsOverlay from './components/DevMetricsOverlay'
import ErrorCenter from './components/ErrorCenter'

// 非首屏 Dialog/Sheet 懒加载：Settings/ProfileEditor/SessionSettings 与 Prism Sheet 按需分包
const Settings = lazy(() => import('./components/Settings'))
const ProfileEditor = lazy(() => import('./components/ProfileEditor'))
const SessionSettings = lazy(() => import('./components/SessionSettings'))
const SheetLauncher = lazy(() => import('./workspace-sheets/SheetLauncher'))
const RightPanel = lazy(() => import('./components/RightPanel'))

function LazyDialogFallback() {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">LOADING</div>
      <p>加载模块…</p>
    </div>
  )
}

// 窗口控制句柄：非 Tauri 环境（浏览器预览）降级为无操作 stub。模块级单例，避免每 render 重建。
const appWindowSingleton = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()

// 非 Tauri（浏览器预览）时 @tauri-apps/api 的 listen/invoke 会 reject，统一守卫

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showSheetLauncher, setShowSheetLauncher] = useState(false)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const sessions = useIdentityStore(s => s.sessions)
  const workspaceSheets = useWorkspaceStore(s => s.workspaceSheets)
  const agents = useIdentityStore(s => s.agents)
  const hydrateWorkspaceSheets = useWorkspaceStore(s => s.hydrateWorkspaceSheets)
  const setSheetAgentState = useWorkspaceStore(s => s.setSheetAgentState)
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const prevActiveAgentRef = useRef<string>(activeAgent)

  useEffect(() => {
    const clearActiveSession = () => setActiveSession(null)
    window.addEventListener('pylon:agent-switched', clearActiveSession)
    return () => window.removeEventListener('pylon:agent-switched', clearActiveSession)
  }, [])


  useEffect(() => {
    if (!belongsToProfile(activeSession, activeProfileId, sessions)) setActiveSession(null)
  }, [activeProfileId, activeSession, sessions])

  useEffect(() => {
    hydrateWorkspaceSheets()
  }, [hydrateWorkspaceSheets])

  // EG：启动时从权威记忆（sheetAgentStates）恢复当前 agent 的 profile 投影与会话，不写回——
  // 写回只发生在用户显式 setActiveProfile（action 内同步记忆）/选会话（下方 effect）；切 agent 的
  // 投影恢复由 identityStore.setActiveAgent 承担。删除旧的 profileRestoredRef 双向手写同步。
  useEffect(() => {
    const memory = useWorkspaceStore.getState().sheetAgentStates[activeAgent]
    if (memory?.activeProfileId && memory.activeProfileId !== activeProfileId) {
      useIdentityStore.getState().setActiveProfile(memory.activeProfileId)
    }
    if (memory?.activeSessionId && memory.activeSessionId !== activeSession) {
      setActiveSession(memory.activeSessionId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 会话选择持久化到该 agent 记忆（profile 已由 setActiveProfile 同步，无需此处写）
  useEffect(() => {
    setSheetAgentState(activeAgent, { activeSessionId: activeSession || undefined })
  }, [activeAgent, activeSession, setSheetAgentState])

  // 仅在 activeAgent 切换时聚焦该 agent 的 sheet；普通 sheet 导航（打开 Prism/工具 sheet、
  // 点击其他 tab）不受影响。用 ref 对比避免 workspaceSheets 每次新引用触发重复聚焦。
  useEffect(() => {
    if (prevActiveAgentRef.current === activeAgent) return
    prevActiveAgentRef.current = activeAgent
    const agentSheet = workspaceSheets.sheets.find(sheet => sheet.kind === 'agent' && sheet.agentId === activeAgent)
    if (agentSheet) useWorkspaceStore.getState().focusSheet(agentSheet.id)
  }, [activeAgent, workspaceSheets])

  useEffect(() => {
    let disposed = false
    // 浏览器预览无 Tauri 后端：list_agents/listen 都会 reject，整体跳过
    if (!IS_TAURI) return
    // 2026-08-02：list_agents 返回类型收窄为 AgentEntry[]（后端契约 {id, name, ...}），
    // 非数组/异常形状由 setAgents 内部 normalizeAgentList 兜底，不再 any。
    const load = () => invoke<AgentEntry[]>('list_agents').then((list: AgentEntry[]) => {
      if (!disposed) useIdentityStore.getState().setAgents(Array.isArray(list) ? list : [])
    }).catch(error => reportRuntimeError('读取 Agent 列表', error))
    load()
    const unlisten = listen<AgentStatusPayload>('pylon:agent-status', event => {
      const activeAgent = useIdentityStore.getState().activeAgent
      const status = normalizeAgentStatus(event.payload, activeAgent)
      useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || activeAgent, status)
    })
    return () => { disposed = true; unlisten.then(stop => stop()).catch(() => {}) }
  }, [])

  // 权限请求 controller：只挂生命周期（listen → store 纯 reducer；approve invoke），不内嵌业务分支
  useEffect(() => {
    if (!IS_TAURI) return
    const controller = createPermissionController({
      dispatch: action => useRuntimeStore.getState().setPermission(action),
      getState: () => useRuntimeStore.getState().permission,
      listen: (event, handler) => listen(event, handler),
      invoke: (cmd, args) => invoke(cmd, args),
    })
    registerPermissionController(controller)
    return () => {
      registerPermissionController(null)
      void controller.dispose()
    }
  }, [])

  // 窗口尺寸记忆：启动恢复上次尺寸，resize 防抖持久化（纯前端，不依赖后端）
  useEffect(() => {
    if (!IS_TAURI) return
    const win = getCurrentWindow()
    const saved = loadWindowSize(localStorage)
    if (saved) win.setSize(new PhysicalSize(saved.width, saved.height)).catch(() => {})
    let timer: number | null = null
    let disposed = false
    const unlisten = win.onResized(({ payload }) => {
      if (disposed) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        persistWindowSize(localStorage, { width: payload.width, height: payload.height })
      }, 400)
    })
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      unlisten.then(stop => stop())
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        setShowSheetLauncher(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const s = useStore(useShallow(s => ({
    accent: s.accent, transparency: s.transparency, bgBlur: s.bgBlur,
    globalBgImage: s.globalBgImage, globalBgColor: s.globalBgColor, uiScheme: s.uiScheme,
    globalFont: s.globalFont, globalFontSize: s.globalFontSize,
    sidebarBg: s.sidebarBg, sidebarBgImage: s.sidebarBgImage, sidebarWidth: s.sidebarWidth,
    sidebarTransparency: s.sidebarTransparency, sidebarBlur: s.sidebarBlur,
    sidebarTextColor: s.sidebarTextColor, sidebarNameSize: s.sidebarNameSize, sidebarGroupSize: s.sidebarGroupSize,
    chatBg: s.chatBg, chatBgImage: s.chatBgImage,
    chatTransparency: s.chatTransparency, chatBlur: s.chatBlur,
    chatFont: s.chatFont, chatFontSize: s.chatFontSize, chatLineHeight: s.chatLineHeight,
    chatTextColor: s.chatTextColor, chatCodeColor: s.chatCodeColor, chatCodeBg: s.chatCodeBg,
    synKeyword: s.synKeyword, synString: s.synString, synComment: s.synComment, synLiteral: s.synLiteral,
    synEntity: s.synEntity, synFunction: s.synFunction, synVariable: s.synVariable, synProperty: s.synProperty,
    synRegex: s.synRegex, synMarkupHeading: s.synMarkupHeading, synCoReference: s.synCoReference, synSupport: s.synSupport,
    msgStyle: s.msgStyle, msgFont: s.msgFont, msgTextColor: s.msgTextColor, msgLineHeight: s.msgLineHeight, messageLayout: s.messageLayout,
    toolOk: s.toolOk, toolRun: s.toolRun, toolErr: s.toolErr,
    toolConnectorColor: s.toolConnectorColor, toolConnectorWidth: s.toolConnectorWidth, toolConnectorOpacity: s.toolConnectorOpacity,
    userTagBg: s.userTagBg, userTagText: s.userTagText,
    diffAdded: s.diffAdded, diffRemoved: s.diffRemoved, diffAddedWord: s.diffAddedWord, diffRemovedWord: s.diffRemovedWord,
    inputBg: s.inputBg, inputBgImage: s.inputBgImage,
    inputTextColor: s.inputTextColor, inputPlaceholder: s.inputPlaceholder,
    inputSendBg: s.inputSendBg, inputFocusBorder: s.inputFocusBorder,
    inputFontSize: s.inputFontSize, inputMinHeight: s.inputMinHeight,
    cliLineWidth: s.cliLineWidth, cliLineColor: s.cliLineColor, cliTextColor: s.cliTextColor, cliPromptColor: s.cliPromptColor, cliLinePadding: s.cliLinePadding, cliContentOffsetY: s.cliContentOffsetY, footerLayout: s.footerLayout, cliOverflowMode: s.cliOverflowMode,
    statusBg: s.statusBg, statusBgImage: s.statusBgImage,
    ccStatusFontSize: s.ccStatusFontSize,
    ccHeight: s.ccHeight, ccBgHeight: s.ccBgHeight, ccBg: s.ccBg,
    ekgWidth: s.ekgWidth,
    ekgGreen: s.ekgGreen,
    pillBg: s.pillBg, pillText: s.pillText, prismOnColor: s.prismOnColor,
    modeAutoColor: s.modeAutoColor, modeEditColor: s.modeEditColor,
    spinnerColor: s.spinnerColor, spinnerSize: s.spinnerSize, spinnerStalledColor: s.spinnerStalledColor, assistantDotColor: s.assistantDotColor,
    rightBg: s.rightBg, rightBgImage: s.rightBgImage, rightWidth: s.rightWidth,
    rightTransparency: s.rightTransparency, rightBlur: s.rightBlur,
  })))

  // cssVars 只依赖 s（useShallow 稳定引用）与 sidebarCollapsed：避免 sessions/agents 等无关
  // 状态 tick 时整棵 App 树重建 60+ CSS 变量与 6 次背景图解析。
  const cssVars = useMemo(() => {
    // 派生/函数值保留手写（背景图转换、字体选择、fallback、窗口宽度、select 直通）
    const vars: Record<string, string> = {
      '--global-bg-image': toCssBackgroundImage(s.globalBgImage),
      '--sidebar-bg-image': toCssBackgroundImage(s.sidebarBgImage),
      '--chat-bg-image': toCssBackgroundImage(s.chatBgImage),
      '--input-bg-image': toCssBackgroundImage(s.inputBgImage),
      '--status-bg-image': toCssBackgroundImage(s.statusBgImage),
      '--right-bg-image': toCssBackgroundImage(s.rightBgImage),
      '--global-font': s.globalFont === 'mono' ? 'var(--mono)' : 'var(--font)',
      '--chat-font': s.chatFont === 'mono' ? 'var(--mono)' : 'var(--font)',
      '--msg-font': s.msgFont === 'mono' ? 'var(--mono)' : 'var(--font)',
      // chatTextColor 经 --chat-text-color 注入（THEME_CSS_VAR_MAP），此处作 msg 兜底链
      '--msg-text': s.msgTextColor || 'var(--chat-text-color,var(--text))',
      '--titlebar-sidebar-width': `${sidebarCollapsed ? 42 : s.sidebarWidth}px`,
    }
    // color/number 字段由 THEME_CSS_VAR_MAP 循环注入（unit 格式化）；空 color 省略
    for (const [cssVar, key] of Object.entries(THEME_CSS_VAR_MAP)) {
      if (cssVar in vars) continue
      const def = THEME_FIELD_DEFS[key]
      const value = (s as Record<string, unknown>)[key]
      if (value === undefined || (def.type === 'color' && value === '')) continue
      vars[cssVar] = def.type === 'number' && def.unit ? `${value}${def.unit}` : String(value)
    }
    return vars as React.CSSProperties
  }, [s, sidebarCollapsed])

  const ccEditMode = useStore(s => s.ccEditMode)

  // body::before 玻璃层挂在 <body> 上，读不到 .app 子元素的 CSS 变量 —
  // 把全局背景相关变量 + scheme 提到 <html>(:root) 与 <body>，让玻璃层生效
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--global-bg-color', s.globalBgColor || '#e8e8ec')
    root.style.setProperty('--global-bg-image', toCssBackgroundImage(s.globalBgImage))
    root.style.setProperty('--t', String(s.transparency))
    root.style.setProperty('--blur', `${s.bgBlur}px`)
    document.body.dataset.uiScheme = s.uiScheme || 'light'
  }, [s.globalBgColor, s.globalBgImage, s.transparency, s.bgBlur, s.uiScheme])

  const appWindow = appWindowSingleton
  const rightPanelInset = rightOpen ? s.rightWidth : 0
  const profilesOpen = showProfileEdit
  const settingsOpen = showSettings

  return (
    <div className="app" data-ui-scheme={s.uiScheme || 'light'} data-msg-style={s.msgStyle || 'terminal'} data-message-layout={s.messageLayout || 'classic'} data-footer-layout={s.footerLayout || 'free'} data-cli-overflow-mode={s.cliOverflowMode || 'fixed-scroll'} style={cssVars}>
      {import.meta.env.DEV && <DevMetricsOverlay />}
      <WorkspaceTitlebar
        sheets={workspaceSheets.sheets}
        activeSheetId={workspaceSheets.activeSheetId}
        activeAgent={activeAgent}
        sidebarCollapsed={sidebarCollapsed}
        canReopenSheet={workspaceSheets.recentlyClosed.length > 0}
        onToggleSidebar={() => setSidebarCollapsed(value => !value)}
        onFocusSheet={id => useWorkspaceStore.getState().focusSheet(id)}
        onCloseSheet={id => useWorkspaceStore.getState().closeSheet(id)}
        menuActions={{
          onTogglePin: id => useWorkspaceStore.getState().toggleSheetPin(id),
          onClose: id => useWorkspaceStore.getState().closeSheet(id),
          onCloseOthers: id => useWorkspaceStore.getState().closeOtherSheets(id),
          onCloseRight: id => useWorkspaceStore.getState().closeRightSheets(id),
          onReopen: () => useWorkspaceStore.getState().reopenSheet(),
        }}
        onOpenSheet={() => setShowSheetLauncher(true)}
        onReopenSheet={() => useWorkspaceStore.getState().reopenSheet()}
        onToggleRightPanel={() => setRightOpen(value => !value)}
        onToggleSettings={() => setShowSettings(value => !value)}
        onMinimize={() => appWindow.minimize()}
        onToggleFullscreen={() => appWindow.isFullscreen().then(fullscreen => appWindow.setFullscreen(!fullscreen)).catch(error => console.error('全屏切换失败', error))}
        onCloseWindow={() => appWindow.destroy()}
      />
      <Suspense fallback={null}>
        {showSheetLauncher && (
          <SheetLauncher
            open={showSheetLauncher}
            agents={agents}
            sheets={workspaceSheets.sheets}
            onOpenChange={setShowSheetLauncher}
            onFocusSheet={id => useWorkspaceStore.getState().focusSheet(id)}
            onOpenSheet={(kind, title, agentId) => useWorkspaceStore.getState().openSheet({ kind, title, agentId })}
            onOpenSettings={() => setShowSettings(true)}
            onOpenProfiles={() => setShowProfileEdit(true)}
          />
        )}
      </Suspense>

      <ErrorCenter />

      <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`}>
        <SheetHost
          activeSession={activeSession}
          onSelectSession={setActiveSession}
          onProfileEdit={() => setShowProfileEdit(true)}
          onSessionSettings={setSessionSettingsId}
          sidebarCollapsed={sidebarCollapsed}
          rightInset={rightPanelInset}
          ccEditMode={ccEditMode}
        />
        <Suspense fallback={<LazyDialogFallback />}>
          {settingsOpen && <Settings activeSessionId={activeSession} onClose={() => setShowSettings(false)} />}
          {rightOpen && <RightPanel sessionId={activeSession} onClose={() => setRightOpen(false)} />}
          {profilesOpen && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
          {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
        </Suspense>
        {/* 权限请求弹窗：store 驱动（无 active 请求返回 null），App 单例挂载不随 sheet 卸载 */}
        <PermissionDialog />
      </div>
    </div>
  )
}
