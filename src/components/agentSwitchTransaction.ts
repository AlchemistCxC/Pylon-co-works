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
