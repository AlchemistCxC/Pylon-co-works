import { beforeEach, describe, expect, it } from 'vitest'
import { toAgentContextKey } from '../../../../agentContext.ts'
import { useRuntimeStore } from '../../../../runtimeStore.ts'
import { BUILTIN_SESSION_STATE_SYNC_PROVIDER } from '../runtimeStoreSessionState.ts'

const context = { agentId: 'hermes', source: 'local:session-p56' }

beforeEach(() => {
  useRuntimeStore.getState().resetSessionRuntime()
})

describe('P56/D3.3 session_info_update models consumption', () => {
  it('consumes models.currentModelId (camelCase and snake_case) into sessionConfig.model', () => {
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyUpdate?.(context, {
      kind: 'session_info_update',
      payload: {
        sessionUpdate: 'session_info_update',
        models: { currentModelId: 'nous:hermes-4' },
      },
    })
    let key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]?.model).toBe('nous:hermes-4')

    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyUpdate?.(context, {
      kind: 'session_info_update',
      payload: {
        sessionUpdate: 'session_info_update',
        models: { current_model_id: 'nous:hermes-3' },
      },
    })
    key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]?.model).toBe('nous:hermes-3')
  })

  it('never degrades display-name-only currents into the model value', () => {
    useRuntimeStore.getState().setSessionConfig(context, { model: 'keep' })
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyUpdate?.(context, {
      kind: 'session_info_update',
      payload: {
        sessionUpdate: 'session_info_update',
        models: { currentModelId: { name: 'Display Only' } },
      },
    })
    const key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]?.model).toBe('keep')
  })
})
