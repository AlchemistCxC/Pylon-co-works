import { useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { useWorkspaceStore } from '../workspaceStore'
import { agentStatusLight, type AgentLight } from '../domains/agent/statusLight.ts'
import { formatTime } from '../utils'
import { reportRuntimeError } from '../runtimeError'
import { createSessionClient } from '../infrastructure/acp/sessionClient'
import { removeSessionTransaction } from '../application/transactions/removeSessionTransaction'
import { clearMessageStorage } from './chat/messagePersistence'
import type { SheetContext } from '../workspace-sheets/sheetTypes'
import './Sidebar.css'

// W1-03：侧栏上移——props 收敛为 ctx（由布局层注入），内部行为原样
export default function Sidebar({ ctx }: { ctx: SheetContext }) {
  const { activeSession, selectSession: onSelectSession, openProfileEdit: onProfileEdit, openSessionSettings: onSessionSettings, sidebarCollapsed: collapsed } = ctx
  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const profiles = useIdentityStore(s => s.profiles)
  const activeProfileId = useIdentityStore(s => s.activeProfileId)
  const setActiveProfile = useIdentityStore(s => s.setActiveProfile)
  const sessions = useIdentityStore(s => s.sessions)
  const addSession = useIdentityStore(s => s.addSession)
  const removeSession = useIdentityStore(s => s.removeSession)
  const updateSession = useIdentityStore(s => s.updateSession)

  // W2-10（F2-C）：平铺 + 按 lastActiveAt 倒序（删平台分组）；运行点读 liveGeneratingSources
  const liveGeneratingSources = useRuntimeStore(s => s.liveGeneratingSources || [])
  // W2-11（S8）：agent 三色状态灯（异常可见装置）+ showPet toggle（workspaceStore 非主题）
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const agentStatus = useRuntimeStore(s => s.agentStatuses[activeAgent])
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)
  const lights: AgentLight[] = ['ok', 'warn', 'error']
  const activeLight = agentStatusLight(agentStatus?.status || '')
  const sortedSessions = useMemo(() => {
    return sessions
      .filter(s => s.profileId === activeProfileId)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  }, [sessions, activeProfileId])

  const filteredSessions = search
    ? sortedSessions.filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    : sortedSessions

  const newSession = () => addSession(`session-${Date.now().toString(36)}`)

  const handleSelect = (id: string) => {
    onSelectSession(id)
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除会话？')) return
    const sessionClient = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    const result = await removeSessionTransaction(id, {
      findSession: sessionId => sessions.find(s => s.id === sessionId),
      closeSession: source => sessionClient.closeSession(source),
      removeSession: sessionId => removeSession(sessionId),
      clearMessages: sessionId => clearMessageStorage(sessionId, localStorage),
      reportError: (action, error) => reportRuntimeError(action, error),
    })
    if (!result.ok) return
    if (activeSession === id) onSelectSession(null)
  }

  const saveRename = (id: string) => {
    if (!renameValue.trim()) { setRenaming(null); return }
    updateSession(id, { name: renameValue.trim(), lastActiveAt: Date.now() })
    setRenaming(null)
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-status-bar" aria-label="Agent 状态灯">
        {lights.map(light => (
          <span key={light} className={`sidebar-status-light sidebar-status-${light} ${activeLight === light ? 'active' : ''}`} />
        ))}
        {agentStatus?.status && <span className="sidebar-status-label">{agentStatus.status}</span>}
      </div>
      <div className="sidebar-header">
        {!collapsed && <input className="search-input" placeholder="搜索会话..." value={search} onChange={e => setSearch(e.target.value)} />}
        <button className="sidebar-action" onClick={newSession} title="New Session">+</button>
      </div>
      {!collapsed && (
        <div className="session-list">
          {filteredSessions.map(s => (
                <div key={s.id} className={`session-item ${activeSession === s.id ? 'active' : ''}`}
                  onClick={() => handleSelect(s.id)}
                  onDoubleClick={(e) => { e.stopPropagation(); setRenaming(s.id); setRenameValue(s.name) }}>
                  <span className="session-dot" data-running={liveGeneratingSources.includes(s.source) ? 'true' : undefined} />
                  <div className="session-info">
                    {renaming === s.id ? (
                      <input className="session-rename-input" value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveRename(s.id)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => setRenaming(null)}
                        autoFocus
                        onClick={e => e.stopPropagation()}
                      />
                    ) : (
                      <div className="session-name">{s.name}</div>
                    )}
                    <div className="session-meta">{formatTime(s.lastActiveAt || s.createdAt)}</div>
                  </div>
                  <button className="session-gear" onClick={e => { e.stopPropagation(); onSessionSettings(s.id) }} title="会话设置">⚙</button>
                  <button className="session-del" onClick={e => { e.stopPropagation(); handleDelete(s.id) }}>✕</button>
                </div>
              ))}
          {filteredSessions.length === 0 && (
            <div className="session-empty">无会话 — 点击 + 新建</div>
          )}
        </div>
      )}
      <div className="profile-bar">
        {profiles.map(p => (
          <button key={p.id} className={`profile-avatar ${p.id === activeProfileId ? 'active' : ''}`}
            onClick={() => setActiveProfile(p.id)}>
            {p.avatar ? <img src={p.avatar} alt={p.name} /> : p.name[0]}
          </button>
        ))}
        <button className="profile-edit" title="Edit Profile" onClick={onProfileEdit}>✎</button>
        <button className="profile-pet" title={showPet ? '隐藏宠物' : '显示宠物'} aria-pressed={showPet} onClick={() => setShowPet(!showPet)}>🐾</button>
      </div>
    </aside>
  )
}
