import { describe, expect, it } from 'vitest'
import {
  extractChoiceId,
  extractConfigOptionChoices,
  extractConfigOptionId,
  extractConfigOptionValue,
  extractMode,
  extractModeConfig,
  extractModelConfig,
  extractReasoningConfig,
  sessionResponseObject,
} from '../chatContracts.ts'

describe('ACP chat contract extraction', () => {
  it('returns an empty object when no model response exists', () => {
    expect(extractModelConfig(undefined)).toEqual({})
    expect(extractModelConfig(undefined, sessionResponseObject(null))).toEqual({})
  })

  it('prefers machine ids over display labels across nested and snake-case shapes', () => {
    const response = sessionResponseObject({
      session_id: 'session-1',
      config_options: [{
        config_id: 'model_selector',
        current_value: { value_id: { value: 'provider:current' }, label: 'Current display' },
        schema: { enum: [{ value_id: 'provider:a', name: 'Model A' }] },
      }],
      models: {
        current_model_id: { value: 'provider:current' },
        available_models: [
          { model_id: 'provider:a', name: 'Model A' },
          { id: 'provider:b', label: 'Model B' },
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
})
