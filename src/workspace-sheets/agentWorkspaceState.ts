import { normalizePageState, type AgentSidebarPageState } from '../plugin-runtime/sidebar/sidebarBlockState.ts'

/**
 * Agent Sheet 的左栏状态。
 *
 * 模型再换代（issue #202）：「区块折叠映射」已迁出为**跨 Sheet 的界面偏好**
 * （`domains/workbench/sidebarBlockCollapse`，独立 localStorage key），Sheet 级
 * 只剩「当前整页」。收敛逻辑集中在 `normalizePageState`，**不需要存储键迁移**——
 * 旧形状（含 `sidebarMode` 与同住的 `blockCollapsed`）不匹配即被自然丢弃。
 */
export type AgentWorkspaceState = AgentSidebarPageState

export function deserializeAgentWorkspaceState(raw: unknown): AgentWorkspaceState {
  return normalizePageState(raw)
}

export function serializeAgentWorkspaceState(raw: unknown): AgentWorkspaceState {
  return normalizePageState(raw)
}
