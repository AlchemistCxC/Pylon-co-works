import { useState, useEffect } from 'react'
import SheetHost from './workspace-sheets/SheetHost'
import WorkspaceTitlebar from './workspace-sheets/WorkspaceTitlebar'
import SheetLauncher from './workspace-sheets/SheetLauncher'
import Settings from './components/Settings'
import ProfileEditor from './components/ProfileEditor'
import RightPanel from './components/RightPanel'
import SessionSettings from './components/SessionSettings'
import { useStore } from './store'
import { belongsToProfile } from './components/chat/sessionProfile'
import { useShallow } from 'zustand/react/shallow'
import './App.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError, type RuntimeErrorDetail } from './runtimeError'
import { toCssBackgroundImage } from './backgroundImage'
import { listen } from '@tauri-apps/api/event'
import { normalizeAgentStatus, type AgentStatusPayload } from './components/settings/agentTypes'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showSheetLauncher, setShowSheetLauncher] = useState(false)
  const [runtimeError, setRuntimeError] = useState<RuntimeErrorDetail | null>(null)
  const activeProfileId = useStore(s => s.activeProfileId)
  const sessions = useStore(s => s.sessions)
  const workspaceSheets = useStore(s => s.workspaceSheets)
  const agents = useStore(s => s.agents)
  const agentStatuses = useStore(s => s.agentStatuses)
  const hydrateWorkspaceSheets = useStore(s => s.hydrateWorkspaceSheets)
  const setSheetAgentState = useStore(s => s.setSheetAgentState)
  const activeAgent = useStore(s => s.activeAgent) || 'peri'

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

  useEffect(() => {
    const activeSheet = workspaceSheets.sheets.find(sheet => sheet.id === workspaceSheets.activeSheetId)
    if (activeSheet?.kind === 'agent' && activeSheet.agentId === activeAgent) return
    const agentSheet = workspaceSheets.sheets.find(sheet => sheet.kind === 'agent' && sheet.agentId === activeAgent)
    if (agentSheet) useStore.getState().focusSheet(agentSheet.id)
  }, [activeAgent, workspaceSheets])

  useEffect(() => {
    let disposed = false
    const load = () => invoke('list_agents').then((list: any) => {
      if (!disposed) useStore.getState().setAgents(Array.isArray(list) ? list : [])
    }).catch(error => reportRuntimeError('读取 Agent 列表', error))
    load()
    const unlisten = listen<AgentStatusPayload>('peri:agent-status', event => {
      const state = useStore.getState()
      const status = normalizeAgentStatus(event.payload, state.activeAgent)
      state.setAgentStatus(status.agent || state.activeAgent, status)
    })
    return () => { disposed = true; unlisten.then(stop => stop()) }
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
    transparency: s.transparency, bgBlur: s.bgBlur,
    globalBgImage: s.globalBgImage, globalBgColor: s.globalBgColor, uiScheme: s.uiScheme,
    globalFont: s.globalFont, globalFontSize: s.globalFontSize,
    sidebarBg: s.sidebarBg, sidebarBgImage: s.sidebarBgImage, sidebarWidth: s.sidebarWidth,
    sidebarTransparency: s.sidebarTransparency, sidebarBlur: s.sidebarBlur,
    sidebarTextColor: s.sidebarTextColor, sidebarNameSize: s.sidebarNameSize, sidebarGroupSize: s.sidebarGroupSize,
    chatBg: s.chatBg, chatBgImage: s.chatBgImage,
    chatTransparency: s.chatTransparency, chatBlur: s.chatBlur,
    chatFont: s.chatFont, chatFontSize: s.chatFontSize, chatLineHeight: s.chatLineHeight,
    chatTextColor: s.chatTextColor, chatCodeColor: s.chatCodeColor, chatCodeBg: s.chatCodeBg,
    msgStyle: s.msgStyle, msgFont: s.msgFont, msgTextColor: s.msgTextColor, msgLineHeight: s.msgLineHeight, messageLayout: s.messageLayout,
    toolOk: s.toolOk, toolRun: s.toolRun, toolErr: s.toolErr,
    toolNameColor: s.toolNameColor, toolSummaryColor: s.toolSummaryColor,
    userTagBg: s.userTagBg, userTagText: s.userTagText,
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
    spinnerColor: s.spinnerColor, spinnerSize: s.spinnerSize,
    rightBg: s.rightBg, rightBgImage: s.rightBgImage, rightWidth: s.rightWidth,
    rightTransparency: s.rightTransparency, rightBlur: s.rightBlur,
  })))

  const cssVars = {
    '--t': s.transparency,
    '--blur': `${s.bgBlur}px`,
    '--global-bg-image': toCssBackgroundImage(s.globalBgImage),
    '--global-bg-color': (s as any).globalBgColor || '#e8e8ec',
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
    '--msg-font': s.msgFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--msg-text': s.msgTextColor || 'var(--chat-text,var(--text))',
    '--msg-line-height': s.msgLineHeight,
    '--tool-ok': s.toolOk, '--tool-run': s.toolRun, '--tool-err': s.toolErr,
    '--tool-name': s.toolNameColor, '--tool-summary': s.toolSummaryColor,
    '--user-tag-bg': s.userTagBg, '--user-tag-text': s.userTagText,
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
    '--spinner-color': s.spinnerColor || undefined, '--spinner-size': `${s.spinnerSize}px`,
    '--right-bg': s.rightBg,
    '--right-bg-image': toCssBackgroundImage(s.rightBgImage),
    '--right-width': `${s.rightWidth}px`,
    '--right-transparency': s.rightTransparency,
    '--right-blur': `${s.rightBlur}px`,
  } as React.CSSProperties

  const ccEditMode = useStore(s => s.ccEditMode)
  const u = useStore(s => s.updateTheme)

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

  const appWindow = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()
  const rightPanelInset = rightOpen ? s.rightWidth : 0
  const profilesOpen = showProfileEdit
  const settingsOpen = showSettings

  return (
    <div className="app" data-ui-scheme={s.uiScheme || 'light'} data-msg-style={s.msgStyle || 'terminal'} data-message-layout={s.messageLayout || 'classic'} data-footer-layout={s.footerLayout || 'free'} data-cli-overflow-mode={s.cliOverflowMode || 'fixed-scroll'} style={cssVars}>
      <WorkspaceTitlebar
        sheets={workspaceSheets.sheets}
        activeSheetId={workspaceSheets.activeSheetId}
        activeAgent={activeAgent}
        agentStatuses={agentStatuses}
        sidebarCollapsed={sidebarCollapsed}
        canReopenSheet={workspaceSheets.recentlyClosed.length > 0}
        onToggleSidebar={() => setSidebarCollapsed(value => !value)}
        onFocusSheet={id => useStore.getState().focusSheet(id)}
        onCloseSheet={id => useStore.getState().closeSheet(id)}
        menuActions={{
          onTogglePin: id => useStore.getState().toggleSheetPin(id),
          onClose: id => useStore.getState().closeSheet(id),
          onCloseOthers: id => useStore.getState().closeOtherSheets(id),
          onCloseRight: id => useStore.getState().closeRightSheets(id),
          onReopen: () => useStore.getState().reopenSheet(),
        }}
        onOpenSheet={() => setShowSheetLauncher(true)}
        onReopenSheet={() => useStore.getState().reopenSheet()}
        onToggleRightPanel={() => setRightOpen(value => !value)}
        onToggleSettings={() => setShowSettings(value => !value)}
        onMinimize={() => appWindow.minimize()}
        onToggleFullscreen={() => appWindow.isFullscreen().then(fullscreen => appWindow.setFullscreen(!fullscreen))}
        onCloseWindow={() => appWindow.destroy()}
      />
      <SheetLauncher
        open={showSheetLauncher}
        agents={agents}
        sheets={workspaceSheets.sheets}
        onOpenChange={setShowSheetLauncher}
        onFocusSheet={id => useStore.getState().focusSheet(id)}
        onOpenSheet={(kind, title, agentId) => useStore.getState().openSheet({ kind, title, agentId })}
        onOpenSettings={() => setShowSettings(true)}
        onOpenProfiles={() => setShowProfileEdit(true)}
      />

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
        {settingsOpen && <Settings activeSessionId={activeSession} onClose={() => setShowSettings(false)} />}
        {rightOpen && <RightPanel sessionId={activeSession} onClose={() => setRightOpen(false)} />}
        {profilesOpen && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
        {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
      </div>
    </div>
  )
}
