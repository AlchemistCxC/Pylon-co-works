import { beforeEach, describe, expect, it } from 'vitest'
import { toAgentContextKey } from '../../../../agentContext.ts'
import { useRuntimeStore } from '../../../../runtimeStore.ts'
import { BUILTIN_SESSION_STATE_SYNC_PROVIDER } from '../runtimeStoreSessionState.ts'

const context = { agentId: 'peri', source: 'local:session-1' }

beforeEach(() => {
  useRuntimeStore.getState().resetSessionRuntime()
})

describe('C14 session response authority', () => {
  it('hydrates only advertised capabilities and never restores journal-owned current state', () => {
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyResponse?.(context, {
      modes: { currentModeId: 'plan' },
      configOptions: [{
        id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-5',
        options: [{ value: 'gpt-5' }, { value: 'gpt-4' }],
      }],
      usage: { used: 99, size: 100 },
    })

    const key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]).toEqual({ models: ['gpt-5', 'gpt-4'] })
    expect(useRuntimeStore.getState().sessionModes[key]).toBeUndefined()
    expect(useRuntimeStore.getState().sessionLiveStats[key]).toBeUndefined()
  })
})
