/**
 * sessionUiState — 会话级 UI 状态注册表。
 *
 * 草稿/搜索等 UI 状态按 sessionId 键保存：切会话不串（A 草稿不显示在 B）、
 * 不丢（切回 A 恢复草稿）。多会话基建的一部分（配合 per-source 数据层）。
 * 模块级单例；会话关闭时调 clearSessionUiState(id) 清理，防注册表残留。
 *
 * React 消费钩子 useSessionUiState 在唯一消费者 components/right-panel/AgentContextPanel.tsx 内联
 * （结构审查 WS-C：域模块零 React 依赖）。
 */


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
