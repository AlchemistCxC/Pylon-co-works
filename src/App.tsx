import { useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatView from './components/chat/ChatView'
import InputBar from './components/chat/InputBar'
import StatusBar from './components/chat/StatusBar'
import './App.css'

export default function App() {
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [rightOpen, setRightOpen] = useState(false)

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <span className="titlebar-text">Prism Desktop</span>
        <div className="titlebar-controls">
          <button onClick={() => setRightOpen(!rightOpen)}>&#9776;</button>
          <button onClick={() => (window as any).__TAURI__?.window?.minimize()}>─</button>
          <button onClick={() => (window as any).__TAURI__?.window?.toggleMaximize()}>⛶</button>
          <button className="close" onClick={() => (window as any).__TAURI__?.window?.close()}>✕</button>
        </div>
      </div>

      <div className="layout">
        <Sidebar activeSession={activeSession} onSelectSession={setActiveSession} />

        <div className="main">
          <div className="tabbar">
            <button className="tab active">Peri</button>
            <button className="tab">Prism</button>
          </div>

          <div className="main-body">
            <ChatView sessionId={activeSession} />

            <div className="bottom-area">
              <StatusBar />
              <InputBar sessionId={activeSession} />
            </div>
          </div>
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
