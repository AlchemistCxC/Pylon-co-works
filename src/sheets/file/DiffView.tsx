import { useEffect, useRef, useState } from 'react'
import { reportRuntimeError } from '../../runtimeError'
import { classifyGitError } from '../../infrastructure/tauri/gitContracts.ts'
import DiffCard from '../../components/chat/DiffCard'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'
import { workspaceTargetKey, type WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'

/**
 * DiffView — Git diff 展示（W2-05）。
 *
 * 点击 staged/unstaged 条目 → git_diff(source, path, staged) → 复用 DiffCard
 * （DiffPayload 统一渲染，不新造 diff 渲染器）。只读。
 */
export default function DiffView({ target, provider, path, staged, onClose }: {
  target: WorkspaceTarget | null
  provider: GitProvider | null
  path: string
  staged: boolean
  onClose: () => void
}) {
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })
  const targetKey = workspaceTargetKey(target)

  useEffect(() => {
    requestContext.current = advanceSourceContext(requestContext.current, targetKey)
    if (!target || !targetKey || !provider) return
    const token = beginSourceRequest(requestContext.current, targetKey)
    let disposed = false
    setOutput('')
    setError('')
    provider.diff(target, { path, staged }).then(text => {
      if (!disposed && isCurrentSourceRequest(requestContext.current, token)) setOutput(typeof text === 'string' ? text : '')
    }).catch(err => {
      if (disposed || !isCurrentSourceRequest(requestContext.current, token)) return
      setError(classifyGitError(err).message)
      reportRuntimeError('读取 Git diff', err)
    })
    return () => { disposed = true }
  }, [target, targetKey, provider, path, staged])

  return (
    <div className="git-diff-view">
      <div className="git-diff-head">
        <span className="git-diff-path">{path}（{staged ? 'staged' : 'unstaged'}）</span>
        <button type="button" className="git-diff-close" onClick={onClose} aria-label="关闭 diff">✕</button>
      </div>
      {error && <div className="file-tree-error" role="alert">{error}</div>}
      {!error && <DiffCard output={output} />}
    </div>
  )
}
