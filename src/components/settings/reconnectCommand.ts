import type { AgentStatus } from './agentTypes'

interface ReconnectCommandDependencies {
  reconnect: () => Promise<unknown>
  readSnapshot: () => Promise<AgentStatus>
  applySnapshot: (snapshot: AgentStatus) => void
}

export interface ReconnectCommandResult {
  commandError?: unknown
  reconciliationError?: unknown
}

/**
 * Submit reconnect without inventing lifecycle state. A rejected command is
 * reconciled against agent_status; if that read also fails, the last snapshot
 * remains untouched.
 */
export async function runReconnectCommand({
  reconnect,
  readSnapshot,
  applySnapshot,
}: ReconnectCommandDependencies): Promise<ReconnectCommandResult> {
  try {
    await reconnect()
    return {}
  } catch (commandError) {
    try {
      applySnapshot(await readSnapshot())
      return { commandError }
    } catch (reconciliationError) {
      return { commandError, reconciliationError }
    }
  }
}
