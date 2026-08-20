import { Clock3, Files, GitBranch, MessageSquare, Search } from 'lucide-react'
import type { FileActivityContribution } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/** FileSheetSidebar — 固定宽度轨道；折叠只隐藏 Explorer 内容，Activity Bar 保持可用。 */
export default function FileSheetSidebar({
  activeSection,
  activities,
  collapsed,
  onSelectSection,
  children,
}: {
  activeSection: string
  activities: readonly FileActivityContribution[]
  collapsed: boolean
  onSelectSection: (section: string) => void
  children?: React.ReactNode
}) {
  const icons: Record<FileActivityContribution['icon'], React.ReactNode> = {
    sessions: <MessageSquare size={21} />,
    files: <Files size={21} />,
    search: <Search size={21} />,
    scm: <GitBranch size={21} />,
    views: <Clock3 size={21} />,
  }
  const selected = activities.find(activity => activity.id === activeSection) ?? activities[0]

  // I09-A-FE-02：折叠由 titlebar 统一控制（ctx.sidebarCollapsed），点击分区图标不再触发展开/收起
  const selectSection = (section: string) => {
    onSelectSection(section)
  }

  return (
    <aside className={`file-sidebar ${collapsed ? 'collapsed' : ''}`}>
      <nav className="file-activity-bar" aria-label="FileSheet 分区">
        {activities.map(activity => (
          <button
            key={activity.id}
            type="button"
            className={`file-activity-item ${activeSection === activity.id ? 'active' : ''}`}
            onClick={() => selectSection(activity.id)}
            title={`${activity.label}：${activity.description}`}
            aria-label={`${activity.label}：${activity.description}`}
          >
            <span className="file-activity-icon" aria-hidden="true">{icons[activity.icon]}</span>
          </button>
        ))}
      </nav>

      {!collapsed && (
        <div className="file-sidebar-panel">
          <header className="file-sidebar-header">
            <div>
              <span className="file-sidebar-kicker">{selected?.label ?? '能力不可用'}</span>
              <strong>{selected?.description ?? '插件已停用，请选择其他分区'}</strong>
            </div>
          </header>

          <div className="file-section-content">{children}</div>
        </div>
      )}
    </aside>
  )
}
