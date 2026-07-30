interface AgentSwitchTransactionOptions {
  switchAgent: () => Promise<void>
  onSuccess: () => void
  onError: (error: unknown) => void
}

export async function runAgentSwitchTransaction({ switchAgent, onSuccess, onError }: AgentSwitchTransactionOptions): Promise<boolean> {
  try {
    await switchAgent()
    onSuccess()
    return true
  } catch (error) {
    onError(error)
    return false
  }
}

export interface AgentActivationOptions extends AgentSwitchTransactionOptions {
  targetAgentId: string
  activeAgentId: string
}

export async function activateAgent({ targetAgentId, activeAgentId, ...options }: AgentActivationOptions): Promise<boolean> {
  if (!targetAgentId || targetAgentId === activeAgentId) {
    options.onSuccess()
    return true
  }
  return runAgentSwitchTransaction(options)
}
