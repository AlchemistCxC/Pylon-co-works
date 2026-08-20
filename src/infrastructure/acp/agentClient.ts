/**
 * agentClient — Agent 域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * command/payload/response normalize 收口；不吞业务错误（reject 原样上抛，
 * 由 UI transaction/调用方分类）。transport 可注入，测试不依赖真实 Tauri。
 */
import type { AgentEntry } from '../../identityStore'
import type { AgentStatusPayload } from '../../components/settings/agentTypes'
import { normalizeAgentDetectionReport, type AgentDetectionReport } from '../../domains/agent/agentDetector.ts'
import type { AgentCandidateValidationResult } from '../../domains/agent/candidateValidation.ts'
import type { DurableSessionOwner } from '../../domains/session/owner.ts'

export interface ClientTransport {
  invoke: (cmd: string, args?: unknown) => Promise<unknown>
}

export type AgentConnectionTestResult = AgentCandidateValidationResult

export interface AgentCreateConfig {
  name: string
  provider?: string
  transport: 'subprocess'
  exe: string
  args: string[]
  default: boolean
}

export interface AgentsConfigDocument {
  agents: Record<string, AgentCreateConfig>
}

export interface AgentConfigSnapshot {
  revision: string
  agents: AgentEntry[]
  diagnostics: Array<{ agentId: string; code: string; field: string; message: string }>
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return [...value]
}

/** list_agents 宽容 normalize：非数组/损坏项过滤，空 id 丢弃 */
export function normalizeAgentList(raw: unknown): AgentEntry[] {
  if (!Array.isArray(raw)) return []
  const agents: AgentEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || !id.trim()) continue
    const provider = record.provider
    agents.push({
      id: id.trim(),
      name: typeof record.name === 'string' ? record.name as string : id.trim(),
      provider: typeof provider === 'string' && provider.trim() ? provider.trim() : undefined,
      transport: typeof record.transport === 'string' ? record.transport : undefined,
      exe: typeof record.exe === 'string' ? record.exe : undefined,
      args: normalizeStringArray(record.args),
      effectiveArgs: normalizeStringArray(record.effectiveArgs),
      default: typeof record.default === 'boolean' ? record.default : undefined,
      active: typeof record.active === 'boolean' ? record.active : undefined,
      available: typeof record.available === 'boolean' ? record.available : undefined,
      crashed: typeof record.crashed === 'boolean' ? record.crashed : undefined,
      cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
      configActivationState: record.configActivationState === 'stored'
        || record.configActivationState === 'pendingRestart'
        || record.configActivationState === 'activated'
        ? record.configActivationState
        : undefined,
    })
  }
  return agents
}

