import type { GitProvider } from './fileWorkbenchTypes.ts'

/**
 * gitCapabilities — GitProvider 可选能力的派生探测（0-C4 / issue #290）。
 *
 * 组件只读本派生对象，消除 `provider?.x &&` 布尔串的复制扩散（C 案 §8）。
 * 后端仍各自校验危险操作；本层只负责「未实现方法 → UI 隐藏入口」。
 */
export interface GitCapabilities {
  graph: boolean
  showFile: boolean
  blame: boolean
  sequenceState: boolean
  stash: boolean
  historyOps: boolean
  conflictFlow: boolean
}

export function resolveGitCapabilities(provider: GitProvider | null): GitCapabilities {
  const stash = Boolean(provider?.stashList)
  return {
    graph: Boolean(provider?.logGraph),
    showFile: Boolean(provider?.showFile),
    blame: Boolean(provider?.blame),
    sequenceState: Boolean(provider?.sequenceState),
    stash,
    historyOps: Boolean(provider?.reset || provider?.revert || provider?.cherryPick),
    conflictFlow: Boolean(provider?.sequenceState) && stash,
  }
}
