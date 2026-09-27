/**
 * reloadAgentsTransaction — 重载 Agent 配置事务。
 *
 * 顺序固定：reload_agents → list_agents（typed client 内已归一化）→ 应用列表 →
 * 加载/应用工具归一化字典 → resolve 通知。任一步失败只报告诊断（'重载 Agent 配置'），
 * 已应用的列表保留，不得触碰 activeAgent/agentStatus。reloading 期间重入直接忽略。
 */
import type { AgentEntry } from '../../domains/identity/identityStore'

export interface ReloadAgentsDeps {
  isReloading: () => boolean
  setReloading: (value: boolean) => void
  reloadAgents: () => Promise<unknown>
  listAgents: () => Promise<AgentEntry[]>
  setAgents: (agents: AgentEntry[]) => void
  /** reload 成功后加载工具归一化字典并应用（失败即本事务失败，由 reportError 上报） */
  loadToolDictionary: () => Promise<void>
  reportError: (action: string, error: unknown) => void
  resolveError?: (action: string) => void
}

export async function reloadAgentsTransaction(deps: ReloadAgentsDeps): Promise<boolean> {
  if (deps.isReloading()) return false
  deps.setReloading(true)
  try {
    await deps.reloadAgents()
    const list = await deps.listAgents()
    deps.setAgents(list)
    await deps.loadToolDictionary()
    deps.resolveError?.('重载 Agent 配置')
    return true
  } catch (error) {
    deps.reportError('重载 Agent 配置', error)
    return false
  } finally {
    deps.setReloading(false)
  }
}
