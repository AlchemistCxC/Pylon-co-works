import { describe, expect, it } from 'vitest'
import { resolveCapabilitySnapshot } from '../agentContracts'
import type { AgentStatus } from '../../../components/settings/agentTypes'

function status(partial: Partial<AgentStatus>): AgentStatus {
  return {
    agent: 'peri',
    status: 'connected',
    ...partial,
  }
}

describe('resolveCapabilitySnapshot lifecycle/capabilities contract', () => {
  it('connected without negotiated capabilities remains connected and reports unknown negotiation', () => {
    expect(resolveCapabilitySnapshot(status({ capabilities: null }))).toMatchObject({
      connected: true,
      capabilitiesKnown: false,
    })
    expect(resolveCapabilitySnapshot(status({}))).toMatchObject({
      connected: true,
      capabilitiesKnown: false,
    })
  })

  it('non-connected lifecycle never inherits connected from stale capabilities', () => {
    expect(resolveCapabilitySnapshot(status({
      status: 'reconnecting',
      capabilities: { promptCapabilities: { image: true } },
    }))).toMatchObject({ connected: false, capabilitiesKnown: true, promptImage: true })
    expect(resolveCapabilitySnapshot(status({
      status: 'error',
      capabilities: { promptCapabilities: { image: true } },
    })).connected).toBe(false)
  })
})
