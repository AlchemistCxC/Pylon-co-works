import { useStore } from '../store'
import './Sidebar.css'

interface Props { activeSession: string | null; onSelectSession: (id: string | null) => void }

export default function Sidebar({ activeSession, onSelectSession }: Props) {
  const { sessions, profiles, activeProfileId, setActiveProfile } = useStore()
  const groups = {
    'QQ 群聊': sessions.filter(s => s.platform === 'qq-group'),
    'QQ 私聊': sessions.filter(s => s.platform === 'qq-dm'),
    '终端': sessions.filter(s => s.platform === 'terminal'),
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <input className="search-input" placeholder="Search..." />
        <div className="sidebar-actions">
          <button title="Sort">&#8597;</button>
          <button title="Compact all">&#9681;</button>
        </div>
      </div>
      <div className="session-list">
        {Object.entries(groups).map(([name, items]) => (
          <details key={name} className="session-group" open>
            <summary className="group-header"><span>{name}</span></summary>
            {items.map(s => (
              <div key={s.source} className={`session-item ${activeSession === s.source ? 'active' : ''}`}
                onClick={() => onSelectSession(s.source)}>
                <div className="session-dot" />
                <div className="session-info">
                  <div className="session-name">{s.name}</div>
                  <div className="session-meta">{s.msgCount} msg · {s.lastActive}</div>
                </div>
              </div>
            ))}
          </details>
        ))}
      </div>
      <div className="profile-bar">
        {profiles.map(p => (
          <button key={p.id} className={`profile-avatar ${p.id === activeProfileId ? 'active' : ''}`}
            onClick={() => setActiveProfile(p.id)} title={p.name}>
            {p.avatar ? <img src={p.avatar} alt={p.name} /> : p.name[0]}
          </button>
        ))}
        <button className="profile-avatar add" title="New Profile">+</button>
      </div>
    </aside>
  )
}
