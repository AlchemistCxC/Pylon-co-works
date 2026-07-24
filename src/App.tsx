import { useState, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import ChatView from './components/chat/ChatView'
import InputBar from './components/chat/InputBar'
import StatusBar from './components/chat/StatusBar'
import RightPanel from './components/RightPanel'
import { useStore } from './store'
import './App.css'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const theme = useStore()

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
          <button onClick={() => (window as any).__TAURI__?.window?.minimize()}>─</button>
          <button onClick={() => (window as any).__TAURI__?.window?.toggleMaximize()}>⛶</button>
          <button className="close" onClick={() => (window as any).__TAURI__?.window?.close()}>✕</button>
        </div>
      </div>

      <div className="layout">
        <Sidebar activeSession={activeSession} onSelectSession={setActiveSession} />
        <div className="main">
          {showSettings ? <Settings /> : <>
            <div className="tabbar">
              <button className="tab active">Peri</button>
              <button className="tab">Prism</button>
            </div>
            <div className="main-body">
              <ChatView sessionId={activeSession} />
              <div className="bottom-area">
                <InputBar sessionId={activeSession} />
                <StatusBar ekgGreen={theme.ekgGreen} ekgYellow={theme.ekgYellow} ekgRed={theme.ekgRed} />
              </div>
            </div>
          </>}
        </div>
        {rightOpen && (
          <aside className="right-panel">
            <div className="right-header">
              <span>Panel</span>
              <button onClick={() => setRightOpen(false)}>✕</button>
            </div>
            <div className="right-body">
              <div className="right-placeholder">预留区域</div>
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
