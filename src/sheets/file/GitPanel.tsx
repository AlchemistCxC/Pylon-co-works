import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Download, GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Upload } from 'lucide-react'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import { classifyGitError, normalizeGitHistory, normalizeGitOperationResult, normalizeGitStatus, normalizeGitStatusWithBranch, type GitCommit, type GitErrorDetail, type GitOperationResult, type GitStatusEntry, type GitStatusWithBranch } from '../../infrastructure/tauri/gitContracts.ts'
import FileTypeIcon from './FileTypeIcon'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

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

function GitStatusTree({ entries, onOpenDiff, onMutate, mutationLabel, disabled }: { entries: GitStatusEntry[]; onOpenDiff: (path: string, staged: boolean) => void; onMutate?: (path: string) => void; mutationLabel?: string; disabled?: boolean }) {
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
        <div className="git-tree-row" style={{ '--git-tree-depth': Math.min(depth, 7) } as React.CSSProperties}>
          <button type="button" className="git-tree-primary" onClick={() => {
            if (folder) toggle(node.key)
            else if (node.path) onOpenDiff(node.path, entries.find(entry => entry.path === node.path)?.staged === true)
          }} title={node.path || node.key}>
            <span className="git-tree-caret">{folder ? closed ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : null}</span>
            {node.path ? <FileTypeIcon path={node.path} size={14} /> : <span className="git-tree-folder">{node.label[0]?.toUpperCase()}</span>}
            <span className="git-tree-label">{node.label}</span>
            {node.status && <span className="git-status-code">{node.status}</span>}
          </button>
          {node.path && onMutate && mutationLabel && <button type="button" className="git-tree-action" disabled={disabled} aria-label={`${mutationLabel} ${node.path}`} title={mutationLabel} onClick={() => { if (node.path) onMutate(node.path) }}>
            {mutationLabel === '暂存' ? <Plus size={13} /> : <Minus size={13} />}
          </button>}
        </div>
        {folder && !closed && <ul className="git-tree-list">{render(node.children, depth + 1)}</ul>}
      </li>
    )
  })
  return nodes.length === 0 ? <p className="file-section-hint file-section-muted">无变更</p> : <ul className="git-tree-list">{render(nodes, 0)}</ul>
}

