import { useState, useEffect, lazy, Suspense, useRef, useMemo } from 'react'
import SheetLayout from './workspace-sheets/SheetLayout'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar'
import { useStore } from './store'
import { useIdentityStore } from './identityStore'
import { useRuntimeStore } from './runtimeStore'
import { useWorkspaceStore } from './workspaceStore'
import { IS_TAURI } from './infrastructure/tauri/env'
import { useShallow } from 'zustand/react/shallow'
import './App.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { loadWindowSize, persistWindowSize } from './windowSizePersistence'
import { reportRuntimeError } from './runtimeError'
import { toCssBackgroundImage } from './backgroundImage'
import { selectThemeCssSnapshot } from './domains/theme/themeCssSnapshot'
import { listen } from '@tauri-apps/api/event'
import { normalizeAgentStatus, type AgentStatusPayload } from './components/settings/agentTypes'
import { createAgentClient } from './infrastructure/acp/agentClient'
import { getChatController } from './components/chat/chatEventController'
import { createPermissionController, registerPermissionController } from './infrastructure/acp/permissionController'
import { seedDemo } from './demo/seed'
import { bootstrapApplication } from './app/bootstrap/bootstrapApplication'
import { useHydrationStore } from './app/bootstrap/hydrationState'
import PermissionDialog from './components/PermissionDialog'
import ErrorCenter from './components/ErrorCenter'

// 非首屏 Dialog/Sheet 懒加载：Settings/ProfileEditor/SessionSettings 与 Prism Sheet 按需分包
const Settings = lazy(() => import('./components/Settings'))
const ProfileEditor = lazy(() => import('./components/ProfileEditor'))
const SessionSettings = lazy(() => import('./components/SessionSettings'))
const SheetLauncher = lazy(() => import('./workspace-sheets/SheetLauncher'))

function LazyDialogFallback() {
  return (
    <div className="sheet-empty-host">
      <div className="sheet-empty-kicker">LOADING</div>
      <p>加载模块…</p>
    </div>
  )
}

// FE-AUD-008：typed client 收口 command literal（注入真实 transport）
const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })

// 窗口控制句柄：非 Tauri 环境（浏览器预览）降级为无操作 stub。模块级单例，避免每 render 重建。
const appWindowSingleton = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()

