import { useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore } from '../identityStore'
import { formatTime } from '../utils'
import { reportRuntimeError } from '../runtimeError'
import { runCloseSessionTransaction } from './chat/closeSessionTransaction'
import { clearMessageStorage } from './chat/messagePersistence'
import type { SheetContext } from '../workspace-sheets/sheetTypes'
import './Sidebar.css'

const PLATFORM_LABELS: Record<string, string> = { local: '本地', 'qq-group': 'QQ 群聊', 'qq-dm': 'QQ 私聊', terminal: '终端' }

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

  // filter 在 memo 内：sessions/activeProfileId 变化时才重算，避免每次渲染新数组引用让 memo 失效
  const groups = useMemo(() => {
    const profileSessions = sessions.filter(s => s.profileId === activeProfileId)
    const map = new Map<string, typeof profileSessions>()
    profileSessions.forEach(s => {
      const label = PLATFORM_LABELS[s.platform] || s.platform || '其他'
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push(s)
    })
    return map
  }, [sessions, activeProfileId])

  const filteredGroups = search
    ? [...groups].filter(([,items]) => items.some(s => s.name.toLowerCase().includes(search.toLowerCase())))
    : [...groups]

  const newSession = () => addSession(`session-${Date.now().toString(36)}`)

  const handleSelect = (id: string) => {
    onSelectSession(id)
  }

  const handleDelete = async (id: string) => {
    if (!window.confirm('删除会话？')) return
    const s = sessions.find(x => x.id === id)
    if (s) {
      const closed = await runCloseSessionTransaction({
        close: () => invoke('close_session', { source: s.source }),
        onSuccess: () => {},
        onError: error => reportRuntimeError('关闭会话', error),
      })
      if (!closed) return
    }
    removeSession(id)
    clearMessageStorage(id, localStorage)
    if (activeSession === id) onSelectSession(null)
  }

  const saveRename = (id: string) => {
    if (!renameValue.trim()) { setRenaming(null); return }
    updateSession(id, { name: renameValue.trim(), lastActiveAt: Date.now() })
    setRenaming(null)
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        {!collapsed && <input className="search-input" placeholder="搜索会话..." value={search} onChange={e => setSearch(e.target.value)} />}
        <button className="sidebar-action" onClick={newSession} title="New Session">+</button>
      </div>
      {!collapsed && (
        <div className="session-list">
          {filteredGroups.map(([group, items]) => (
            <details key={group} className="session-group" open>
              <summary className="group-header">{group}</summary>
              {items.map(s => (
                <div key={s.id} className={`session-item ${activeSession === s.id ? 'active' : ''}`}
                  onClick={() => handleSelect(s.id)}
                  onDoubleClick={(e) => { e.stopPropagation(); setRenaming(s.id); setRenameValue(s.name) }}>
                  <span className="session-dot" style={s.periId ? { background: 'var(--tool-ok,#1e9646)' } : {}} />
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
            </details>
          ))}
          {filteredGroups.length === 0 && (
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
      </div>
    </aside>
  )
}
