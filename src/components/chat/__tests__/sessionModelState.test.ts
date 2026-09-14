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

// 迁移自 scripts/test-session-model.mts（P91 A1）：model 回滚矩阵并入本文件
// （点名清单处置「并入 sessionModelState.test」）。逐断言平移。
describe('applySessionModelChange 回滚矩阵（原 test-session-model.mts）', () => {
  it('成功路径：写新 model 并按 Session.source 调用后端', async () => {
    const writes: Array<string | undefined> = []
    const calls: Array<{ source: string; model: string }> = []
    await applySessionModelChange({
      source: 'local:a',
      nextModel: 'model-new',
      previousModel: 'model-old',
      writeModel: model => writes.push(model),
      invokeSet: async (source, model) => { calls.push({ source, model }) },
    })
    expect(writes).toEqual(['model-new'])
    expect(calls).toEqual([{ source: 'local:a', model: 'model-new' }])
  })

  it('后端失败必须回滚旧模型', async () => {
    const writes: Array<string | undefined> = []
    await expect(applySessionModelChange({
      source: 'local:b',
      nextModel: 'model-b-new',
      previousModel: 'model-b-old',
      writeModel: model => writes.push(model),
      invokeSet: async () => { throw new Error('agent unavailable') },
    })).rejects.toThrow(/agent unavailable/)
    expect(writes).toEqual(['model-b-new', 'model-b-old'])
  })

  it('非法旧模型（undefined/空串/空白/null）必须回滚 default，且回滚不能写入 undefined', async () => {
    const writes: Array<string | undefined> = []
    for (const previousModel of [undefined, '', '   ', null as unknown as string]) {
      writes.length = 0
      await expect(applySessionModelChange({
        source: 'local:c',
        nextModel: 'model-c-new',
        previousModel,
        writeModel: model => writes.push(model),
        invokeSet: async () => { throw new Error('agent unavailable') },
      })).rejects.toThrow(/agent unavailable/)
      expect(writes).toEqual(['model-c-new', 'default'])
      expect(writes.includes(undefined)).toBe(false)
    }
  })
})
