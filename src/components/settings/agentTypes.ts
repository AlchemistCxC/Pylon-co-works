export type AgentConnectionStatus = 'connected' | 'crashed' | 'reconnecting' | 'disconnected' | 'error'

export interface AgentInfo {
  id: string
  name: string
  transport?: string
  cwd?: string
}

export interface AgentStatus {
  agent: string
  status: AgentConnectionStatus
  transport?: string
  cwd?: string
  recentError?: string
}

export interface AgentStatusPayload {
  agent?: string
  status?: string
  crashed?: boolean
  transport?: string
  cwd?: string
  error?: string
}

export function normalizeAgentStatus(payload: AgentStatusPayload, fallbackAgent = ''): AgentStatus {
  const knownStatus: AgentConnectionStatus[] = ['connected', 'reconnecting', 'disconnected', 'error', 'crashed']
  const status: AgentConnectionStatus = payload.status === undefined
    ? payload.crashed === true ? 'crashed' : 'connected'
    : knownStatus.includes(payload.status as AgentConnectionStatus)
      ? payload.status as AgentConnectionStatus
      : 'error'
  return {
    agent: payload.agent || fallbackAgent,
    status,
    transport: payload.transport,
    cwd: payload.cwd,
    recentError: payload.error || (payload.status !== undefined && status === 'error' ? `未知 Agent 状态：${payload.status}` : undefined),
  }
}

export function statusLabel(status: AgentConnectionStatus): string {
  return {
    connected: '已连接',
    crashed: '进程崩溃',
    reconnecting: '重连中',
    disconnected: '未连接',
    error: '错误',
  }[status]
}
