import { useState, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import ChatView from './components/chat/ChatView'
import InputBar from './components/chat/InputBar'
import StatusBar from './components/chat/StatusBar'
import RightPanel from './components/RightPanel'
import Settings from './components/Settings'
import { useStore } from './store'
import './App.css'

import ProfileEditor from './components/ProfileEditor'

import PrismSheet from './components/PrismSheet'

import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [showProfileEdit, setShowProfileEdit] = useState(false)
  const [activeTab, setActiveTab] = useState<'peri' | 'prism'>('peri')
  const theme = useStore()
  const appWindow = getCurrentWindow()

  const cssVars = useMemo(() => ({
    '--t': theme.transparency,
    '--blur': `${theme.bgBlur}px`,
    '--global-bg-image': theme.globalBgImage ? `url(${theme.globalBgImage})` : 'none',
    '--global-font': theme.globalFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--global-font-size': `${theme.globalFontSize}px`,
    // sidebar
    '--sidebar-bg': theme.sidebarBg,
    '--sidebar-bg-image': theme.sidebarBgImage ? `url(${theme.sidebarBgImage})` : 'none',
    '--sidebar-width': `${theme.sidebarWidth}px`,
    '--sidebar-text': theme.sidebarTextColor,
    '--sidebar-name-size': `${theme.sidebarNameSize}px`,
    '--sidebar-group-size': `${theme.sidebarGroupSize}px`,
    // chat
    '--chat-bg': theme.chatBg,
    '--chat-bg-image': theme.chatBgImage ? `url(${theme.chatBgImage})` : 'none',
    '--chat-font': theme.chatFont === 'mono' ? 'var(--mono)' : 'var(--font)',
    '--chat-font-size': `${theme.chatFontSize}px`,
    '--chat-line-height': theme.chatLineHeight,
    '--chat-text': theme.chatTextColor,
    '--chat-code-color': theme.chatCodeColor,
    '--chat-code-bg': theme.chatCodeBg,
    // tools
    '--tool-ok': theme.toolOk,
    '--tool-run': theme.toolRun,
    '--tool-err': theme.toolErr,
    '--tool-name': theme.toolNameColor,
    '--tool-summary': theme.toolSummaryColor,
    '--user-tag-bg': theme.userTagBg,
    '--user-tag-text': theme.userTagText,
    // input
    '--input-bg': theme.inputBg,
    '--input-bg-image': theme.inputBgImage ? `url(${theme.inputBgImage})` : 'none',
    '--input-text': theme.inputTextColor,
    '--input-placeholder': theme.inputPlaceholder,
    '--input-send': theme.inputSendBg,
    '--input-focus': theme.inputFocusBorder,
    '--input-font-size': `${theme.inputFontSize}px`,
    '--input-min-h': `${theme.inputMinHeight}px`,
    // status
    '--status-bg': theme.statusBg,
    '--status-bg-image': theme.statusBgImage ? `url(${theme.statusBgImage})` : 'none',
    '--ekg-w': `${theme.ekgWidth}px`,
    '--ekg-font': `${theme.ekgFontSize}px`,
    '--ekg-green': theme.ekgGreen,
    '--ekg-yellow': theme.ekgYellow,
    '--ekg-red': theme.ekgRed,
    '--pill-bg': theme.pillBg,
    '--pill-text': theme.pillText,
    '--prism-on': theme.prismOnColor,
    // ekg style
    '--ekg-line-width': `${theme.ekgLineWidth}px`,
    '--ekg-amp-max': `${theme.ekgAmplitudeMax}px`,
    '--ekg-speed-base': theme.ekgSpeedBase,
    '--ekg-speed-max': theme.ekgSpeedMax,
    '--ekg-left': theme.ekgLeftColor,
    '--ekg-moving': theme.ekgMovingColor,
    '--ekg-consumed': theme.ekgConsumedColor,
    '--token-display': theme.tokenDisplay,
    // right
    '--right-bg': theme.rightBg,
    '--right-bg-image': theme.rightBgImage ? `url(${theme.rightBgImage})` : 'none',
    '--right-width': `${theme.rightWidth}px`,
  } as React.CSSProperties), [theme])

  return (
    <div className="app" style={cssVars}>
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-text">Prism Desktop</span>
        <div className="titlebar-controls">
          <button onClick={() => setRightOpen(!rightOpen)} title="Panel">&#9776;</button>
          <button onClick={() => setShowSettings(!showSettings)} title="Settings">&#9881;</button>
          <button onClick={() => appWindow.minimize()}>─</button>
          <button onClick={() => appWindow.toggleMaximize()}>⛶</button>
          <button className="close" onClick={() => appWindow.destroy()}>✕</button>
        </div>
      </div>

      <div className="layout">
        <Sidebar activeSession={activeSession} onSelectSession={setActiveSession} onProfileEdit={() => setShowProfileEdit(true)} />
        <div className="main">
          <div className="tabbar">
            <button className={`tab ${activeTab === 'peri' ? 'active' : ''}`} onClick={() => setActiveTab('peri')}>Peri</button>
            <button className={`tab ${activeTab === 'prism' ? 'active' : ''}`} onClick={() => setActiveTab('prism')}>Prism</button>
          </div>
          {showSettings ? <Settings /> : activeTab === 'prism' ? <PrismSheet /> : <>
            <div className="main-body">
              <ChatView sessionId={activeSession} />
              <div className="bottom-area">
                <InputBar sessionId={activeSession} />
                <StatusBar
                tokensUsed={theme.liveTokensUsed || 0}
                tokensMax={theme.liveTokensMax || 128}
                cacheHit={theme.liveCacheHit || 0}
                mode={theme.liveMode as any || 'auto'}
                prismOn={theme.livePrismOn}
                ekgGreen={theme.ekgGreen} ekgYellow={theme.ekgYellow} ekgRed={theme.ekgRed}
                onMode={(m) => {
                  useStore.getState().setLiveStats({ liveMode: m })
                  if (activeSession) invoke('set_mode', { source: activeSession, mode: m }).catch(() => {})
                }}
                onSelectModel={(m) => {
                  const p = useStore.getState().profiles.find(x => x.id === useStore.getState().activeProfileId)
                  if (p) useStore.getState().addProfile({ ...p, model: m })
                }}
                onCompact={() => {
                  if (activeSession) {
                    const persona = useStore.getState().profiles.find(
                      p => p.id === useStore.getState().activeProfileId
                    )?.persona || ''
                    invoke('send_message', { source: activeSession, content: '/compact', persona }).catch(() => {})
                  }
                }}
                onPrismToggle={() => {
                  useStore.getState().setLiveStats({
                    livePrismOn: !useStore.getState().livePrismOn
                  })
                }}
              />
              </div>
            </div>
          </>}
        </div>
        {rightOpen && <RightPanel onClose={() => setRightOpen(false)} />}
        {showProfileEdit && <ProfileEditor onClose={() => setShowProfileEdit(false)} />}
      </div>
    </div>
  )
}
