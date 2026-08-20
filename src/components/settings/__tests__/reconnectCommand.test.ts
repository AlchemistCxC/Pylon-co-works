import { describe, expect, it, vi } from 'vitest'
import { runReconnectCommand } from '../reconnectCommand'
import type { AgentStatus } from '../agentTypes'

describe('runReconnectCommand', () => {
  const snapshot: AgentStatus = { agent: 'peri', agentId: 'peri', status: 'connected', generation: 4 }

  it('does not manufacture a lifecycle snapshot when the command is accepted', async () => {
    const readSnapshot = vi.fn<() => Promise<AgentStatus>>()
    const applySnapshot = vi.fn()

    await expect(runReconnectCommand({
      reconnect: async () => undefined,
      readSnapshot,
      applySnapshot,
    })).resolves.toEqual({})

    expect(readSnapshot).not.toHaveBeenCalled()
    expect(applySnapshot).not.toHaveBeenCalled()
  })

  it('reconciles an authoritative snapshot after command rejection', async () => {
    const commandError = new Error('command rejected')
    const applySnapshot = vi.fn()

    const result = await runReconnectCommand({
      reconnect: async () => { throw commandError },
      readSnapshot: async () => snapshot,
      applySnapshot,
    })

    expect(result).toEqual({ commandError })
    expect(applySnapshot).toHaveBeenCalledWith(snapshot)
  })

  it('reports reconciliation failure without replacing the last snapshot', async () => {
    const commandError = new Error('command rejected')
    const reconciliationError = new Error('status unavailable')
    const applySnapshot = vi.fn()

    const result = await runReconnectCommand({
      reconnect: async () => { throw commandError },
      readSnapshot: async () => { throw reconciliationError },
      applySnapshot,
    })

    expect(result).toEqual({ commandError, reconciliationError })
    expect(applySnapshot).not.toHaveBeenCalled()
  })
})
