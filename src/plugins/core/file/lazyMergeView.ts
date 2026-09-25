/**
 * lazyMergeView — @codemirror/merge 的懒加载门面（0-C5 / issue #291）。
 *
 * 硬约束：大体量依赖严禁同步引入 bundle。merge 包只在 diff/conflict 视图挂载时
 * 经本模块的 dynamic import 拉取（懒 chunk，check:bundle 预算已重定标）。阶段〇
 * 只落地「懒引入 + 类型化出口」；MergeView/unifiedMergeView 的消费在 1-C4（diff
 * 升级）与 2-C2（冲突流）——本门面保证它们不再各自 import 包入口，统一经此。
 */

type MergeModule = typeof import('@codemirror/merge')

let modulePromise: Promise<MergeModule> | null = null

/** 惰性加载 merge 包（重复调用共享同一 promise）。 */
export function loadMergeModule(): Promise<MergeModule> {
  modulePromise ??= import('@codemirror/merge')
  return modulePromise
}

export type { MergeModule }
