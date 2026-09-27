import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  classifyGitError,
  normalizeGitStatus,
  normalizeGitStatusWithBranch,
  type GitErrorDetail,
  type GitStatusEntry,
} from '../../infrastructure/tauri/gitContracts.ts'
import { reportRuntimeError, resolveRuntimeErrors } from '../../app/runtimeError.ts'
import type { GitProvider } from '../../plugin-runtime/file-workbench/fileWorkbenchTypes.ts'
import type { WorkspaceTarget } from '../../domains/workspace/workspaceTarget.ts'
import { workspaceTargetKey } from '../../domains/workspace/workspaceTarget.ts'
import { advanceSourceContext, beginSourceRequest, isCurrentSourceRequest, type SourceRequestContext } from './sourceRequestGuard'

/**
 * useGitStatus — Git status 单一数据源（0-C3 / issue #289，行为不变重构）。
 *
 * 自 GitPanel 提取：status 拉取 + source guard + entries/branch/error 状态。给
 * FileTree（1-C1 git 着色）与 quick open 复用同一条 IPC，避免双份轮询。写操作的
 * 结果回填走 `applyStatus`（GitOperationResult.status 经 normalize，不发新请求）。
 * 消费方：GitPanel（现有）与 FileTree（阶段一）共享同一 hook 实例——注意 hook 状态
 * 是组件级的，两个消费方各自挂载时各自拉取；FileSheet 活动栏一次只渲染一个分区，
 * 因此任一时刻至多一条在途 status 请求。
 */
export interface GitStatusState {
  entries: GitStatusEntry[]
  branchName: string | null
  error: GitErrorDetail | null
  /** 写操作结果回填（不发新请求）。 */
  applyStatus: (statusRaw: unknown) => void
  /** 手动刷新（重拉 status）。 */
  refresh: () => void
}

export function useGitStatus(target: WorkspaceTarget | null, provider: GitProvider | null): GitStatusState {
  const [entries, setEntries] = useState<GitStatusEntry[]>([])
  const [branchName, setBranchName] = useState<string | null>(null)
  const [error, setError] = useState<GitErrorDetail | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const requestContext = useRef<SourceRequestContext>({ source: null, generation: 0 })
  const previousTargetKey = useRef<string | null | undefined>(undefined)
  const targetKey = workspaceTargetKey(target)

  useEffect(() => {
    const targetChanged = previousTargetKey.current !== targetKey
    previousTargetKey.current = targetKey
    requestContext.current = advanceSourceContext(requestContext.current, targetKey)
    const token = targetKey ? beginSourceRequest(requestContext.current, targetKey) : null
    let disposed = false
    // entries/branch 是 workspace 绑定事实：仅目标切换时立即清空（旧工作区行不得
    // 残留）；手动刷新保留旧数据直至新数据落地（重构前 GitPanel 同语义）。
    if (targetChanged) {
      setEntries([])
      setBranchName(null)
    }
    if (!target || !provider) {
      setError(null)
      return () => { disposed = true }
    }
    const errorKey = `git:${targetKey ?? 'none'}:读取 Git 信息`
    setError(null)
    provider.status(target).then(statusRaw => {
      if (disposed || !token || !isCurrentSourceRequest(requestContext.current, token)) return
      const result = normalizeGitStatusWithBranch(statusRaw)
      setEntries(normalizeGitStatus(result.entries))
      const info = result.branch
      setBranchName(info.branch ? info.branch : info.detached ? '(detached)' : null)
      resolveRuntimeErrors({ key: errorKey })
    }).catch(err => {
      if (disposed || !token || !isCurrentSourceRequest(requestContext.current, token)) return
      setError(classifyGitError(err))
      reportRuntimeError('读取 Git 信息', err, undefined, {
        key: errorKey,
        scope: { kind: 'sheet', id: `git:${targetKey ?? 'none'}` },
        source: 'git.hook',
      })
    })
    return () => { disposed = true }
  }, [target, targetKey, provider, refreshRevision])

  const applyStatus = useCallback((statusRaw: unknown) => {
    const result = normalizeGitStatusWithBranch(statusRaw)
    setEntries(normalizeGitStatus(result.entries))
    setBranchName(result.branch.branch ? result.branch.branch : result.branch.detached ? '(detached)' : null)
  }, [])

  const refresh = useCallback(() => setRefreshRevision(value => value + 1), [])

  // 供 memo 依赖稳定（消费方按 entries 自行派生 staged/unstaged）
  return useMemo(() => ({ entries, branchName, error, applyStatus, refresh }),
    [entries, branchName, error, applyStatus, refresh])
}
