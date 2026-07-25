import { useState, useEffect } from 'react'
import ErrorBoundary from './components/ErrorBoundary'
import Sidebar from './components/Sidebar'
import ChatView from './components/chat/ChatView'
import ControlCenter from './components/ControlCenter'
import RightPanel from './components/RightPanel'
import Settings from './components/Settings'
import { useStore } from './store'
import './App.css'

import ProfileEditor from './components/ProfileEditor'

import PrismSheet from './components/PrismSheet'
import SessionSettings from './components/SessionSettings'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [sessionSettingsId, setSessionSettingsId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  useEffect(() => {
    invoke('list_agents').then((list: any) => {
      useStore.getState().setAgents(list)
    }).catch(() => {})
  }, [])

  const [activeTab, setActiveTab] = useState<'peri' | 'prism'>('peri')
  const activeAgent = useStore(s => s.activeAgent) || 'peri'
  const agentLabel = activeAgent.charAt(0).toUpperCase() + activeAgent.slice(1)
  // P1: select only cssVars fields, not sessions/profiles/agents/live*
  const cssVars = useStore(s => ({
    '--t': s.transparency,
    '--blur': `${s.bgBlur}px`,
    '--global-bg-image': s.globalBgImage ? `url(${s.globalBgImage})` : 'none',
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
    '--right-bg': s.rightBg,
    '--right-bg-image': s.rightBgImage ? `url(${s.rightBgImage})` : 'none',
    '--right-width': `${s.rightWidth}px`,
    '--right-transparency': s.rightTransparency,
    '--right-blur': `${s.rightBlur}px`,
  } as React.CSSProperties))
  const appWindow = getCurrentWindow()

  return (
    <ErrorBoundary>
    <div className="app" style={cssVars}>
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

      <div className="layout">
        <Sidebar activeSession={activeSession} onSelectSession={setActiveSession} onProfileEdit={() => setShowProfileEdit(true)} onSessionSettings={setSessionSettingsId} collapsed={sidebarCollapsed} />
        <div className="main">
          {activeTab === 'prism' ? <PrismSheet /> : <>
            <div className="main-body">
              <ChatView sessionId={activeSession} />
              <ControlCenter sessionId={activeSession} />
            </div>
          </>}
        </div>
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
        {rightOpen && <RightPanel onClose={() => setRightOpen(false)} />}
        {showProfileEdit && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
        {sessionSettingsId && <SessionSettings sessionId={sessionSettingsId} open={!!sessionSettingsId} onClose={() => setSessionSettingsId(null)} onDeleted={() => setActiveSession(null)} />}
      </div>
    </div>
    </ErrorBoundary>
  )
}
