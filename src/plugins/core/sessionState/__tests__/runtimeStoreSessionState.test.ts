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
    const configOptions = [{
      id: 'model', name: 'Model', type: 'select', currentValue: 'gpt-5',
      options: [{ value: 'gpt-5' }, { value: 'gpt-4' }],
    }]
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyResponse?.(context, {
      modes: { currentModeId: 'plan' },
      configOptions,
      usage: { used: 99, size: 100 },
    })

    const key = toAgentContextKey(context)
    // P56/D3：modelChoices 是响应宣告的 choices（id/label 分离真源），与 models 同属
    // 可水合的 advertised capability；current value 仍是 journal-owned，不得到达 store。
    // #51：原始 envelope 一并入库（raw）——Settings 泛化配置面板只读 raw。
    expect(useRuntimeStore.getState().sessionConfig[key]).toEqual({
      models: ['gpt-5', 'gpt-4'],
      modelChoices: [{ id: 'gpt-5' }, { id: 'gpt-4' }],
      raw: configOptions,
    })
    expect(useRuntimeStore.getState().sessionModes[key]).toBeUndefined()
    expect(useRuntimeStore.getState().sessionLiveStats[key]).toBeUndefined()
  })

  it('retains the raw configOptions envelope even when no projection matches (#51)', () => {
    const configOptions = [{
      id: 'future_option', category: 'something_else', type: 'select', currentValue: 'x',
      options: [{ value: 'x' }],
    }]
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyResponse?.(context, { configOptions })

    const key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]?.raw).toEqual(configOptions)
  })

  it('hydrates the ACP reasoning effort for the restored control center', () => {
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyResponse?.(context, {
      configOptions: [{
        id: 'thought_level',
        currentValue: 'high',
        choices: [{ value: 'low' }, { value: 'high' }],
      }],
    })

    const key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]?.thinkingEffort).toBe('high')
  })

  it('updates reasoning effort when ACP sends a config option update', () => {
    BUILTIN_SESSION_STATE_SYNC_PROVIDER.applyUpdate?.(context, {
      kind: 'config_option_update',
      payload: {
        sessionUpdate: 'config_option_update',
        id: 'reasoning_effort',
        currentValue: { valueId: 'low' },
      },
    })

    const key = toAgentContextKey(context)
    expect(useRuntimeStore.getState().sessionConfig[key]?.thinkingEffort).toBe('low')
  })
})
