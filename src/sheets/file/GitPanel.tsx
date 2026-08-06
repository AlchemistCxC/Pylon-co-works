import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, GitBranch, GitCommitHorizontal } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyGitError, normalizeGitHistory, normalizeGitStatus, type GitCommit, type GitErrorDetail, type GitStatusEntry } from '../../infrastructure/tauri/gitContracts.ts'
import FileTypeIcon from './FileTypeIcon'

interface GitPathNode {
  key: string
  label: string
  path?: string
  children: GitPathNode[]
  status?: string
}

function gitTree(entries: GitStatusEntry[]): GitPathNode[] {
  const root: GitPathNode[] = []
  for (const entry of entries) {
    const parts = entry.path.split('/').filter(Boolean)
    let level = root
    parts.forEach((part, index) => {
      let node = level.find(item => item.label === part)
      if (!node) {
        node = { key: parts.slice(0, index + 1).join('/'), label: part, children: [] }
        level.push(node)
      }
      if (index === parts.length - 1) {
        node.path = entry.path
        node.status = entry.status.trim() || '·'
      }
      level = node.children
    })
  }
  return root
}

function GitStatusTree({ entries, onOpenDiff }: { entries: GitStatusEntry[]; onOpenDiff: (path: string, staged: boolean) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const nodes = useMemo(() => gitTree(entries), [entries])
  const toggle = (key: string) => setCollapsed(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const render = (items: GitPathNode[], depth: number): React.ReactNode => items.map(node => {
    const folder = node.children.length > 0
    const closed = collapsed.has(node.key)
    return (
      <li key={node.key} className="git-tree-node">
        <button type="button" className="git-tree-row" style={{ '--git-tree-depth': Math.min(depth, 7) } as React.CSSProperties} onClick={() => {
          if (folder) toggle(node.key)
          else if (node.path) onOpenDiff(node.path, entries.find(entry => entry.path === node.path)?.staged === true)
        }} title={node.path || node.key}>
          <span className="git-tree-caret">{folder ? closed ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : null}</span>
          {node.path ? <FileTypeIcon path={node.path} size={14} /> : <span className="git-tree-folder">{node.label[0]?.toUpperCase()}</span>}
          <span className="git-tree-label">{node.label}</span>
          {node.status && <span className="git-status-code">{node.status}</span>}
        </button>
        {folder && !closed && <ul className="git-tree-list">{render(node.children, depth + 1)}</ul>}
      </li>
    )
  })
  return nodes.length === 0 ? <p className="file-section-hint file-section-muted">无变更</p> : <ul className="git-tree-list">{render(nodes, 0)}</ul>
}

/** GitPanel — 完整 Git 树、状态和提交历史。 */
export default function GitPanel({ source, onOpenDiff }: { source: string | null; onOpenDiff: (path: string, staged: boolean) => void }) {
  const [staged, setStaged] = useState<GitStatusEntry[]>([])
  const [unstaged, setUnstaged] = useState<GitStatusEntry[]>([])
  const [history, setHistory] = useState<GitCommit[]>([])
  const [error, setError] = useState<GitErrorDetail | null>(null)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)

  useEffect(() => {
    if (!source) return
    let disposed = false
    setError(null)
    Promise.all([invoke<unknown>('git_status', { source }), invoke<unknown>('git_history', { source })]).then(([statusRaw, historyRaw]) => {
      if (disposed) return
      const entries = normalizeGitStatus(statusRaw)
      setStaged(entries.filter(entry => entry.staged))
      setUnstaged(entries.filter(entry => !entry.staged))
      setHistory(normalizeGitHistory(historyRaw))
    }).catch(err => {
      if (disposed) return
      setError(classifyGitError(err))
      reportRuntimeError('读取 Git 信息', err)
    })
    return () => { disposed = true }
  }, [source])

  if (!source) return <div className="file-section-panel"><p className="file-section-hint">选择会话后查看 Git</p></div>
  if (error?.kind === 'not-repo') return <div className="file-section-panel"><p className="file-section-hint">当前工作区不是 Git 仓库</p></div>
  if (error) return <div className="file-section-panel"><div className="file-tree-error" role="alert">{error.message}</div></div>

  return (
    <div className="file-section-panel git-panel">
      <div className="git-summary-card">
        <GitBranch size={17} />
        <div><span className="git-summary-kicker">REPOSITORY</span><strong>main</strong></div>
        <span className="file-panel-count">{staged.length + unstaged.length}</span>
      </div>
      <section className="git-section">
        <div className="file-panel-heading"><span>STAGED</span><span className="file-panel-count">{staged.length}</span></div>
        <GitStatusTree entries={staged} onOpenDiff={onOpenDiff} />
      </section>
      <section className="git-section">
        <div className="file-panel-heading"><span>WORKING TREE</span><span className="file-panel-count">{unstaged.length}</span></div>
        <GitStatusTree entries={unstaged} onOpenDiff={onOpenDiff} />
      </section>
      <section className="git-section">
        <div className="file-panel-heading"><span>COMMITS</span><span className="file-panel-count">{history.length}</span></div>
        <ul className="git-history-list">
          {history.map(commit => (
            <li key={commit.hash} className={`git-history-row ${expandedCommit === commit.hash ? 'expanded' : ''}`}>
              <button type="button" className="git-history-head" aria-expanded={expandedCommit === commit.hash} onClick={() => setExpandedCommit(current => current === commit.hash ? null : commit.hash)}>
                <span className="git-history-caret">{expandedCommit === commit.hash ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                <GitCommitHorizontal size={14} />
                <span className="git-history-subject" title={commit.subject}>{commit.subject || '无提交说明'}</span>
                <span className="git-history-hash">{commit.hash.slice(0, 7)}</span>
              </button>
              {expandedCommit === commit.hash && <div className="git-history-detail">
                <span><strong>COMMIT</strong>{commit.hash}</span>
                <span><strong>AUTHOR</strong>{commit.author || '—'}</span>
                <span><strong>DATE</strong>{commit.date ? new Date(commit.date * 1000).toLocaleString() : '—'}</span>
              </div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
