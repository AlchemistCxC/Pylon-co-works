import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { SolidStoreKernel } from './solidStoreKernel'

/** zustand hook 的完整形状（调用签名 + 静态方法面），消费者类型零改动。 */
export interface ZustandHook<T extends object> {
  (): T
  <S>(selector: (state: T) => S): S
  <S>(selector: (state: T) => S, equalityFn: (a: S, b: S) => boolean): S
  getState: () => T
  setState: (partial: Partial<T> | ((state: T) => Partial<T>), replace?: boolean) => void
  subscribe: (listener: (state: T, prevState: T) => void) => () => void
  getInitialState: () => T
  getVersion: () => number
}

/**
 * React 面的 store hook shim（#515 批0 过渡件，终态随 React 面一并删除）。
 *
 * store 本体已是 Solid（solidStoreKernel），本文件只把 zustand 的 hook 消费形态
 * `useXxxStore(selector?, equalityFn?)` 映射到 `useSyncExternalStore`，让未迁移的
 * React 组件在批0 置换后零改动。语义对齐：
 * - selector 结果按引用 + equalityFn 判等，相等不重渲（zustand useStoreWithEqualityFn 同款）；
 * - **无 selector（identity）**：zustand 每次 set 产新 state 对象 ⇒ 必重渲；Solid 代理
 *   身份恒定，故按 kernel 版本号浅拷贝根状态，恢复「每次写入都换根引用」的观察语义。
 *   浅拷贝是每消费组件每通知一次 O(键数)，仅过渡期存在。
 */
export function createReactStoreHook<T extends object>(kernel: SolidStoreKernel<T>): ZustandHook<T> {
  const subscribe = (onStoreChange: () => void) => kernel.subscribe(() => onStoreChange())

  function useStore<S>(selector?: (state: T) => S, equalityFn?: (a: S, b: S) => boolean): S {
    const versionRef = useRef<{ version: number; value: unknown } | null>(null)

    if (selector === undefined) {
      // 无 selector：按版本浅拷贝根状态（见文件头注）。
      const getSnapshot = useCallback(() => {
        const version = kernel.getVersion()
        const last = versionRef.current
        if (last && last.version === version) return last.value as T
        const next = { ...kernel.getState() }
        versionRef.current = { version, value: next }
        return next
      }, [kernel])
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as unknown as S
    }

    const eq = equalityFn ?? Object.is
    const getSnapshot = useCallback(() => {
      const version = kernel.getVersion()
      const last = versionRef.current as { version: number; value: S } | null
      if (last && last.version === version) return last.value
      const value = selector(kernel.getState())
      if (last && eq(last.value, value)) {
        versionRef.current = { version, value: last.value }
        return last.value
      }
      versionRef.current = { version, value }
      return value
    }, [kernel, selector, eq])
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  // zustand hook 的静态方法面（useXxxStore.getState / setState / subscribe /
  // getInitialState 在消费侧被广泛直用），原样挂在 shim 上。
  return Object.assign(useStore, {
    getState: kernel.getState,
    setState: kernel.setState,
    subscribe: kernel.subscribe,
    getInitialState: kernel.getInitialState,
    getVersion: kernel.getVersion,
  }) as unknown as ZustandHook<T>
}

/** zustand `useShallow` 的本地等价（浅比较；仅过渡期 React 面使用）。 */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false
  const keysA = Object.keys(a as Record<string, unknown>)
  const keysB = Object.keys(b as Record<string, unknown>)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}
