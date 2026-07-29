import type { AgentConnectionStatus } from './agentTypes'

/** Explicit, display-only failure events. Backend payloads are intentionally not inferred here. */
export type AgentFailureKind =
  | 'command-failure'
  | 'disconnected'
  | 'crashed'
  | 'error'
  | 'reconnect-request-accepted'

export interface AgentFailureEvent {
  kind: AgentFailureKind
  detail?: string
}

export interface AgentFailureState {
  status: AgentConnectionStatus
  failureKind: AgentFailureKind | 'unknown'
  diagnostic: string
}

const DIAGNOSTICS: Record<AgentFailureKind, string> = {
  'command-failure': 'Agent 命令执行失败',
  disconnected: 'Agent 已断开连接',
  crashed: 'Agent 进程已崩溃',
  error: 'Agent 发生错误',
  'reconnect-request-accepted': '重连请求已接受，Agent 重连中',
}

const STATUS_BY_KIND: Record<AgentFailureKind, AgentConnectionStatus> = {
  'command-failure': 'error',
  disconnected: 'disconnected',
  crashed: 'crashed',
  error: 'error',
  'reconnect-request-accepted': 'reconnecting',
}

const KNOWN_KINDS = new Set<AgentFailureKind>(Object.keys(DIAGNOSTICS) as AgentFailureKind[])

function isAgentFailureEvent(value: unknown): value is AgentFailureEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as { kind?: unknown; detail?: unknown }
  return KNOWN_KINDS.has(event.kind as AgentFailureKind)
    && (event.detail === undefined || typeof event.detail === 'string')
}

/**
 * Maps only the explicit failure vocabulary to render-facing state.
 * Unknown values never fall back to healthy/connected state.
 */
export function adaptAgentFailure(value: unknown): AgentFailureState {
  if (!isAgentFailureEvent(value)) {
    return {
      status: 'error',
      failureKind: 'unknown',
      diagnostic: '未知 Agent 失败状态',
    }
  }

  const diagnostic = value.detail
    ? `${DIAGNOSTICS[value.kind]}：${value.detail}`
    : DIAGNOSTICS[value.kind]

  return {
    status: STATUS_BY_KIND[value.kind],
    failureKind: value.kind,
    diagnostic,
  }
}

export function isKnownAgentFailureKind(value: unknown): value is AgentFailureKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value as AgentFailureKind)
}
