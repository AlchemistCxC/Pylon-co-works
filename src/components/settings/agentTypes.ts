export type AgentConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'crashed' | 'error' | 'inactive'

export interface AgentInfo {
  id: string
  name: string
  transport?: string
  cwd?: string
}

export interface AgentStatus {
  agent: string
  agentId?: string
  status: AgentConnectionStatus
  transport?: string
  cwd?: string
  recentError?: string
  generation?: number
  lastConnectedAt?: string | number
}

export interface AgentStatusPayload {
  agentId?: string
  agent?: string
  status?: string
  crashed?: boolean
  transport?: string
  cwd?: string
  error?: string
  generation?: number
  lastConnectedAt?: string | number
}

export function normalizeAgentStatus(payload: AgentStatusPayload, fallbackAgent = ''): AgentStatus {
  const knownStatus: AgentConnectionStatus[] = ['connected', 'connecting', 'reconnecting', 'disconnected', 'error', 'crashed', 'inactive']
  const status: AgentConnectionStatus = payload.status === undefined
    ? payload.crashed === true ? 'crashed' : 'connected'
    : knownStatus.includes(payload.status as AgentConnectionStatus)
      ? payload.status as AgentConnectionStatus
      : 'error'
  return {
    agent: payload.agent || fallbackAgent,
    agentId: payload.agentId,
    status,
    transport: payload.transport,
    cwd: payload.cwd,
    recentError: payload.error || (payload.status !== undefined && status === 'error' ? `未知 Agent 状态：${payload.status}` : undefined),
    generation: payload.generation,
    lastConnectedAt: payload.lastConnectedAt,
  }
}

export function statusLabel(status: AgentConnectionStatus): string {
  return {
    connected: '已连接',
    connecting: '连接中',
    crashed: '进程崩溃',
    reconnecting: '重连中',
    disconnected: '未连接',
    error: '错误',
    inactive: '未激活',
  }[status]
}