// 非 Tauri（浏览器预览）时 @tauri-apps/api 的 listen/invoke 会 reject，统一守卫

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  // W2-12：右栏折叠迁 workspaceStore（右栏按 sheet 声明挂载），旧 RightPanel 退役
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [showSheetLauncher, setShowSheetLauncher] = useState(false)
  // W1-03（F2-B）：折叠/宽度状态迁入 workspaceStore（预设不覆盖布局），App 只读
  const sidebarCollapsed = useWorkspaceStore(s => s.sidebarCollapsed)
  const sidebarWidth = useWorkspaceStore(s => s.sidebarWidth)
  const workspaceSheets = useWorkspaceStore(s => s.workspaceSheets)
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const prevActiveAgentRef = useRef<string>(activeAgent)

  useEffect(() => {
    const clearActiveSession = () => setActiveSession(null)
    window.addEventListener('pylon:agent-switched', clearActiveSession)
    return () => window.removeEventListener('pylon:agent-switched', clearActiveSession)
  }, [])

  // G0：Chat controller 应用级宿主——listener 随应用生命周期（卸载才 dispose）
  useEffect(() => () => {
    getChatController()?.dispose()
  }, [])

  // FE-AUD-005：单一 bootstrap 事务（阶段 2）——hydrate domains → agents → prune → listener
  const [bootstrapRetry, setBootstrapRetry] = useState(0)
  useEffect(() => {
    let disposed = false
    void bootstrapApplication({
      isTauri: IS_TAURI,
      hydrateDomains: () => useWorkspaceStore.getState().hydrateWorkspaceSheets(),
      fetchAgents: () => agentClient.listAgents(),
      applyAgents: list => useIdentityStore.getState().setAgents(list),
      registerListeners: async () => {
        const unlisten = await listen<AgentStatusPayload>('pylon:agent-status', event => {
          const activeAgent = useIdentityStore.getState().activeAgent
          const status = normalizeAgentStatus(event.payload, activeAgent)
          useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || activeAgent, status)
        })
        return () => { unlisten() }
      },
      reportError: (action, error) => reportRuntimeError(action, error),
      setStatus: (status, error) => useHydrationStore.getState().setStatus(status, error),
      cancelled: () => disposed,
    })
    return () => { disposed = true }
  }, [bootstrapRetry])

  // 仅在 activeAgent 切换时聚焦该 agent 的 sheet；普通 sheet 导航（打开 Prism/工具 sheet、
  // 点击其他 tab）不受影响。用 ref 对比避免 workspaceSheets 每次新引用触发重复聚焦。
  useEffect(() => {
    if (prevActiveAgentRef.current === activeAgent) return
    prevActiveAgentRef.current = activeAgent
    const agentSheet = workspaceSheets.sheets.find(sheet => sheet.kind === 'agent' && sheet.agentId === activeAgent)
    if (agentSheet) useWorkspaceStore.getState().focusSheet(agentSheet.id)
  }, [activeAgent, workspaceSheets])

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

  // 浏览器模式静态演示全景（用户直派，非施工项）：每次启动补 agents/状态灯（非持久化），
  // 仅首次种会话/sheets。声明在所有现有 effect 之后（SheetLayout 子 effect 先跑）；
  // 幂等=seedDemo 内部（sessions 空才种会话）+ seededRef（StrictMode 双跑）。
  const demoSeededRef = useRef(false)
  useEffect(() => {
    if (IS_TAURI) return
    if (demoSeededRef.current) return
    demoSeededRef.current = true
    seedDemo(setActiveSession, {
      withPermission: new URLSearchParams(window.location.search).get('demo-permission') === '1',
    })
  }, [])

  const s = useStore(useShallow(s => ({
    accent: s.accent, transparency: s.transparency, bgBlur: s.bgBlur,
    globalBgImage: s.globalBgImage, globalBgColor: s.globalBgColor, uiScheme: s.uiScheme,
    globalFont: s.globalFont, globalFontSize: s.globalFontSize,
    sidebarBg: s.sidebarBg, sidebarBgImage: s.sidebarBgImage, sidebarWidth: s.sidebarWidth,
    sidebarTransparency: s.sidebarTransparency, sidebarBlur: s.sidebarBlur,
    sidebarTextColor: s.sidebarTextColor, sidebarNameSize: s.sidebarNameSize,
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
    editorFontSize: s.editorFontSize, editorLineHeight: s.editorLineHeight, editorGutterColor: s.editorGutterColor, editorGutterBg: s.editorGutterBg, editorSelection: s.editorSelection, editorActiveLine: s.editorActiveLine, editorTabActive: s.editorTabActive, editorModifiedMark: s.editorModifiedMark,
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
    rightWidth: s.rightWidth,

  })))

  // FE-AUD-013：CSS 变量快照经纯 selector 派生（defs 驱动 + 显式派生），
  // App 只依赖 s（useShallow 稳定引用）与布局宽度，派生逻辑可 node 测
  const cssVars = useMemo(
    () => selectThemeCssSnapshot(s as Readonly<Record<string, unknown>>, { sidebarCollapsed, sidebarWidth }) as React.CSSProperties,
    [s, sidebarCollapsed, sidebarWidth],
  )

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
  // FE-AUD-017：窄 selector 订阅折叠状态（原 getState 不响应式，rightInset 会陈旧）
  const rightPanelCollapsed = useWorkspaceStore(state => state.rightPanelCollapsed)
  const rightPanelInset = rightPanelCollapsed ? 0 : s.rightWidth
  // FE-AUD-005：bootstrap 降级提示（报告阶段 2.4：Agent 列表失败可重试，不清空本地工作区）
  const hydrationStatus = useHydrationStore(state => state.status)
  const hydrationError = useHydrationStore(state => state.error)
  const profilesOpen = showProfileEdit
  const settingsOpen = showSettings

  return (
    <div className="app" data-ui-scheme={s.uiScheme || 'light'} data-msg-style={s.msgStyle || 'terminal'} data-message-layout={s.messageLayout || 'classic'} data-footer-layout={s.footerLayout || 'free'} data-cli-overflow-mode={s.cliOverflowMode || 'fixed-scroll'} style={cssVars}>
      <WorkspaceTitlebar
        sheets={workspaceSheets.sheets}
        activeSheetId={workspaceSheets.activeSheetId}
        activeAgent={activeAgent}
        sidebarCollapsed={sidebarCollapsed}
        canReopenSheet={workspaceSheets.recentlyClosed.length > 0}
        onToggleSidebar={() => useWorkspaceStore.getState().setSidebarCollapsed(!useWorkspaceStore.getState().sidebarCollapsed)}
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
        onToggleRightPanel={() => useWorkspaceStore.getState().setRightPanelCollapsed(!useWorkspaceStore.getState().rightPanelCollapsed)}
        onToggleSettings={() => setShowSettings(value => !value)}
        onMinimize={() => appWindow.minimize()}
        onToggleFullscreen={() => appWindow.isFullscreen().then(fullscreen => appWindow.setFullscreen(!fullscreen)).catch(error => console.error('全屏切换失败', error))}
        onCloseWindow={() => appWindow.destroy()}
      />
      {hydrationStatus === 'degraded' && (
        <div className="workspace-persist-warning" role="alert">
          启动降级：{hydrationError ?? '读取 Agent 列表失败'}
          <button type="button" className="template-apply" onClick={() => setBootstrapRetry(retry => retry + 1)}>重试</button>
        </div>
      )}
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

      {/* W1-03：布局段下移 SheetLayout（侧栏壳/主区/右栏壳 + profile 投影 effects） */}
      <SheetLayout
        activeSession={activeSession}
        onSelectSession={setActiveSession}
        onProfileEdit={() => setShowProfileEdit(true)}
        onSessionSettings={setSessionSettingsId}
        rightInset={rightPanelInset}
      />
      <Suspense fallback={<LazyDialogFallback />}>
        {settingsOpen && <Settings activeSessionId={activeSession} onClose={() => setShowSettings(false)} />}

        {profilesOpen && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
        {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
      </Suspense>
      {/* 权限请求弹窗：store 驱动（无 active 请求返回 null），App 单例挂载不随 sheet 卸载 */}
      <PermissionDialog />
    </div>
  )
}
