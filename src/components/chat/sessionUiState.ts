/**
 * sessionUiState — 会话级 UI 状态注册表。
 *
 * 草稿/搜索等 UI 状态按 sessionId 键保存：切会话不串（A 草稿不显示在 B）、
 * 不丢（切回 A 恢复草稿）。多会话基建的一部分（配合 per-source 数据层）。
 * 模块级单例；会话关闭时调 clearSessionUiState(id) 清理，防注册表残留。
 */

import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

const registry = new Map<string, Record<string, unknown>>()

export function sessionUiStateGet<T>(sessionId: string, key: string): T | undefined {
  return registry.get(sessionId)?.[key] as T | undefined
}

export function sessionUiStateSet<T>(sessionId: string, key: string, value: T): void {
  const entry = registry.get(sessionId) ?? {}
  entry[key] = value
  registry.set(sessionId, entry)
}

export function clearSessionUiState(sessionId: string): void {
  registry.delete(sessionId)
}

/** 清空全部会话 UI 状态（测试夹具 resetStores 用；生产代码不调用） */
export function clearAllSessionUiState(): void {
  registry.clear()
}

/**
 * 按会话作用域的 UI 状态。sessionId 变化时从注册表恢复（无存档用 initial）。
 * 注意：initial 只在首次/无存档时生效，后续被注册表覆盖；不必担心 initial
 * 引用变化（用 ref 捕获，不参与 effect 依赖，避免对象字面量触发反复恢复）。
 */
export function useSessionUiState<T>(
  sessionId: string | null,
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const id = sessionId ?? ''
  const initialRef = useRef(initial)
  const [state, setState] = useState<T>(() => sessionUiStateGet<T>(id, key) ?? initialRef.current)
  // 会话切换：恢复该会话存档（useLayoutEffect 避免 B 先闪现 A 的一帧）
  useLayoutEffect(() => {
    setState(() => sessionUiStateGet<T>(id, key) ?? initialRef.current)
  }, [id, key])
  const set: Dispatch<SetStateAction<T>> = useCallback((action) => {
    setState(prev => {
      const next = typeof action === 'function' ? (action as (p: T) => T)(prev) : action
      sessionUiStateSet(id, key, next)
      return next
    })
  }, [id, key])
  return [state, set]
}
