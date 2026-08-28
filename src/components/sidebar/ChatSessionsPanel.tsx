import { useState } from 'react'
import { Archive, Download, Settings, Trash2 } from 'lucide-react'
import { formatTime } from '../../utils'
import type { AgentSidebarContributionProps } from '../../plugin-runtime/sidebar/sidebarTypes.ts'

export default function ChatSessionsPanel(props: AgentSidebarContributionProps) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const sessions = props.query
    ? props.sessions.filter(session => session.name.toLowerCase().includes(props.query.toLowerCase()))
    : props.sessions

  return (
    <section className="sidebar-section sidebar-mode-panel" aria-label="聊天会话">
      <div className="sidebar-section-head">
        <div className="sidebar-section-title">
          <span>聊天</span>
          <span className="sidebar-section-count">{sessions.length}</span>
        </div>
        <button className="sidebar-section-action" onClick={props.onCreateChatSession} title="新建聊天会话" aria-label="新建聊天会话">+</button>
      </div>
      <div className="session-list">
        {sessions.map(session => (
          <div key={session.id} className={`session-item ${props.activeSessionId === session.id ? 'active' : ''}`}
            onClick={() => props.onSelectSession(session.id)}
            onDoubleClick={event => { event.stopPropagation(); setRenaming(session.id); setRenameValue(session.name) }}>
            <span className="session-dot" data-running={props.liveGeneratingSources.includes(session.source) ? 'true' : undefined} />
            <div className="session-info">
              {renaming === session.id ? (
                <input className="session-rename-input" value={renameValue} autoFocus
                  onChange={event => setRenameValue(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && renameValue.trim()) { props.onRenameSession(session.id, renameValue.trim()); setRenaming(null) }
                    if (event.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={() => setRenaming(null)} onClick={event => event.stopPropagation()} />
              ) : <div className="session-name">{session.name}</div>}
              <div className="session-meta">{formatTime(session.lastReplyAt || session.lastActiveAt || session.createdAt)}</div>
            </div>
            <div className="session-actions">
              <button className="session-action" onClick={event => { event.stopPropagation(); props.onOpenSessionSettings(session.id) }} title="会话设置" aria-label={session.name + " 会话设置"}><Settings size={13} /></button>
              <button className="session-action" onClick={event => { event.stopPropagation(); void props.onExportSession?.(session.id) }} title="导出会话" aria-label={session.name + " 导出"}><Download size={13} /></button>
              <button className="session-action" onClick={event => { event.stopPropagation(); void props.onArchiveSession?.(session.id) }} title="归档会话" aria-label={session.name + " 归档"}><Archive size={13} /></button>
              <button className="session-action danger" onClick={event => { event.stopPropagation(); void props.onDeleteSession(session.id) }} title="删除会话" aria-label={"删除 " + session.name}><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {sessions.length === 0 && <div className="session-empty">暂无聊天会话</div>}
      </div>
    </section>
  )
}
