import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyGitError, normalizeGitStatus, type GitErrorDetail, type GitStatusEntry } from '../../infrastructure/tauri/gitContracts.ts'

/**
 * GitPanel — Git 分区（W2-05）。
 *
 * git_status 分 staged/unstaged（只读，无写操作）；点击调用 git_diff(path, staged)
 * 复用 DiffCard 展示。非 git 仓库错误态明确展示（not-repo）。不提供写 Git 操作。
 */
export default function GitPanel({ source, onOpenDiff }: {
  source: string | null
  onOpenDiff: (path: string, staged: boolean) => void
}) {
  const [staged, setStaged] = useState<GitStatusEntry[]>([])
  const [unstaged, setUnstaged] = useState<GitStatusEntry[]>([])
  const [error, setError] = useState<GitErrorDetail | null>(null)

  useEffect(() => {
    if (!source) return
    let disposed = false
    setError(null)
    invoke<unknown>('git_status', { source }).then(raw => {
      if (disposed) return
      const entries = normalizeGitStatus(raw)
      setStaged(entries.filter(entry => entry.staged))
      setUnstaged(entries.filter(entry => !entry.staged))
    }).catch(err => {
      if (disposed) return
      setError(classifyGitError(err))
      reportRuntimeError('读取 Git 状态', err)
    })
    return () => { disposed = true }
  }, [source])

  const renderEntries = (entries: GitStatusEntry[], stagedFlag: boolean) => entries.length === 0
    ? <p className="file-section-hint">无</p>
    : (
      <ul className="git-status-list">
        {entries.map(entry => (
          <li key={`${stagedFlag}-${entry.path}`}>
            <button type="button" className="git-status-row" onClick={() => onOpenDiff(entry.path, stagedFlag)} title="查看 diff">
              <span className="git-status-code">{entry.status.trim()}</span>
              <span className="git-status-path">{entry.path}</span>
            </button>
          </li>
        ))}
      </ul>
    )

  if (error?.kind === 'not-repo') {
    return <div className="file-section-panel"><div className="file-section-title">源代码管理</div><p className="file-section-hint">非 Git 仓库（只读命令不可用）</p></div>
  }
  if (error) {
    return <div className="file-section-panel"><div className="file-section-title">源代码管理</div><div className="file-tree-error" role="alert">{error.message}</div></div>
  }
  if (!source) return <div className="file-section-panel"><p className="file-section-hint">未指向会话</p></div>

  return (
    <div className="file-section-panel">
      <div className="file-section-title">暂存（staged）</div>
      {renderEntries(staged, true)}
      <div className="file-section-title">未暂存（unstaged）</div>
      {renderEntries(unstaged, false)}
    </div>
  )
}
