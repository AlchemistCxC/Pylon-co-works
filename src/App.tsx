import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import ChatView from './components/chat/ChatView'
import ControlCenter from './components/ControlCenter'
import RightPanel from './components/RightPanel'
import Settings from './components/Settings'
import ProfileEditor from './components/ProfileEditor'
import PrismSheet from './components/PrismSheet'
import SessionSettings from './components/SessionSettings'
import { useStore } from './store'
import { belongsToProfile } from './components/chat/sessionProfile'
import { useShallow } from 'zustand/react/shallow'
import './App.css'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [activeTab, setActiveTab] = useState<'peri' | 'prism'>('peri')
  const activeProfileId = useStore(s => s.activeProfileId)
  const sessions = useStore(s => s.sessions)

  useEffect(() => {
    const clearActiveSession = () => setActiveSession(null)
    window.addEventListener('pylon:agent-switched', clearActiveSession)
    return () => window.removeEventListener('pylon:agent-switched', clearActiveSession)
  }, [])

  useEffect(() => {
    if (!belongsToProfile(activeSession, activeProfileId, sessions)) setActiveSession(null)
  }, [activeProfileId, activeSession, sessions])

  useEffect(() => {
    invoke('list_agents').then((list: any) => {
      useStore.getState().setAgents(list)
    }).catch(() => {})
  }, [])

  const activeAgent = useStore(s => s.activeAgent) || 'peri'
  const agentLabel = activeAgent.charAt(0).toUpperCase() + activeAgent.slice(1)

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
    toolOk: s.toolOk, toolRun: s.toolRun, toolErr: s.toolErr,
    toolNameColor: s.toolNameColor, toolSummaryColor: s.toolSummaryColor,
    userTagBg: s.userTagBg, userTagText: s.userTagText,
    inputBg: s.inputBg, inputBgImage: s.inputBgImage,
    inputTextColor: s.inputTextColor, inputPlaceholder: s.inputPlaceholder,
    inputSendBg: s.inputSendBg, inputFocusBorder: s.inputFocusBorder,
    inputFontSize: s.inputFontSize, inputMinHeight: s.inputMinHeight,
    cliLineWidth: s.cliLineWidth, cliLineColor: s.cliLineColor, cliTextColor: s.cliTextColor, cliLinePadding: s.cliLinePadding,
    statusBg: s.statusBg, statusBgImage: s.statusBgImage,
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
    '--global-bg-image': s.globalBgImage ? `url(${s.globalBgImage})` : 'none',
    '--global-bg-color': (s as any).globalBgColor || '#e8e8ec',
    '--global-font': s.globalFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--global-font-size': `${s.globalFontSize}px`,
    '--sidebar-bg': s.sidebarBg,
    '--sidebar-bg-image': s.sidebarBgImage ? `url(${s.sidebarBgImage})` : 'none',
    '--sidebar-width': `${s.sidebarWidth}px`,
    '--sidebar-transparency': s.sidebarTransparency,
    '--sidebar-blur': `${s.sidebarBlur}px`,
    '--sidebar-text': s.sidebarTextColor,
    '--sidebar-name-size': `${s.sidebarNameSize}px`,
    '--sidebar-group-size': `${s.sidebarGroupSize}px`,
    '--chat-bg': s.chatBg,
    '--chat-bg-image': s.chatBgImage ? `url(${s.chatBgImage})` : 'none',
    '--chat-transparency': s.chatTransparency,
    '--chat-blur': `${s.chatBlur}px`,
    '--chat-font': s.chatFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--chat-font-size': `${s.chatFontSize}px`,
    '--chat-line-height': s.chatLineHeight,
    '--chat-text': s.chatTextColor,
    '--chat-code-color': s.chatCodeColor,
    '--chat-code-bg': s.chatCodeBg,
    '--tool-ok': s.toolOk, '--tool-run': s.toolRun, '--tool-err': s.toolErr,
    '--tool-name': s.toolNameColor, '--tool-summary': s.toolSummaryColor,
    '--user-tag-bg': s.userTagBg, '--user-tag-text': s.userTagText,
    '--input-bg': s.inputBg,
    '--input-bg-image': s.inputBgImage ? `url(${s.inputBgImage})` : 'none',
    '--input-text': s.inputTextColor, '--input-placeholder': s.inputPlaceholder,
    '--input-send': s.inputSendBg, '--input-focus': s.inputFocusBorder,
    '--input-font-size': `${s.inputFontSize}px`, '--input-min-h': `${s.inputMinHeight}px`,
    '--cli-line-width': `${s.cliLineWidth}px`,
    '--cli-line-color': s.cliLineColor || undefined,
    '--cli-text-color': s.cliTextColor || undefined,
    '--cli-line-padding': `${s.cliLinePadding ?? 6}px`,
    '--status-bg': s.statusBg,
    '--status-bg-image': s.statusBgImage ? `url(${s.statusBgImage})` : 'none',
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
    '--right-bg-image': s.rightBgImage ? `url(${s.rightBgImage})` : 'none',
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
    root.style.setProperty('--global-bg-image', s.globalBgImage ? `url(${s.globalBgImage})` : 'none')
    root.style.setProperty('--t', String(s.transparency))
    root.style.setProperty('--blur', `${s.bgBlur}px`)
    document.body.dataset.uiScheme = s.uiScheme || 'light'
  }, [s.globalBgColor, s.globalBgImage, s.transparency, s.bgBlur, s.uiScheme])

  const appWindow = (() => { try { return getCurrentWindow() } catch { return { minimize() {}, isFullscreen() { return Promise.resolve(false) }, setFullscreen(_v: boolean) { return Promise.resolve() }, destroy() {} } } })()

  return (
    <div className="app" data-ui-scheme={s.uiScheme || 'light'} style={cssVars}>
      <div className="titlebar" data-tauri-drag-region>
        <button className="titlebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? '展开左栏' : '收起左栏'}>☰</button>
        <div className="titlebar-tabs">
          <button className={`tab ${activeTab === 'peri' ? 'active' : ''}`} onClick={() => setActiveTab('peri')}>{agentLabel}</button>
          <button className={`tab ${activeTab === 'prism' ? 'active' : ''}`} onClick={() => setActiveTab('prism')}>Prism</button>
        </div>
        <div className="titlebar-spacer" />
        <div className="titlebar-controls">
          <button onClick={() => setRightOpen(!rightOpen)} title="Panel">&#9776;</button>
          <button onClick={() => setShowSettings(!showSettings)} title="Settings">&#9881;</button>
          <button onClick={() => appWindow.minimize()}>─</button>
          <button onClick={() => appWindow.isFullscreen().then(f => appWindow.setFullscreen(!f))}>⛶</button>
          <button className="close" onClick={() => appWindow.destroy()}>✕</button>
        </div>
      </div>

      <div className={`layout ${ccEditMode ? 'cc-editing-app' : ''}`}>
        <Sidebar activeSession={activeSession} onSelectSession={setActiveSession} onProfileEdit={() => setShowProfileEdit(true)} onSessionSettings={setSessionSettingsId} collapsed={sidebarCollapsed} />
        <div className="main">
          <div style={{ display: activeTab === 'prism' ? 'flex' : 'none' }}><PrismSheet /></div>
          <div className={`main-body ${ccEditMode ? 'blur-bg' : ''}`} style={{ display: activeTab === 'prism' ? 'none' : 'flex' }}>
            <ChatView sessionId={activeSession} />
            <ControlCenter sessionId={activeSession} />
          </div>
          {ccEditMode && <div className="cc-edit-overlay" />}
        </div>
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
        {rightOpen && <RightPanel onClose={() => setRightOpen(false)} />}
        {showProfileEdit && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
        {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
      </div>
    </div>
  )
}