/** GitPanel — 完整 Git 树、状态和提交历史。 */
export default function GitPanel({ target, provider, onOpenDiff }: { target: WorkspaceTarget | null; provider: GitProvider | null; onOpenDiff: (path: string, staged: boolean) => void }) {
  const [staged, setStaged] = useState<GitStatusEntry[]>([])
  const [unstaged, setUnstaged] = useState<GitStatusEntry[]>([])
  const [history, setHistory] = useState<GitCommit[]>([])
  const [error, setError] = useState<GitErrorDetail | null>(null)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [branchName, setBranchName] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [branchDraft, setBranchDraft] = useState('')
  const [branchEditorOpen, setBranchEditorOpen] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })
  const previousTargetKey = useRef<string | null | undefined>(undefined)
  const targetKey = workspaceTargetKey(target)
  const errorKey = useCallback((action: string) => `git:${targetKey ?? 'none'}:${action}`, [targetKey])

  useEffect(() => {
    const targetChanged = previousTargetKey.current !== targetKey
    previousTargetKey.current = targetKey
    requestContext.current = advanceSourceContext(requestContext.current, targetKey)
    const token = targetKey ? beginSourceRequest(requestContext.current, targetKey) : null
    let disposed = false
    if (targetChanged) {
      // Status rows and write drafts are workspace-bound. Leaving them visible while
      // the next target loads can execute an A path/message against workspace B.
      setStaged([])
      setUnstaged([])
      setHistory([])
      setExpandedCommit(null)
      setBranchName(null)
      setCommitMessage('')
      setBranchDraft('')
      setBranchEditorOpen(false)
    }
    if (!target || !provider) {
      setStaged([])
      setUnstaged([])
      setHistory([])
      setExpandedCommit(null)
      setBranchName(null)
      setCommitMessage('')
      setBranchDraft('')
      setBranchEditorOpen(false)
      setError(null)
      return () => { disposed = true }
    }
    setError(null)
    setFeedback(null)
    setBusyAction(null)
    // ISSUE-15 W4：经 typed client 单次获取 branch + entries（WI01 后端已就绪）
    Promise.all([provider.status(target), provider.history(target)]).then(([statusRaw, historyRaw]) => {
      if (disposed || !token || !isCurrentSourceRequest(requestContext.current, token)) return
      const result = normalizeGitStatusWithBranch(statusRaw) as GitStatusWithBranch
      const entries = normalizeGitStatus(result.entries)
      setStaged(entries.filter(entry => entry.staged))
      setUnstaged(entries.filter(entry => !entry.staged))
      setHistory(normalizeGitHistory(historyRaw))
      const info = result.branch
      setBranchName(info.branch ? info.branch : info.detached ? '(detached)' : null)
      setError(null)
      resolveRuntimeErrors({ key: errorKey('读取 Git 信息') })
    }).catch(err => {
      if (disposed || !token || !isCurrentSourceRequest(requestContext.current, token)) return
      setError(classifyGitError(err))
      reportRuntimeError('读取 Git 信息', err, undefined, {
        key: errorKey('读取 Git 信息'),
        scope: { kind: 'sheet', id: `git:${targetKey ?? 'none'}` },
        source: 'git.panel',
        recovery: { kind: 'open-runtime-log', sheetId: `git:${targetKey ?? 'none'}` },
      })
    })
    return () => { disposed = true }
  }, [target, targetKey, provider, refreshRevision, errorKey])

  const applyStatus = (statusRaw: GitStatusWithBranch) => {
    const result = normalizeGitStatusWithBranch(statusRaw)
    const entries = normalizeGitStatus(result.entries)
    setStaged(entries.filter(entry => entry.staged))
    setUnstaged(entries.filter(entry => !entry.staged))
    setBranchName(result.branch.branch ? result.branch.branch : result.branch.detached ? '(detached)' : null)
  }

  const runMutation = async (action: string, request: () => Promise<GitOperationResult>, refreshHistory = false) => {
    if (!target || !provider || busyAction) return
    const sourceAtStart = targetKey
    setBusyAction(action)
    setFeedback(null)
    try {
      const result = normalizeGitOperationResult(await request())
      if (requestContext.current.source !== sourceAtStart) return
      applyStatus(result.status)
      if (refreshHistory) {
        const nextHistory = normalizeGitHistory(await provider.history(target))
        if (requestContext.current.source !== sourceAtStart) return
        setHistory(nextHistory)
      }
      setFeedback({ kind: 'success', message: result.summary || `${action}完成` })
      resolveRuntimeErrors({ key: `git:${sourceAtStart ?? 'none'}:${action}` })
      if (action === '提交') setCommitMessage('')
      if (action === '创建分支' || action === '切换分支') {
        setBranchDraft('')
        setBranchEditorOpen(false)
      }
    } catch (cause) {
      if (requestContext.current.source !== sourceAtStart) return
      setFeedback({ kind: 'error', message: '操作失败，详情见右下角错误中心' })
      reportRuntimeError(action, cause, undefined, {
        key: `git:${sourceAtStart ?? 'none'}:${action}`,
        scope: { kind: 'sheet', id: `git:${sourceAtStart ?? 'none'}` },
        source: 'git.panel',
        recovery: { kind: 'open-runtime-log', sheetId: `git:${sourceAtStart ?? 'none'}` },
      })
    } finally {
      if (requestContext.current.source === sourceAtStart) setBusyAction(null)
    }
  }

  const writable = Boolean(provider?.stage || provider?.unstage || provider?.commit || provider?.createBranch || provider?.switchBranch || provider?.pull || provider?.push)

  if (!target || !provider) return <div className="file-section-panel"><p className="file-section-hint">未安装可用的 Git provider</p></div>
  if (error?.kind === 'not-repo') return <div className="file-section-panel"><p className="file-section-hint">当前工作区不是 Git 仓库</p></div>
  if (error) return <div className="file-section-panel"><p className="file-section-hint file-tree-error-reference" role="status">Git 信息读取失败，详情见右下角错误中心</p></div>

  return (
    <div className="file-section-panel git-panel">
      <div className="git-summary-card">
        <GitBranch size={17} />
        <div><span className="git-summary-kicker">REPOSITORY</span><strong>{branchName ?? '—'}</strong></div>
        <span className="file-panel-count">{staged.length + unstaged.length}</span>
      </div>
      <div className="git-command-bar" aria-label="Git 操作">
        <button type="button" disabled={Boolean(busyAction)} onClick={() => setRefreshRevision(value => value + 1)} title="刷新"><RefreshCw size={14} /></button>
        {provider.pull && <button type="button" disabled={Boolean(busyAction)} onClick={() => void runMutation('拉取', () => provider.pull!(target), true)}><Download size={14} />拉取</button>}
        {provider.push && <button type="button" disabled={Boolean(busyAction)} onClick={() => void runMutation('推送', () => provider.push!(target))}><Upload size={14} />推送</button>}
        {(provider.createBranch || provider.switchBranch) && <button type="button" className={branchEditorOpen ? 'active' : ''} disabled={Boolean(busyAction)} aria-expanded={branchEditorOpen} onClick={() => setBranchEditorOpen(value => !value)}><GitBranch size={14} />分支</button>}
      </div>
      {branchEditorOpen && <form className="git-branch-editor" onSubmit={event => {
        event.preventDefault()
        if (provider.createBranch && branchDraft.trim()) void runMutation('创建分支', () => provider.createBranch!(target, branchDraft))
      }}>
        <label htmlFor="git-branch-name">分支名称</label>
        <input id="git-branch-name" value={branchDraft} onChange={event => setBranchDraft(event.target.value)} placeholder="feature/name" autoComplete="off" />
        <div>
          {provider.createBranch && <button type="submit" disabled={Boolean(busyAction) || !branchDraft.trim()}>创建并切换</button>}
          {provider.switchBranch && <button type="button" disabled={Boolean(busyAction) || !branchDraft.trim()} onClick={() => void runMutation('切换分支', () => provider.switchBranch!(target, branchDraft))}>切换已有分支</button>}
        </div>
      </form>}
      {feedback && <div className={`git-feedback ${feedback.kind}`} role="status">{feedback.message}</div>}
      {writable && provider.commit && <form className="git-commit-box" onSubmit={event => {
        event.preventDefault()
        if (commitMessage.trim()) void runMutation('提交', () => provider.commit!(target, commitMessage), true)
      }}>
        <label htmlFor="git-commit-message">提交说明</label>
        <textarea id="git-commit-message" rows={3} maxLength={10_000} value={commitMessage} onChange={event => setCommitMessage(event.target.value)} placeholder="说明本次变更…" />
        <button type="submit" disabled={Boolean(busyAction) || staged.length === 0 || !commitMessage.trim()}>{busyAction === '提交' ? '提交中…' : `提交 ${staged.length} 项变更`}</button>
      </form>}
      <section className="git-section">
        <div className="file-panel-heading"><span>STAGED</span><span className="file-panel-count">{staged.length}</span>{provider.unstage && staged.length > 0 && <button type="button" className="git-section-action" disabled={Boolean(busyAction)} onClick={() => void runMutation('取消暂存', () => provider.unstage!(target, staged.map(entry => entry.path)))}>全部取消</button>}</div>
        <GitStatusTree entries={staged} onOpenDiff={onOpenDiff} onMutate={provider.unstage ? path => void runMutation('取消暂存', () => provider.unstage!(target, [path])) : undefined} mutationLabel="取消暂存" disabled={Boolean(busyAction)} />
      </section>
      <section className="git-section">
        <div className="file-panel-heading"><span>WORKING TREE</span><span className="file-panel-count">{unstaged.length}</span>{provider.stage && unstaged.length > 0 && <button type="button" className="git-section-action" disabled={Boolean(busyAction)} onClick={() => void runMutation('暂存', () => provider.stage!(target, unstaged.map(entry => entry.path)))}>全部暂存</button>}</div>
        <GitStatusTree entries={unstaged} onOpenDiff={onOpenDiff} onMutate={provider.stage ? path => void runMutation('暂存', () => provider.stage!(target, [path])) : undefined} mutationLabel="暂存" disabled={Boolean(busyAction)} />
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
