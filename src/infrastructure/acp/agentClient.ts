/**
 * agentClient — Agent 域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * command/payload/response normalize 收口；不吞业务错误（reject 原样上抛，
 * 由 UI transaction/调用方分类）。transport 可注入，测试不依赖真实 Tauri。
 */
import type { AgentEntry } from '../../identityStore'
import type { AgentStatusPayload } from '../../components/settings/agentTypes'
import { normalizeAgentDetectionReport, type AgentDetectionReport } from '../../domains/agent/agentDetector.ts'
import { normalizeAgentCandidateValidationResult, type AgentCandidateValidationResult } from '../../domains/agent/candidateValidation.ts'
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

export interface SupportedInteractionDescriptor {
  method: string
  aliases: string[]
  kind: string
  responseMethod: string
}

export type CatalogSetModelApi = 'config_option' | 'set_model' | 'none'

export interface ProtocolCatalogBaseline {
  provider: string
  displayName: string
  sessionUpdates: boolean
  interactionEvents: boolean
  permissionRequests: boolean
  replay: boolean
  responseMethods: string[]
  interactionKinds: string[]
  setModelApi: CatalogSetModelApi
}

export interface ProtocolAdapterProvider {
  provider: string
  displayName: string
  catalogKnown: boolean
  adapterRegistered: boolean
  adapterMethods: string[]
  responseMethods: string[]
  interactionKinds: string[]
  baseline?: ProtocolCatalogBaseline
  configuredAgentIds: string[]
}

export interface ProtocolAdapterCatalog {
  schemaVersion: number
  recognizedMethods: string[]
  supportedInteractions: SupportedInteractionDescriptor[]
  providers: ProtocolAdapterProvider[]
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return undefined
  return [...value]
}

function normalizeNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const next = item.trim()
    if (!next || seen.has(next)) continue
    seen.add(next)
    result.push(next)
  }
  return result
}

function normalizeCatalogSetModelApi(value: unknown): CatalogSetModelApi {
  return value === 'config_option' || value === 'set_model' || value === 'none'
    ? value
    : 'none'
}

function normalizeProtocolCatalogBaseline(value: unknown): ProtocolCatalogBaseline | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  if (!provider) return undefined
  return {
    provider,
    displayName: typeof record.displayName === 'string' && record.displayName.trim()
      ? record.displayName.trim()
      : provider,
    sessionUpdates: record.sessionUpdates === true,
    interactionEvents: record.interactionEvents === true,
    permissionRequests: record.permissionRequests === true,
    replay: record.replay === true,
    responseMethods: normalizeNonEmptyStringArray(record.responseMethods),
    interactionKinds: normalizeNonEmptyStringArray(record.interactionKinds),
    setModelApi: normalizeCatalogSetModelApi(record.setModelApi),
  }
}

/**
 * Normalize the read-only protocol diagnostics projection.  The command is
 * intentionally a support surface, so a partially upgraded host must degrade
 * to an empty, inspectable catalog instead of taking the Agent settings page
 * down with a shape error.
 */
export function normalizeProtocolAdapterCatalog(raw: unknown): ProtocolAdapterCatalog {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const schemaVersion = typeof record.schemaVersion === 'number'
    && Number.isInteger(record.schemaVersion) && record.schemaVersion > 0
    ? record.schemaVersion
    : 1
  const supportedInteractions = Array.isArray(record.supportedInteractions)
    ? record.supportedInteractions.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const entry = item as Record<string, unknown>
        const method = typeof entry.method === 'string' ? entry.method.trim() : ''
        if (!method) return []
        return [{
          method,
          aliases: normalizeNonEmptyStringArray(entry.aliases),
          kind: typeof entry.kind === 'string' && entry.kind.trim() ? entry.kind.trim() : 'client-request',
          responseMethod: typeof entry.responseMethod === 'string' && entry.responseMethod.trim()
            ? entry.responseMethod.trim()
            : 'json-rpc',
        }]
      })
    : []
  const providers = Array.isArray(record.providers)
    ? record.providers.flatMap(item => {
        if (!item || typeof item !== 'object') return []
        const entry = item as Record<string, unknown>
        const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : ''
        if (!provider) return []
        const baseline = normalizeProtocolCatalogBaseline(entry.baseline)
        return [{
          provider,
          displayName: typeof entry.displayName === 'string' && entry.displayName.trim()
            ? entry.displayName.trim()
            : baseline?.displayName ?? provider,
          catalogKnown: entry.catalogKnown === true,
          adapterRegistered: entry.adapterRegistered === true,
          adapterMethods: normalizeNonEmptyStringArray(entry.adapterMethods),
          responseMethods: normalizeNonEmptyStringArray(entry.responseMethods),
          interactionKinds: normalizeNonEmptyStringArray(entry.interactionKinds),
          ...(baseline ? { baseline } : {}),
          configuredAgentIds: normalizeNonEmptyStringArray(entry.configuredAgentIds),
        }]
      })
    : []
  return {
    schemaVersion,
    recognizedMethods: normalizeNonEmptyStringArray(record.recognizedMethods),
    supportedInteractions,
    providers,
  }
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
      transport.invoke('test_agent_connection', { agentId }).then(raw => normalizeAgentCandidateValidationResult(raw, agentId)),
    detectAgentRuntimes: (detectorIds: readonly string[]): Promise<AgentDetectionReport> =>
      transport.invoke('detect_agent_runtimes', { detectorIds }).then(normalizeAgentDetectionReport),
    testAgentCandidate: (agentId: string, agent: { name: string; provider: string; transport: string; exe: string; args: string[] }): Promise<AgentConnectionTestResult> =>
      transport.invoke('test_agent_candidate', { agentId, agent }).then(raw => normalizeAgentCandidateValidationResult(raw, agentId)),
    /** OBS-01/02 读取端：当前 active agent 的 ACP wire 记录快照（脱敏、有界）。 */
    wireTraceSnapshot: (): Promise<unknown> => transport.invoke('acp_wire_trace_snapshot'),
    /** 只读 ACP 能力目录：共享 baseline 与本次运行实际 adapter 注册状态分离。 */
    protocolAdapterCatalog: (): Promise<ProtocolAdapterCatalog> =>
      transport.invoke('protocol_adapter_catalog').then(normalizeProtocolAdapterCatalog),
  }
}

export type AgentClient = ReturnType<typeof createAgentClient>
