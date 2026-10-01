import { createEffect, createSignal, onCleanup } from 'solid-js'
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
 * createGitStatus — Git status 单一数据源的 Solid 形态（0-C3 / issue #289，#515 迁移）。
 *
 * 自 GitPanel 提取（原 React hook `useGitStatus`，域内消费者 GitPanel 已全量 Solid 化，
 * 本文件是唯一形态）：status 拉取 + source guard + entries/branch/error 状态。写操作的
 * 结果回填走 `applyStatus`（GitOperationResult.status 经 normalize，不发新请求）。
 * 状态是调用方组件级的，多个消费方各自挂载时各自拉取；FileSheet 活动栏一次只渲染一个
 * 分区，因此任一时刻至多一条在途 status 请求。
 */
export interface GitStatusState {
  entries: () => GitStatusEntry[]
  branchName: () => string | null
  error: () => GitErrorDetail | null
  /** 写操作结果回填（不发新请求）。 */
  applyStatus: (statusRaw: unknown) => void
  /** 手动刷新（重拉 status）。 */
  refresh: () => void
}

export function createGitStatus(target: () => WorkspaceTarget | null, provider: () => GitProvider | null): GitStatusState {
  const [entries, setEntries] = createSignal<GitStatusEntry[]>([])
  const [branchName, setBranchName] = createSignal<string | null>(null)
  const [error, setError] = createSignal<GitErrorDetail | null>(null)
  const [refreshRevision, setRefreshRevision] = createSignal(0)
  let requestContext: SourceRequestContext = { source: null, generation: 0 }
  let previousTargetKey: string | null | undefined = undefined

  createEffect(() => {
    const currentTarget = target()
    const currentProvider = provider()
    const targetKey = workspaceTargetKey(currentTarget)
    void refreshRevision()
    const targetChanged = previousTargetKey !== targetKey
    previousTargetKey = targetKey
    requestContext = advanceSourceContext(requestContext, targetKey)
    const token = targetKey ? beginSourceRequest(requestContext, targetKey) : null
    let disposed = false
    // entries/branch 是 workspace 绑定事实：仅目标切换时立即清空（旧工作区行不得
    // 残留）；手动刷新保留旧数据直至新数据落地（重构前 GitPanel 同语义）。
    if (targetChanged) {
      setEntries([])
      setBranchName(null)
    }
    if (!currentTarget || !currentProvider) {
      setError(null)
      onCleanup(() => { disposed = true })
      return
    }
    const errorKey = `git:${targetKey ?? 'none'}:读取 Git 信息`
    setError(null)
    currentProvider.status(currentTarget).then(statusRaw => {
      if (disposed || !token || !isCurrentSourceRequest(requestContext, token)) return
      const result = normalizeGitStatusWithBranch(statusRaw)
      setEntries(normalizeGitStatus(result.entries))
      const info = result.branch
      setBranchName(info.branch ? info.branch : info.detached ? '(detached)' : null)
      resolveRuntimeErrors({ key: errorKey })
    }).catch(err => {
      if (disposed || !token || !isCurrentSourceRequest(requestContext, token)) return
      setError(classifyGitError(err))
      reportRuntimeError('读取 Git 信息', err, undefined, {
        key: errorKey,
        scope: { kind: 'sheet', id: `git:${targetKey ?? 'none'}` },
        source: 'git.hook',
      })
    })
    onCleanup(() => { disposed = true })
  })

  const applyStatus = (statusRaw: unknown) => {
    const result = normalizeGitStatusWithBranch(statusRaw)
    setEntries(normalizeGitStatus(result.entries))
    setBranchName(result.branch.branch ? result.branch.branch : result.branch.detached ? '(detached)' : null)
  }

  const refresh = () => setRefreshRevision(value => value + 1)

  return { entries, branchName, error, applyStatus, refresh }
}
