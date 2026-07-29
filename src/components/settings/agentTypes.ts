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
  const status: AgentConnectionStatus = payload.status === 'reconnecting'
    || payload.status === 'disconnected'
    || payload.status === 'error'
    || payload.status === 'crashed'
    ? payload.status
    : payload.crashed === true ? 'crashed' : 'connected'
  return {
    agent: payload.agent || fallbackAgent,
    status,
    transport: payload.transport,
    cwd: payload.cwd,
    recentError: payload.error,
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
