import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import './Sidebar.css'

interface Props {
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
}

export default function Sidebar({ activeSession, onSelectSession, onProfileEdit }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [search, setSearch] = useState('')
  const profiles = useStore(s => s.profiles)
  const activeProfileId = useStore(s => s.activeProfileId)
  const setActiveProfile = useStore(s => s.setActiveProfile)
  const sessions = useStore(s => s.sessions)
  const addSession = useStore(s => s.addSession)
  const removeSession = useStore(s => s.removeSession)
  const setSessionPeriId = useStore(s => s.setSessionPeriId)
  const activeProfile = profiles.find(p => p.id === activeProfileId)

  // Filter sessions by active profile
  const profileSessions = sessions.filter(s => s.profileId === activeProfileId)

  // Group sessions by source
  const groups = new Map<string, typeof profileSessions>()
  profileSessions.forEach(s => {
    const key = s.source.replace(/^local:/, '本地').replace(/^qq:group:/, 'QQ群 ').replace(/^qq:user:/, 'QQ私聊 ')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  })

  const filteredGroups = search
    ? [...groups].filter(([,items]) => items.some(s => s.name.toLowerCase().includes(search.toLowerCase())))
    : [...groups]

  const newSession = () => addSession(`session-${Date.now().toString(36)}`)

  const handleSelect = async (id: string) => {
    onSelectSession(id)
    // Auto-create Peri session if not yet created
    const s = sessions.find(x => x.id === id)
    if (s && !s.periId && activeProfile) {
      try {
        const periId = await invoke<string>('new_session', { source: id, persona: activeProfile.persona })
        setSessionPeriId(id, periId)
      } catch (e) {
        console.error('create session failed:', e)
      }
    }
  }

  const handleDelete = (id: string) => {
    removeSession(id)
    if (activeSession === id) onSelectSession(null)
  }

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        {!collapsed && <input className="search-input" placeholder="搜索会话..." value={search} onChange={e => setSearch(e.target.value)} />}
        <button className="sidebar-action" onClick={newSession} title="New Session">+</button>
        <button className="sidebar-action" onClick={() => setCollapsed(!collapsed)} title={collapsed ? '展开' : '收起'}>
          {collapsed ? '\u25b8' : '\u25be'}
        </button>
      </div>
      {!collapsed && (
        <div className="session-list">
          {filteredGroups.map(([group, items]) => (
            <details key={group} className="session-group" open>
              <summary className="group-header">{group}</summary>
              {items.map(s => (
                <div key={s.id} className={`session-item ${activeSession === s.id ? 'active' : ''}`}
                  onClick={() => handleSelect(s.id)}>
                  <span className="session-dot" style={s.periId ? { background: 'var(--tool-ok,#1e9646)' } : {}} />
                  <div className="session-info">
                    <div className="session-name">{s.name}</div>
                    <div className="session-meta">{s.source.replace(/^.*:/, '')}</div>
                  </div>
                  <button className="session-del" onClick={e => { e.stopPropagation(); handleDelete(s.id) }}>\u2715</button>
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
        <button className="profile-edit" title="Edit Profile" onClick={onProfileEdit}>\u270e</button>
      </div>
    </aside>
  )
}
