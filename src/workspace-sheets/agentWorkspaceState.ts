import type { AgentSidebarMode } from '../plugin-runtime/sidebar/sidebarTypes.ts'

export type AgentWorkspaceMode = AgentSidebarMode

export interface AgentWorkspaceState {
  sidebarMode: AgentWorkspaceMode
}

export function deserializeAgentWorkspaceState(raw: unknown): AgentWorkspaceState {
  if (raw && typeof raw === 'object' && (raw as { sidebarMode?: unknown }).sidebarMode === 'chat') {
    return { sidebarMode: 'chat' }
  }
  return { sidebarMode: 'work' }
}

export function serializeAgentWorkspaceState(raw: unknown): AgentWorkspaceState {
  return deserializeAgentWorkspaceState(raw)
}
