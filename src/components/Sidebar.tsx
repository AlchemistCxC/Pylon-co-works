import { useState, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../store'
import { formatTime } from '../utils'
import './Sidebar.css'

const PLATFORM_LABELS: Record<string, string> = { local: '本地', 'qq-group': 'QQ 群聊', 'qq-dm': 'QQ 私聊', terminal: '终端' }

interface Props {
  activeSession: string | null
  onSelectSession: (id: string | null) => void
  onProfileEdit: () => void
  onSessionSettings: (id: string) => void
  collapsed: boolean
}

export default function Sidebar({ activeSession, onSelectSession, onProfileEdit, onSessionSettings, collapsed }: Props) {
  const [search, setSearch] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const profiles = useStore(s => s.profiles)
  const activeProfileId = useStore(s => s.activeProfileId)
  const setActiveProfile = useStore(s => s.setActiveProfile)
  const sessions = useStore(s => s.sessions)
  const addSession = useStore(s => s.addSession)
  const removeSession = useStore(s => s.removeSession)
  const updateSession = useStore(s => s.updateSession)
  const activeProfile = profiles.find(p => p.id === activeProfileId)

  const profileSessions = sessions.filter(s => s.profileId === activeProfileId)

  const groups = useMemo(() => {
    const map = new Map<string, typeof profileSessions>()
    profileSessions.forEach(s => {
      const label = PLATFORM_LABELS[s.platform] || s.platform || '其他'
      if (!map.has(label)) map.set(label, [])
      map.get(label)!.push(s)
    })
    return map
  }, [profileSessions])

  const filteredGroups = search
    ? [...groups].filter(([,items]) => items.some(s => s.name.toLowerCase().includes(search.toLowerCase())))
    : [...groups]

  const newSession = () => addSession(`session-${Date.now().toString(36)}`)

  const handleSelect = (id: string) => {
    onSelectSession(id)
  }

  const handleDelete = (id: string) => {
    if (!window.confirm('删除会话？')) return
    // 通知后端释放 session 资源（ThreadStore / cancel tokens），避免后端 session 泄漏（上限 100）
    // best-effort：不 await、失败不阻塞前端删除（后端 remove_session 找不到会返 Err，被吞掉）
    const s = sessions.find(x => x.id === id)
    if (s) {
      invoke('close_session', { source: s.source }).catch(() => {})
      // 清理该会话的前端配置残留
      const cfg = { ...useStore.getState().sessionConfig }
      if (cfg[s.source]) { delete cfg[s.source]; useStore.setState({ sessionConfig: cfg }) }
    }
    removeSession(id)
    localStorage.removeItem('pylon-msgs-' + id)
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
