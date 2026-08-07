import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { X } from 'lucide-react'
import { reportRuntimeError } from '../../runtimeError'
import { createWorkspaceClient } from '../../infrastructure/tauri/workspaceClient'
import { classifyGitError, normalizeGitStatus, type GitStatusEntry } from '../../infrastructure/tauri/gitContracts.ts'
import { useWorkspaceStore } from '../../workspaceStore'
import FileTypeIcon from './FileTypeIcon'

/** ViewsPanel — FileSheet 的 change/diff 工作面，和 SCM 的 Git 总览职责分离。 */
export default function ViewsPanel({ source, activeDiff, onOpenDiff, onCloseDiff }: {
  source: string | null
  activeDiff: { path: string; staged: boolean } | null
  onOpenDiff: (path: string, staged: boolean) => void
  onCloseDiff: () => void
}) {
  const [entries, setEntries] = useState<GitStatusEntry[]>([])
  const [error, setError] = useState('')
  const touchedFilesRecord = useWorkspaceStore(s => s.touchedFiles)
  const touchedFiles = useMemo(() => source ? touchedFilesRecord[source] ?? [] : [], [source, touchedFilesRecord])

  useEffect(() => {
    if (!source) return
    let disposed = false
    createWorkspaceClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).gitStatus(source).then(raw => {
      if (!disposed) setEntries(normalizeGitStatus(raw))
    }).catch(err => {
      if (disposed) return
      setError(classifyGitError(err).message)
      reportRuntimeError('读取 Git 变更', err)
    })
    return () => { disposed = true }
  }, [source])

  return (
    <div className="file-section-panel file-views-panel">
      <section className="file-view-section">
        <div className="file-panel-heading"><span>CHANGES / DIFF</span><span className="file-panel-count">{entries.length}</span></div>
        {!source && <p className="file-section-hint">选择会话后查看改动</p>}
        {error && <div className="file-tree-error" role="alert">{error}</div>}
        {source && entries.length === 0 && !error && <p className="file-section-hint file-section-muted">工作区没有 Git 变更</p>}
        <ul className="file-view-list">
          {entries.map(entry => {
            const active = activeDiff?.path === entry.path && activeDiff.staged === entry.staged
            return (
              <li key={`${entry.staged}-${entry.path}`}>
                <button type="button" className={`file-view-row ${active ? 'active' : ''}`} onClick={() => onOpenDiff(entry.path, entry.staged)} title={`打开 ${entry.path} diff`}>
                  <FileTypeIcon path={entry.path} size={14} />
                  <span className="file-view-path">{entry.path}</span>
                  <span className="git-status-code">{entry.status.trim() || '·'}</span>
                </button>
              </li>
            )
          })}
        </ul>
        {activeDiff && (
          <button type="button" className="file-view-close" onClick={onCloseDiff}>
            <X size={13} /> 关闭当前 diff
          </button>
        )}
      </section>

      <section className="file-view-section">
        <div className="file-panel-heading"><span>AGENT CHANGES</span><span className="file-panel-count">{touchedFiles.length}</span></div>
        {touchedFiles.length === 0 ? <p className="file-section-hint file-section-muted">Agent 尚未修改文件</p> : (
          <ul className="file-view-list">
            {touchedFiles.slice().reverse().map(file => (
              <li key={`${file.path}:${file.at}`} className="file-agent-change-row">
                <FileTypeIcon path={file.path} size={14} />
                <span className="file-view-path" title={file.path}>{file.path}</span>
                <small>{file.toolKind}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
