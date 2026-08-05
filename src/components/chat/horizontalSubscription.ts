/**
 * horizontalSubscription — 横向订阅版本戳注册表（P1-05，D23 方案 B）。
 *
 * controller 在 dispatch 后对"该 source 状态引用变化"调用 bump；仅该 source 的
 * 订阅者收到通知，版本戳数字稳定适配 useSyncExternalStore。纯 TS 可单测——source A
 * 更新不通知 B、unsubscribe 后不通知、prune/dispose 清理生命周期。
 */

export interface HorizontalSubscription {
  /** 订阅指定 source 的横向状态变化；返回退订函数 */
  subscribe: (source: string, listener: () => void) => () => void
  /** 横向版本戳（未订阅过/未变化为 0） */
  getSnapshot: (source: string) => number
  /** controller 在 dispatch 后调用：仅当 changed 时递增该 source 版本并通知订阅者 */
  bump: (source: string, changed: boolean) => void
  /** 会话集合变化后清理孤儿 source 的版本与监听器 */
  prune: (activeSources: readonly string[]) => void
  /** controller dispose 时清空全部监听器 */
  dispose: () => void
}

export function createHorizontalSubscription(): HorizontalSubscription {
  const versions: Record<string, number> = {}
  const listeners = new Map<string, Set<() => void>>()

  return {
    subscribe: (source, listener) => {
      let set = listeners.get(source)
      if (!set) {
        set = new Set()
        listeners.set(source, set)
      }
      set.add(listener)
      return () => {
        const current = listeners.get(source)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) listeners.delete(source)
      }
    },
    getSnapshot: source => versions[source] ?? 0,
    bump: (source, changed) => {
      if (!changed) return
      versions[source] = (versions[source] ?? 0) + 1
      const set = listeners.get(source)
      if (!set) return
      // 快照遍历：listener 内部退订/订阅不干扰本轮通知
      for (const listener of [...set]) {
        listener()
      }
    },
    prune: activeSources => {
      const active = new Set(activeSources)
      for (const source of listeners.keys()) {
        if (!active.has(source)) listeners.delete(source)
      }
      for (const source of Object.keys(versions)) {
        if (!active.has(source)) delete versions[source]
      }
    },
    dispose: () => {
      listeners.clear()
    },
  }
}
