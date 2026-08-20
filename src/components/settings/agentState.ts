import type { AgentConnectionStatus } from './agentTypes'

export interface AgentStatusTransactionState {
  status: AgentConnectionStatus
  pending: boolean
  error?: string
}

export function normalizeAgentList(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is { id: string; name: string } =>
    Boolean(item && typeof item === 'object'
      && typeof (item as { id?: unknown }).id === 'string'
      && typeof (item as { name?: unknown }).name === 'string'),
  )
}

export function beginReconnect(state: AgentStatusTransactionState): AgentStatusTransactionState {
  return { ...state, status: 'reconnecting', pending: true, error: undefined }
}

export function completeReconnect(state: AgentStatusTransactionState): AgentStatusTransactionState {
  return { ...state, status: 'connected', pending: false, error: undefined }
}

export function resolveReconnectCommandFailure(state: AgentStatusTransactionState, error: string): AgentStatusTransactionState {
  return { ...state, status: 'error', pending: false, error }
}

export function failReconnect(state: AgentStatusTransactionState, error: string): AgentStatusTransactionState {
  return resolveReconnectCommandFailure(state, error)
}
