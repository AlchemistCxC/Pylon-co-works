/**
 * switchAgentTransaction — 切换 Agent 事务（报告阶段 3.1）。
 *
 * invoke 成功后按序：reset session runtime → 切 Agent（含 workspace memory 恢复，
 * setActiveAgent 从 sheetAgentStates 投影）→ fetch/apply 目标 agent_status 快照
 * → 广播 agent-switched → 开 Agent sheet（可选）。快照失败只报告诊断，不伪造
 * connected；失败不改变 activeAgent（transport 错误返回判别结果，由调用方决定展示与重置 pending 状态）。
 */
import type { TransactionResult } from './transactionResult'
import { normalizeAgentStatus, type AgentStatus, type AgentStatusPayload } from '../../components/settings/agentTypes.ts'

export interface SwitchAgentDeps {
  switchAgent: (agentId: string) => Promise<unknown>
  resetRuntime: () => void
  setActiveAgent: (agentId: string) => void
  fetchAgentStatus: () => Promise<AgentStatusPayload>
  applyAgentStatus: (agentId: string, status: AgentStatus) => void
  reportError: (action: string, error: unknown) => void
  /** Resolve only the operation notifications owned by this caller. */
  resolveError?: (action: string) => void
  dispatchSwitched: () => void
  /** 切换后聚焦该 Agent 的 sheet（Settings 场景可不传） */
  openAgentSheet?: (agentId: string, name: string) => void
}

export async function switchAgentTransaction(
  agentId: string,
  agentName: string,
  deps: SwitchAgentDeps,
): Promise<TransactionResult<string>> {
  try {
    await deps.switchAgent(agentId)
  } catch (error) {
    deps.reportError('切换 Agent', error)
    return { ok: false, kind: 'transport', message: error instanceof Error ? error.message : '切换 Agent 失败', cause: error }
  }
  deps.resolveError?.('切换 Agent')
  deps.resetRuntime()
  deps.setActiveAgent(agentId)
  try {
    const snapshot = normalizeAgentStatus(await deps.fetchAgentStatus(), agentId)
    deps.applyAgentStatus(agentId, snapshot)
    deps.resolveError?.('对账 Agent 状态')
  } catch (error) {
    deps.reportError('对账 Agent 状态', error)
  }
  deps.dispatchSwitched()
  deps.openAgentSheet?.(agentId, agentName)
  return { ok: true, value: agentId }
}
