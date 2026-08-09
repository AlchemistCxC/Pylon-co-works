import { invoke } from '@tauri-apps/api/core'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { createAgentClient } from '../infrastructure/acp/agentClient'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { reportRuntimeError } from '../runtimeError'

/**
 * Release 1.x Agent Sheet activation boundary: switch the single GUI runtime
 * before exposing a different Agent Sheet to focus or business commands.
 */
export async function activateAgentSheet(
  agentId: string,
  agentName: string,
  onActivated: () => void,
): Promise<boolean> {
  const agentClient = createAgentClient({
    invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined),
  })
  const result = await switchAgentTransaction(agentId, agentName, {
    switchAgent: () => agentClient.switchAgent(agentId),
    resetRuntime: () => useRuntimeStore.getState().resetAll(),
    setActiveAgent: id => useIdentityStore.getState().setActiveAgent(id),
    fetchAgentStatus: () => agentClient.agentStatus(),
    applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
    reportError: (action, error) => reportRuntimeError(action, error),
    dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
    openAgentSheet: onActivated,
  })
  return result.ok
}
