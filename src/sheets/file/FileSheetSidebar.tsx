import { useIdentityStore } from '../../identityStore'
import { FILE_SHEET_SECTIONS, type FileSheetSection } from './fileSheetState.ts'

/**
 * FileSheetSidebar — 48px 活动栏 + 分区内容面板（W2-03，VS Code 风格改造 D-08）。
 *
 * 左侧 48px 窄条五分区（会话/文件/搜索/SCM/视图）；会话分区列出当前 profile 的会话
 * 供切换 targetSource（内部指向，不改 singletonKey）；其余分区内容由 FileSheetView
 * 经 children 注入（文件树/SCM 状态/搜索——都在左栏），主区恒为文件视图。
 * 全局 sidebarWidth 面板由布局层（SheetSidebarSlot）承载——本分区栏独立窄条。
 */
export default function FileSheetSidebar({ activeSection, targetSource, onSelectSection, onSelectSource, children }: {
  activeSection: FileSheetSection
  targetSource: string | null
  onSelectSection: (section: FileSheetSection) => void
  onSelectSource: (source: string) => void
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
  return (
    <div className="file-sidebar">
      <div className="file-activity-bar">
        {FILE_SHEET_SECTIONS.map(section => (
          <button
            key={section}
            type="button"
            className={`file-activity-item ${activeSection === section ? 'active' : ''}`}
            onClick={() => onSelectSection(section)}
            title={labels[section]}
          >
            {labels[section]}
          </button>
        ))}
      </div>
      {activeSection === 'sessions' ? (
        <div className="file-section-panel">
          <div className="file-section-title">会话</div>
          {sessions.length === 0 ? (
            <p className="file-section-hint">没有会话</p>
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
                    {session.name}
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
  )
}
