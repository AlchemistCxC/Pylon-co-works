import { describe, expect, it } from 'vitest'
import {
  extractChoiceId,
  extractConfigOptionChoices,
  extractConfigOptionId,
  extractConfigOptionValue,
  extractMachineIdString,
  extractMode,
  extractModeConfig,
  extractModelConfig,
  extractReasoningConfig,
  findConfigOption,
  sessionResponseObject,
} from '../chatContracts.ts'

describe('ACP chat contract extraction', () => {
  it('returns an empty object when no model response exists', () => {
    expect(extractModelConfig(undefined)).toEqual({})
    expect(extractModelConfig(undefined, sessionResponseObject(null))).toEqual({})
  })

  // P56/D3 改写（施工书 §6 点名）：machine-id-only + modelChoices 新形状。保留嵌套
  // 与 snake_case 兼容意图；name/label 显示名不再降级为 id（无 machine id 的 choice
  // 直接丢弃）。
  it('extracts machine ids only and separates labels across nested and snake-case shapes', () => {
    const response = sessionResponseObject({
      session_id: 'session-1',
      config_options: [{
        config_id: 'model_selection',
        current_value: { value_id: { value: 'provider:current' }, label: 'Current display' },
        schema: { enum: [{ value_id: 'provider:a', name: 'Model A' }] },
      }],
      models: {
        current_model_id: { value: 'provider:current' },
        available_models: [
          { model_id: 'provider:a', name: 'Model A' },
          { id: 'provider:b', label: 'Model B' },
          { name: 'display-only choice is dropped' },
        ],
      },
      modes: {
        current_mode_id: { id: 'accept_edits' },
        available_modes: [{ mode_id: 'accept_edits', name: 'Accept edits' }],
      },
    })

    expect(response.session_id).toBe('session-1')
    expect(extractModelConfig(response.config_options, response)).toEqual({
      model: 'provider:current',
      models: ['provider:a', 'provider:b'],
      modelChoices: [
        { id: 'provider:a', label: 'Model A', provider: 'provider' },
        { id: 'provider:b', provider: 'provider' },
      ],
    })
    expect(extractModeConfig(response)).toEqual({
      mode: 'accept_edits',
      modes: ['accept_edits'],
    })
    expect(extractMode(response)).toBe('accept_edits')
  })

  it('unwraps config values and discovers choices under schema/enum', () => {
    const option = {
      config_id: 'thought_level',
      current_value: { valueId: { id: 'high' } },
      schema: { enum: [{ value_id: 'low', label: 'Low' }, { valueId: { value: 'high' }, label: 'High' }] },
    }
    expect(extractConfigOptionId(option)).toBe('thought_level')
    expect(extractConfigOptionValue(option)).toBe('high')
    expect(extractConfigOptionChoices(option)).toHaveLength(2)
    expect(extractChoiceId({ model_id: 'provider:model', name: 'Display' }, 'model')).toBe('provider:model')
    expect(extractChoiceId({ mode_id: 'accept_edits', name: 'Accept edits' }, 'mode')).toBe('accept_edits')
  })

  it('extracts the restored reasoning effort from ACP config options', () => {
    expect(extractReasoningConfig([{
      config_id: 'thought_level',
      current_value: { value_id: 'high' },
      choices: [{ value_id: 'low' }, { value_id: 'high' }],
    }])).toEqual({ thinkingEffort: 'high', reasoning: ['low', 'high'] })
  })

  // ── P56/D3 新增 ──

  it('prefers the category field and never matches description tokens', () => {
    // 干扰选项：description 含 "model"——不得胜出；category=="model" 精确命中。
    const options = [
      {
        id: 'reasoning-effort',
        description: 'Reasoning effort for the model',
        options: [{ valueId: 'low' }],
        currentValue: 'low',
      },
      {
        id: 'model-selection',
        category: 'model',
        options: [{ valueId: 'm-1', name: 'Model One' }],
        currentValue: 'm-1',
      },
    ]
    expect(findConfigOption(options, 'model')).toBe(options[1])
    expect(extractModelConfig(options)).toEqual({
      model: 'm-1',
      models: ['m-1'],
      modelChoices: [{ id: 'm-1', label: 'Model One' }],
    })
    // 子串评分已移除：id "model_context_window" 与 "model" 只是包含关系，不命中。
    expect(findConfigOption([{ id: 'model_context_window' }], 'model')).toBeUndefined()
  })

  it('drops choices without machine ids and keeps hermes models state labels', () => {
    // hermes 形态：availableModels 为 provider:model 编码 id + name 显示名；Pylon
    // 只收集 machine id 并以 name 作 label，不解析编码。
    const response = sessionResponseObject({
      models: {
        currentModelId: 'nous:hermes-4',
        availableModels: [
          { modelId: 'nous:hermes-4', name: 'Nous · hermes-4', description: 'Provider: nous' },
          { name: 'display-only' },
        ],
      },
    })
    expect(extractModelConfig(undefined, response)).toEqual({
      model: 'nous:hermes-4',
      models: ['nous:hermes-4'],
      modelChoices: [{ id: 'nous:hermes-4', label: 'Nous · hermes-4', provider: 'nous' }],
    })
  })

  it('extractMachineIdString never degrades to display labels', () => {
    expect(extractMachineIdString({ valueId: 'm-1', name: 'Model One' })).toBe('m-1')
    expect(extractMachineIdString({ modelId: 'nous:hermes-4', name: 'Nous' })).toBe('nous:hermes-4')
    expect(extractMachineIdString({ name: 'Model One' })).toBeUndefined()
    expect(extractMachineIdString({ label: 'Model One' })).toBeUndefined()
    expect(extractMachineIdString({ current: { name: 'wrapped display' } })).toBeUndefined()
  })
})
