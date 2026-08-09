import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { createWorkspaceClient } from '../../infrastructure/tauri/workspaceClient'
import { classifyGitError } from '../../infrastructure/tauri/gitContracts.ts'
import DiffCard from '../../components/chat/DiffCard'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'

/**
 * DiffView — Git diff 展示（W2-05）。
 *
 * 点击 staged/unstaged 条目 → git_diff(source, path, staged) → 复用 DiffCard
 * （DiffPayload 统一渲染，不新造 diff 渲染器）。只读。
 */
export default function DiffView({ source, path, staged, onClose }: {
  source: string | null
  path: string
  staged: boolean
  onClose: () => void
}) {
  const [output, setOutput] = useState('')
  const [error, setError] = useState('')
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })

  useEffect(() => {
    requestContext.current = advanceSourceContext(requestContext.current, source)
    if (!source) return
    const token = beginSourceRequest(requestContext.current, source)
    let disposed = false
    setOutput('')
    setError('')
    createWorkspaceClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).gitDiff(source, path, staged).then(text => {
      if (!disposed && isCurrentSourceRequest(requestContext.current, token)) setOutput(typeof text === 'string' ? text : '')
    }).catch(err => {
      if (disposed || !isCurrentSourceRequest(requestContext.current, token)) return
      setError(classifyGitError(err).message)
      reportRuntimeError('读取 Git diff', err)
    })
    return () => { disposed = true }
  }, [source, path, staged])

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
