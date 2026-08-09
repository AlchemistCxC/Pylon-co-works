/**
 * agentClient — Agent 域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * command/payload/response normalize 收口；不吞业务错误（reject 原样上抛，
 * 由 UI transaction/调用方分类）。transport 可注入，测试不依赖真实 Tauri。
 */
import type { AgentEntry } from '../../identityStore'
import type { AgentStatusPayload } from '../../components/settings/agentTypes'

export interface ClientTransport {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

/** list_agents 宽容 normalize：非数组/损坏项过滤，空 id 丢弃 */
export function normalizeAgentList(raw: unknown): AgentEntry[] {
  if (!Array.isArray(raw)) return []
  const agents: AgentEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || !id.trim()) continue
    agents.push({
      id: id.trim(),
      name: typeof (item as Record<string, unknown>).name === 'string' ? (item as Record<string, unknown>).name as string : id.trim(),
    })
  }
  return agents
}

export function createAgentClient(transport: ClientTransport) {
  return {
    listAgents: (): Promise<AgentEntry[]> => transport.invoke('list_agents').then(normalizeAgentList),
    /** 冷启动 Agent 状态快照（release-issues #1 方案 A）：list_agents 后查询一次
     * 当前 active agent 的实时状态，补上 listener 注册前的初始状态缺失。 */
    agentStatus: (): Promise<AgentStatusPayload> => transport.invoke('agent_status') as Promise<AgentStatusPayload>,
    switchAgent: (name: string): Promise<unknown> => transport.invoke('switch_agent', { name }),
    reconnectAgent: (): Promise<unknown> => transport.invoke('reconnect_agent'),
    reloadAgents: (): Promise<unknown> => transport.invoke('reload_agents'),
    updateAgentsConfig: (payload: Record<string, unknown>): Promise<unknown> => transport.invoke('update_agents_config', payload),
  }
}

export type AgentClient = ReturnType<typeof createAgentClient>
