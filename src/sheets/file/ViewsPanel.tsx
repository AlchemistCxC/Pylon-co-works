import { useMemo } from 'react'
import { useWorkspaceStore } from '../../workspaceStore'
import FileTypeIcon from './FileTypeIcon'

/** 触碰时间格式化（HH:MM；可测） */
export function formatTouchTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * ViewsPanel — FileSheet 的 Agent 文件活动工作面（ISSUE-08 D-04）。
 * 只消费 workspaceStore.touchedFiles[source]，不维护任何 Git 状态（SCM 独占 Git，见 GitPanel）。
 * 点击触碰文件 → onOpenFile(path) 进入统一文件 tab 的普通视图（不创建 diff 主视图）。
 */
export default function ViewsPanel({ source, onOpenFile }: {
  source: string | null
  onOpenFile: (path: string) => void
}) {
  const touchedFilesRecord = useWorkspaceStore(s => s.touchedFiles)
  const touchedFiles = useMemo(() => source ? touchedFilesRecord[source] ?? [] : [], [source, touchedFilesRecord])

  return (
    <div className="file-section-panel file-views-panel">
      <section className="file-view-section">
        <div className="file-panel-heading"><span>AGENT CHANGES</span><span className="file-panel-count">{touchedFiles.length}</span></div>
        {!source && <p className="file-section-hint">选择会话后查看 Agent 改动</p>}
        {source && touchedFiles.length === 0 && <p className="file-section-hint file-section-muted">Agent 尚未修改文件</p>}
        {touchedFiles.length > 0 && (
          <ul className="file-view-list">
            {touchedFiles.slice().reverse().map(file => (
              <li key={`${file.path}:${file.at}`}>
                <button type="button" className="file-view-row" onClick={() => onOpenFile(file.path)} title={`打开 ${file.path}`}>
                  <FileTypeIcon path={file.path} size={14} />
                  <span className="file-view-path">{file.path}</span>
                  <small>{file.toolKind}</small>
                  <span className="file-view-time">{formatTouchTime(file.at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
