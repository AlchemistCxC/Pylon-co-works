import { Clock3, Files, GitBranch, MessageSquare, Search, X } from 'lucide-react'
import { useIdentityStore } from '../../identityStore'
import { FILE_SHEET_SECTIONS, type FileSheetSection } from './fileSheetState.ts'

/** FileSheetSidebar — 48px Activity Bar + Explorer 内容面板；支持收成仅图标栏。 */
export default function FileSheetSidebar({
  activeSection,
  targetSource,
  collapsed,
  hidden,
  onSelectSection,
  onSelectSource,
  onCollapse,
  children,
}: {
  activeSection: FileSheetSection
  targetSource: string | null
  collapsed: boolean
  hidden: boolean
  onSelectSection: (section: FileSheetSection) => void
  onSelectSource: (source: string | null) => void
  onCollapse: () => void
  children?: React.ReactNode
}) {
  const sessions = useIdentityStore(s => s.sessions)
  const labels: Record<FileSheetSection, string> = {
    sessions: '会话',
    files: '文件',
    search: '搜索',
    scm: 'SCM',
    views: '视图',
  }
  const activityMeta: Record<FileSheetSection, { icon: React.ReactNode; description: string }> = {
    sessions: { icon: <MessageSquare size={21} />, description: '切换工作区会话' },
    files: { icon: <Files size={21} />, description: '浏览工作区文件' },
    search: { icon: <Search size={21} />, description: '搜索工作区内容' },
    scm: { icon: <GitBranch size={21} />, description: '查看完整 Git 状态和历史' },
    views: { icon: <Clock3 size={21} />, description: '查看 Agent 最近触碰文件' },
  }

  const selectSection = (section: FileSheetSection) => {
    onSelectSection(section)
    if (collapsed) onCollapse()
  }

  return (
    <aside className={`file-sidebar ${collapsed ? 'collapsed' : ''} ${hidden ? 'hidden' : ''}`}>
      <nav className="file-activity-bar" aria-label="FileSheet 分区">
        {FILE_SHEET_SECTIONS.map(section => (
          <button
            key={section}
            type="button"
            className={`file-activity-item ${activeSection === section ? 'active' : ''}`}
            onClick={() => selectSection(section)}
            title={`${labels[section]}：${activityMeta[section].description}`}
            aria-label={`${labels[section]}：${activityMeta[section].description}`}
          >
            <span className="file-activity-icon" aria-hidden="true">{activityMeta[section].icon}</span>
          </button>
        ))}
      </nav>

      {!collapsed && (
        <div className="file-sidebar-panel">
          <header className="file-sidebar-header">
            <div>
              <span className="file-sidebar-kicker">{labels[activeSection]}</span>
              <strong>{activityMeta[activeSection].description}</strong>
            </div>
            <button type="button" className="file-sidebar-close" onClick={onCollapse} title="收起左栏" aria-label="收起左栏">
              <X size={15} />
            </button>
          </header>

          {activeSection === 'sessions' ? (
            <div className="file-section-panel file-session-panel">
              <div className="file-panel-heading">
                <span>WORKSPACES</span>
                <span className="file-panel-count">{sessions.length}</span>
                {targetSource && <button type="button" className="file-source-clear" onClick={() => onSelectSource(null)}>清除选择</button>}
              </div>
              {sessions.length === 0 ? (
                <p className="file-section-hint">没有可用会话</p>
              ) : (
                <ul className="file-source-list">
                  {sessions.map(session => (
                    <li key={session.id}>
                      <button
                        type="button"
                        className={`file-source-item ${targetSource === session.source ? 'active' : ''}`}
                        onClick={() => onSelectSource(session.source)}
                        title={session.source}
                      >
                        <span className="file-source-icon" aria-hidden="true"><MessageSquare size={15} /></span>
                        <span className="file-source-copy">
                          <strong>{session.name}</strong>
                          <small>{session.source}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="file-section-content">{children}</div>
          )}
        </div>
      )}
    </aside>
  )
}