export function createAgentClient(transport: ClientTransport) {
  let revision: string | null = null
  const ensureConfigRevision = async (): Promise<void> => {
    if (revision) return
    try {
      const snapshot = await transport.invoke('agent_config_snapshot')
      const record = snapshot && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : {}
      if (typeof record.revision !== 'string' || !record.revision) {
        throw new Error('agent_config_snapshot 未返回有效 revision')
      }
      revision = record.revision
    } catch (error) {
      // embedded 配置没有外部 revision；随后 update 会稳定返回 config_read_only，
      // 调用方可显式转入 initialize。其他 snapshot 故障不得降级为盲写。
      if (!error || typeof error !== 'object' || (error as { code?: unknown }).code !== 'config_read_only') throw error
      revision = null
    }
  }
  const mutationRevision = async (): Promise<string | null> => {
    await ensureConfigRevision()
    return revision
  }
  const acceptMutationRevision = (result: unknown): void => {
    if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).revision === 'string') {
      revision = (result as Record<string, string>).revision
    }
  }
  return {
    listAgents: (): Promise<AgentEntry[]> => transport.invoke('list_agents').then(normalizeAgentList),
    agentConfigSnapshot: (): Promise<AgentConfigSnapshot> => transport.invoke('agent_config_snapshot').then(raw => {
      const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      if (typeof record.revision !== 'string' || !record.revision) {
        throw new Error('agent_config_snapshot 未返回有效 revision')
      }
      const next: AgentConfigSnapshot = {
        revision: record.revision,
        agents: normalizeAgentList(record.agents),
        diagnostics: Array.isArray(record.diagnostics)
          ? record.diagnostics.filter((item): item is AgentConfigSnapshot['diagnostics'][number] => (
              !!item && typeof item === 'object'
              && typeof (item as Record<string, unknown>).agentId === 'string'
              && typeof (item as Record<string, unknown>).code === 'string'
              && typeof (item as Record<string, unknown>).field === 'string'
              && typeof (item as Record<string, unknown>).message === 'string'
            ))
          : [],
      }
      revision = next.revision
      return next
    }),
    ensureConfigRevision,
    listToolDictionary: (): Promise<unknown> => transport.invoke('list_tool_dictionary'),
    setSessionState: (owner: DurableSessionOwner, state: unknown, remoteSessionId?: string): Promise<unknown> =>
      transport.invoke('set_session_state', { owner, remoteSessionId, state }),
    /** 冷启动 Agent 状态快照（release-issues #1 方案 A）：list_agents 后查询一次
     * 当前 active agent 的实时状态，补上 listener 注册前的初始状态缺失。 */
    agentStatus: (): Promise<AgentStatusPayload> => transport.invoke('agent_status') as Promise<AgentStatusPayload>,
    switchAgent: (name: string): Promise<unknown> => transport.invoke('switch_agent', { name }),
    reconnectAgent: (): Promise<unknown> => transport.invoke('reconnect_agent'),
    restartAgentRuntime: (agentId: string): Promise<unknown> => transport.invoke('restart_agent_runtime', { agentId }),
    reloadAgents: (): Promise<unknown> => transport.invoke('reload_agents'),
    /** agent 级暴露的 MCP server 配置（cwd 设置据此选择启用哪些）。 */
    getMcpServers: (): Promise<unknown[]> => transport.invoke('get_mcp_servers') as Promise<unknown[]>,
    setMcpServers: (servers: unknown[]): Promise<unknown> => transport.invoke('set_mcp_servers', { servers }),
    updateAgentsConfig: async (payload: Record<string, unknown>): Promise<unknown> => {
      const expectedRevision = await mutationRevision()
      const result = await transport.invoke('update_agents_config', { ...payload, ...(expectedRevision ? { expectedRevision } : {}) })
      acceptMutationRevision(result)
      return result
    },
    /** 施工文档 §4.3.1：结构化字段 patch（exe/default/name/provider/transport/args）。 */
    updateAgentFieldPatch: async (agentId: string, patch: Record<string, unknown>): Promise<unknown> => {
      const expectedRevision = await mutationRevision()
      const result = await transport.invoke('update_agents_config', { scope: 'agent_fields', agentId, config: patch, ...(expectedRevision ? { expectedRevision } : {}) })
      acceptMutationRevision(result)
      return result
    },
    /** 新建单个 Agent：只接受结构化 node，不能传入顶层 agents document。 */
    createAgent: async (agentId: string, config: AgentCreateConfig): Promise<unknown> => {
      const expectedRevision = await mutationRevision()
      const result = await transport.invoke('update_agents_config', { scope: 'agent_create', agentId, config, ...(expectedRevision ? { expectedRevision } : {}) })
      acceptMutationRevision(result)
      return result
    },
    /** 施工文档 §4.6：embedded → exe 旁 agents.yaml 首次外部配置初始化。 */
    initializeAgentsConfig: async (agentId: string | undefined, config: AgentsConfigDocument): Promise<unknown> => {
      const result = await transport.invoke('initialize_agents_config', { agentId, config })
      acceptMutationRevision(result)
      return result
    },
    /** embedded 配置首次结构化修改：物化当前完整配置后应用字段 patch。 */
    initializeAgentFieldPatch: async (agentId: string, patch: Record<string, unknown>): Promise<unknown> => {
      const result = await transport.invoke('initialize_agents_config', { agentId, config: patch })
      acceptMutationRevision(result)
      return result
    },
    /** 施工文档 §4.5：隔离连接测试（不改 active/runtime）。 */
    testAgentConnection: (agentId: string): Promise<AgentConnectionTestResult> =>
      transport.invoke('test_agent_connection', { agentId }) as Promise<AgentConnectionTestResult>,
    detectAgentRuntimes: (detectorIds: readonly string[]): Promise<AgentDetectionReport> =>
      transport.invoke('detect_agent_runtimes', { detectorIds }).then(normalizeAgentDetectionReport),
    testAgentCandidate: (agentId: string, agent: { name: string; provider: string; transport: string; exe: string; args: string[] }): Promise<AgentConnectionTestResult> =>
      transport.invoke('test_agent_candidate', { agentId, agent }) as Promise<AgentConnectionTestResult>,
    /** OBS-01/02 读取端：当前 active agent 的 ACP wire 记录快照（脱敏、有界）。 */
    wireTraceSnapshot: (): Promise<unknown> => transport.invoke('acp_wire_trace_snapshot'),
  }
}

export type AgentClient = ReturnType<typeof createAgentClient>
