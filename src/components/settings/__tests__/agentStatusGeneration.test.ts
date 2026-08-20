import { beforeEach, describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../runtimeStore'
import { normalizeAgentStatus, type AgentStatus } from '../agentTypes'

const status = (lifecycle: AgentStatus['status'], generation?: number): AgentStatus => ({
  agent: 'peri',
  agentId: 'peri',
  status: lifecycle,
  generation,
})

describe('agent status generation convergence', () => {
  beforeEach(() => {
    useRuntimeStore.setState({ agentStatuses: {} })
  })

  it('rejects a lower-generation event after a newer snapshot', () => {
    const store = useRuntimeStore.getState()
    store.setAgentStatus('peri', status('connected', 4))
    store.setAgentStatus('peri', status('reconnecting', 3))

    expect(useRuntimeStore.getState().agentStatuses.peri).toMatchObject({
      status: 'connected',
      generation: 4,
    })
  })

  it('accepts updates within the same generation in arrival order', () => {
    const store = useRuntimeStore.getState()
    store.setAgentStatus('peri', status('reconnecting', 4))
    store.setAgentStatus('peri', status('connected', 4))

    expect(useRuntimeStore.getState().agentStatuses.peri.status).toBe('connected')
  })

  it('accepts an unversioned payload because its ordering is not comparable', () => {
    const store = useRuntimeStore.getState()
    store.setAgentStatus('peri', status('connected', 4))
    store.setAgentStatus('peri', status('error'))

    expect(useRuntimeStore.getState().agentStatuses.peri.status).toBe('error')
  })

  it('normalizes bounded session binding metadata and rejects malformed rows', () => {
    const normalized = normalizeAgentStatus({
      agentId: 'peri', status: 'connected', generation: 8,
      sessionBindings: [
        { agentId: 'peri', source: 'local:s1', health: 'probing', generation: 8, fromGeneration: 7, retryable: true },
        { agentId: 'peri', source: 'local:bad', health: 'unknown', generation: 8 },
        { agentId: 'peri', source: 'local:negative', health: 'attached', generation: -1 },
      ],
    })
    expect(normalized.sessionBindings).toEqual([{
      agentId: 'peri', source: 'local:s1', health: 'probing', generation: 8,
      fromGeneration: 7, reason: undefined, retryable: true,
    }])
  })
})
