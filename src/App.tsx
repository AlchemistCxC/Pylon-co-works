import { useState, useEffect, lazy, Suspense, useRef, useMemo } from 'react'
import SheetHost from './workspace-sheets/SheetHost'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar'
import { useStore } from './store'
import { useIdentityStore, type AgentEntry } from './identityStore'
import { useRuntimeStore } from './runtimeStore'
import { useWorkspaceStore } from './workspaceStore'
import { belongsToProfile } from './components/chat/sessionProfile'
import { useShallow } from 'zustand/react/shallow'
import './App.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'
import { loadWindowSize, persistWindowSize } from './windowSizePersistence'
import { reportRuntimeError, type RuntimeErrorDetail } from './runtimeError'
import { toCssBackgroundImage } from './backgroundImage'
import { listen } from '@tauri-apps/api/event'
import { normalizeAgentStatus, type AgentStatusPayload } from './components/settings/agentTypes'

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
const IS_TAURI = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' || typeof (window as any).__TAURI__ !== 'undefined'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showSheetLauncher, setShowSheetLauncher] = useState(false)
  const [runtimeError, setRuntimeError] = useState<RuntimeErrorDetail | null>(null)
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
    const onRuntimeError = (event: Event) => setRuntimeError((event as CustomEvent<RuntimeErrorDetail>).detail)
    window.addEventListener('pylon:runtime-error', onRuntimeError)
    return () => window.removeEventListener('pylon:runtime-error', onRuntimeError)
  }, [])

  useEffect(() => {
    if (!belongsToProfile(activeSession, activeProfileId, sessions)) setActiveSession(null)
  }, [activeProfileId, activeSession, sessions])

  useEffect(() => {
    hydrateWorkspaceSheets()
  }, [hydrateWorkspaceSheets])

  useEffect(() => {
    setSheetAgentState(activeAgent, { activeProfileId, activeSessionId: activeSession || undefined })
  }, [activeAgent, activeProfileId, activeSession, setSheetAgentState])

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
    const unlisten = listen<AgentStatusPayload>('peri:agent-status', event => {
      const activeAgent = useIdentityStore.getState().activeAgent
      const status = normalizeAgentStatus(event.payload, activeAgent)
      useRuntimeStore.getState().setAgentStatus(status.agentId || status.agent || activeAgent, status)
    })
    return () => { disposed = true; unlisten.then(stop => stop()) }
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
    toolNameColor: s.toolNameColor, toolSummaryColor: s.toolSummaryColor,
    userTagBg: s.userTagBg, userTagText: s.userTagText,
    diffAdded: s.diffAdded, diffRemoved: s.diffRemoved,
    inputBg: s.inputBg, inputBgImage: s.inputBgImage,
    inputTextColor: s.inputTextColor, inputPlaceholder: s.inputPlaceholder,
    inputSendBg: s.inputSendBg, inputFocusBorder: s.inputFocusBorder,
    inputFontSize: s.inputFontSize, inputMinHeight: s.inputMinHeight,
    cliLineWidth: s.cliLineWidth, cliLineColor: s.cliLineColor, cliTextColor: s.cliTextColor, cliPromptColor: s.cliPromptColor, cliLinePadding: s.cliLinePadding, cliContentOffsetY: s.cliContentOffsetY, cliHintMode: s.cliHintMode, footerLayout: s.footerLayout, cliOverflowMode: s.cliOverflowMode,
    statusBg: s.statusBg, statusBgImage: s.statusBgImage,
    ccStatusFontSize: s.ccStatusFontSize,
    ekgWidth: s.ekgWidth, ekgFontSize: s.ekgFontSize,
    ekgGreen: s.ekgGreen, ekgYellow: s.ekgYellow, ekgRed: s.ekgRed,
    pillBg: s.pillBg, pillText: s.pillText, prismOnColor: s.prismOnColor,
    ekgLineWidth: s.ekgLineWidth, ekgAmplitudeMax: s.ekgAmplitudeMax,
    ekgSpeedBase: s.ekgSpeedBase, ekgSpeedMax: s.ekgSpeedMax,
    ekgLeftColor: s.ekgLeftColor, ekgMovingColor: s.ekgMovingColor,
    ekgConsumedColor: s.ekgConsumedColor, tokenDisplay: s.tokenDisplay, ccVariant: s.ccVariant,
    modeAutoColor: s.modeAutoColor, modeEditColor: s.modeEditColor,
    spinnerColor: s.spinnerColor, spinnerSize: s.spinnerSize,
    rightBg: s.rightBg, rightBgImage: s.rightBgImage, rightWidth: s.rightWidth,
    rightTransparency: s.rightTransparency, rightBlur: s.rightBlur,
  })))

  // cssVars 只依赖 s（useShallow 稳定引用）与 sidebarCollapsed：避免 sessions/agents 等无关
  // 状态 tick 时整棵 App 树重建 60+ CSS 变量与 6 次背景图解析。
  const cssVars = useMemo(() => {
    return {
    '--accent': s.accent || '#3b82f6',
    '--t': s.transparency,
    '--blur': `${s.bgBlur}px`,
    '--global-bg-image': toCssBackgroundImage(s.globalBgImage),
    '--global-bg-color': s.globalBgColor || '#e8e8ec',
    '--global-font': s.globalFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--global-font-size': `${s.globalFontSize}px`,
    '--sidebar-bg': s.sidebarBg,
    '--sidebar-bg-image': toCssBackgroundImage(s.sidebarBgImage),
    '--sidebar-width': `${s.sidebarWidth}px`,
    '--titlebar-sidebar-width': `${sidebarCollapsed ? 42 : s.sidebarWidth}px`,
    '--sidebar-transparency': s.sidebarTransparency,
    '--sidebar-blur': `${s.sidebarBlur}px`,
    '--sidebar-text': s.sidebarTextColor,
    '--sidebar-name-size': `${s.sidebarNameSize}px`,
    '--sidebar-group-size': `${s.sidebarGroupSize}px`,
    '--chat-bg': s.chatBg,
    '--chat-bg-image': toCssBackgroundImage(s.chatBgImage),
    '--chat-transparency': s.chatTransparency,
    '--chat-blur': `${s.chatBlur}px`,
    '--chat-font': s.chatFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--chat-font-size': `${s.chatFontSize}px`,
    '--chat-line-height': s.chatLineHeight,
    '--chat-text': s.chatTextColor,
    '--chat-code-color': s.chatCodeColor,
    '--chat-code-bg': s.chatCodeBg,
    '--syn-kw': s.synKeyword, '--syn-str': s.synString, '--syn-cmt': s.synComment, '--syn-lit': s.synLiteral,
    '--syn-ent': s.synEntity, '--syn-fn': s.synFunction, '--syn-var': s.synVariable, '--syn-prop': s.synProperty,
    '--syn-re': s.synRegex, '--syn-mh': s.synMarkupHeading, '--syn-cor': s.synCoReference, '--syn-support': s.synSupport,
    '--msg-font': s.msgFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--msg-text': s.msgTextColor || 'var(--chat-text,var(--text))',
    '--msg-line-height': s.msgLineHeight,
    '--tool-ok': s.toolOk, '--tool-run': s.toolRun, '--tool-err': s.toolErr,
    '--tool-name': s.toolNameColor, '--tool-summary': s.toolSummaryColor,
    '--user-tag-bg': s.userTagBg, '--user-tag-text': s.userTagText,
    '--diff-added': s.diffAdded, '--diff-removed': s.diffRemoved,
    '--input-bg': s.inputBg,
    '--input-bg-image': toCssBackgroundImage(s.inputBgImage),
    '--input-text': s.inputTextColor, '--input-placeholder': s.inputPlaceholder,
    '--input-send': s.inputSendBg, '--input-focus': s.inputFocusBorder,
    '--input-font-size': `${s.inputFontSize}px`, '--input-min-h': `${s.inputMinHeight}px`,
    '--cli-line-width': `${s.cliLineWidth}px`,
    '--cli-line-color': s.cliLineColor || undefined,
    '--cli-text-color': s.cliTextColor || undefined,
    '--cli-prompt-color': s.cliPromptColor || undefined,
    '--cli-line-padding': `${s.cliLinePadding ?? 6}px`,
    '--cli-content-offset-y': `${s.cliContentOffsetY ?? 0}px`,
    '--status-bg': s.statusBg,
    '--status-bg-image': toCssBackgroundImage(s.statusBgImage),
    '--cc-status-font-size': `${s.ccStatusFontSize ?? 14}px`,
    '--ekg-w': `${s.ekgWidth}px`, '--ekg-font': `${s.ekgFontSize}px`,
    '--ekg-green': s.ekgGreen, '--ekg-yellow': s.ekgYellow, '--ekg-red': s.ekgRed,
    '--pill-bg': s.pillBg, '--pill-text': s.pillText,
    '--prism-on': s.prismOnColor,
    '--ekg-line-width': `${s.ekgLineWidth}px`,
    '--ekg-amp-max': `${s.ekgAmplitudeMax}px`,
    '--ekg-speed-base': s.ekgSpeedBase, '--ekg-speed-max': s.ekgSpeedMax,
    '--ekg-left': s.ekgLeftColor, '--ekg-moving': s.ekgMovingColor,
    '--ekg-consumed': s.ekgConsumedColor, '--token-display': s.tokenDisplay,
    '--cc-variant': s.ccVariant,
    '--mode-auto': s.modeAutoColor, '--mode-edit': s.modeEditColor,
    '--spinner-color': s.spinnerColor || undefined, '--spinner-size': `${s.spinnerSize}px`,
    '--right-bg': s.rightBg,
    '--right-bg-image': toCssBackgroundImage(s.rightBgImage),
    '--right-width': `${s.rightWidth}px`,
    '--right-transparency': s.rightTransparency,
    '--right-blur': `${s.rightBlur}px`,
    } as React.CSSProperties
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

      {runtimeError && (
        <div className="runtime-error-banner" role="alert">
          <strong>{runtimeError.action}失败</strong>
          <span>{runtimeError.message}</span>
          <button type="button" onClick={() => setRuntimeError(null)} aria-label="关闭错误提示">✕</button>
        </div>
      )}

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
      </div>
    </div>
  )
}
