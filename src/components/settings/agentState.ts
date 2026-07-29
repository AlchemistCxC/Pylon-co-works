import type { AgentConnectionStatus } from './agentTypes'

export interface AgentStatusTransactionState {
  status: AgentConnectionStatus
  pending: boolean
  error?: string
}

export function beginReconnect(state: AgentStatusTransactionState): AgentStatusTransactionState {
  return { ...state, status: 'reconnecting', pending: true, error: undefined }
}

export function completeReconnect(state: AgentStatusTransactionState): AgentStatusTransactionState {
  return { ...state, status: 'connected', pending: false, error: undefined }
}

export function failReconnect(state: AgentStatusTransactionState, error: string): AgentStatusTransactionState {
  return { ...state, status: 'error', pending: false, error }
}
