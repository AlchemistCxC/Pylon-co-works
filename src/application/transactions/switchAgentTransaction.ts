/**
 * switchAgentTransaction — 切换 Agent 事务（报告阶段 3.1）。
 *
 * invoke 成功后按序：reset runtime → 切 Agent（含 workspace memory 恢复，
 * setActiveAgent 从 sheetAgentStates 投影）→ 广播 agent-switched → 开 Agent sheet
 * （可选）。失败不改变 activeAgent（transport 错误返回判别结果，由调用方决定
 * 展示与重置 pending 状态）。
 */
import type { TransactionResult } from './transactionResult'

export interface SwitchAgentDeps {
  switchAgent: (agentId: string) => Promise<unknown>
  resetRuntime: () => void
  setActiveAgent: (agentId: string) => void
  reportError: (action: string, error: unknown) => void
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
  deps.resetRuntime()
  deps.setActiveAgent(agentId)
  deps.dispatchSwitched()
  deps.openAgentSheet?.(agentId, agentName)
  return { ok: true, value: agentId }
}
