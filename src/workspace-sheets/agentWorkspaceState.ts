import { normalizeBlockState, type AgentSidebarBlockState } from '../plugin-runtime/sidebar/sidebarBlockState.ts'

/**
 * Agent Sheet 的左栏状态。
 *
 * 模型换代：旧形状是 `{ sidebarMode: 'work' | 'chat' }`（一对互斥视图），现在是
 * 「区块折叠映射」。收敛逻辑集中在 `normalizeBlockState`，**不需要存储键迁移**——
 * 旧值形状不匹配即回落空映射，已持久化的 `sidebarMode` 被自然丢弃。
 */
export type AgentWorkspaceState = AgentSidebarBlockState

export function deserializeAgentWorkspaceState(raw: unknown): AgentWorkspaceState {
  return normalizeBlockState(raw)
}

export function serializeAgentWorkspaceState(raw: unknown): AgentWorkspaceState {
  return normalizeBlockState(raw)
}
