import { describe, expect, it, vi } from 'vitest'
import { applySessionModelChange } from '../sessionModelState.ts'

const base = {
  source: 'local:session-1',
  previousModel: 'm-1',
}

describe('applySessionModelChange 权威回声覆盖（P56/D3）', () => {
  it('overwrites the optimistic value when the response advertises new model and choices', async () => {
    const writeModel = vi.fn()
    const applyResponseConfig = vi.fn()
    await applySessionModelChange({
      ...base,
      nextModel: 'm-2',
      writeModel,
      applyResponseConfig,
      invokeSet: async () => ({
        configOptions: [{
          id: 'model-selection',
          category: 'model',
          options: [{ valueId: 'm-1', name: 'One' }, { valueId: 'm-2', name: 'Two' }],
          currentValue: 'm-2',
        }],
      }),
    })
    expect(writeModel).toHaveBeenCalledWith('m-2')
    expect(applyResponseConfig).toHaveBeenCalledWith({
      model: 'm-2',
      modelChoices: [{ id: 'm-1', label: 'One' }, { id: 'm-2', label: 'Two' }],
    })
  })

  it('keeps the optimistic value on hermes-style empty echoes', async () => {
    const applyResponseConfig = vi.fn()
    // hermes set_model：空响应（评估 §8.5：无可消费回声）。
    await applySessionModelChange({
      ...base,
      nextModel: 'nous:hermes-4',
      writeModel: vi.fn(),
      applyResponseConfig,
      invokeSet: async () => ({}),
    })
    expect(applyResponseConfig).not.toHaveBeenCalled()
    // hermes set_config_option：恒空 configOptions 回声——同样不得清空/覆盖。
    await applySessionModelChange({
      ...base,
      nextModel: 'nous:hermes-3',
      writeModel: vi.fn(),
      applyResponseConfig,
      invokeSet: async () => ({ configOptions: [] }),
    })
    expect(applyResponseConfig).not.toHaveBeenCalled()
  })

  it('rolls back to the previous model on failure (unchanged behavior)', async () => {
    const writeModel = vi.fn()
    const applyResponseConfig = vi.fn()
    await expect(applySessionModelChange({
      ...base,
      nextModel: 'm-2',
      writeModel,
      applyResponseConfig,
      invokeSet: async () => {
        throw new Error('rpc failed')
      },
    })).rejects.toThrow('rpc failed')
    expect(writeModel).toHaveBeenNthCalledWith(1, 'm-2')
    expect(writeModel).toHaveBeenNthCalledWith(2, 'm-1')
    expect(applyResponseConfig).not.toHaveBeenCalled()
  })
})
