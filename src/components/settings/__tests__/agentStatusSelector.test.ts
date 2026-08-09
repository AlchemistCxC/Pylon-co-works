import { describe, expect, it } from 'vitest'
import {
  normalizeAgentStatus,
  selectAgentStatus,
  statusLabel,
  type AgentStatus,
} from '../agentTypes'

describe('agent status selector', () => {
  const statuses: Record<string, AgentStatus> = {
    hermes: { agent: 'hermes', agentId: 'hermes', status: 'connected' },
  }

  it('returns unknown for an active agent without an authoritative snapshot', () => {
    expect(selectAgentStatus('peri', 'peri', statuses)).toMatchObject({
      agent: 'peri',
      agentId: 'peri',
      status: 'unknown',
    })
  })

  it('returns inactive for a non-active agent regardless of its snapshot', () => {
    expect(selectAgentStatus('hermes', 'peri', statuses)).toMatchObject({
      agent: 'hermes',
      agentId: 'hermes',
      status: 'inactive',
    })
  })

  it('normalizes a missing lifecycle status to unknown', () => {
    expect(normalizeAgentStatus({ agent: 'peri' }, 'peri').status).toBe('unknown')
    expect(statusLabel('unknown')).toBe('状态未知')
  })
})
