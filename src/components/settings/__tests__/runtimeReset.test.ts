import { describe, expect, it } from 'vitest'
import { useRuntimeStore } from '../../../runtimeStore'
import { toAgentContextKey } from '../../../agentContext'

describe('runtime reset boundary', () => {
  it('clears session runtime while retaining agent status snapshots', () => {
    const status = { agent: 'hermes', agentId: 'hermes', status: 'connected' as const, generation: 7 }
    const ctxKey = toAgentContextKey({ agentId: 'hermes', source: 'session' })
    useRuntimeStore.setState({
      liveGenerating: 'hermes:session',
      liveGeneratingSources: ['hermes:session'],
      sessionConfig: { [ctxKey]: { model: 'model-a' } },
      sessionModes: { [ctxKey]: 'plan' },
      sessionLiveStats: { [ctxKey]: { tokensUsed: 7, tokensMax: 100, cacheReadTokens: 1, commands: [] } },
      agentStatuses: { hermes: status },
    })

    useRuntimeStore.getState().resetSessionRuntime()

    const next = useRuntimeStore.getState()
    expect(next.agentStatuses).toEqual({ hermes: status })
    expect(next.sessionConfig).toEqual({})
    expect(next.sessionModes).toEqual({})
    expect(next.sessionLiveStats).toEqual({})
    expect(next.liveGenerating).toBeNull()
    expect(next.liveGeneratingSources).toEqual([])
  })
})
