import { strict as assert } from 'node:assert'
import { applySessionModelChange } from '../src/components/chat/sessionModelState.ts'

const writes: Array<string | undefined> = []
const calls: Array<{ source: string; model: string }> = []

await applySessionModelChange({
  source: 'local:a',
  nextModel: 'model-new',
  previousModel: 'model-old',
  writeModel: model => writes.push(model),
  invokeSet: async (source, model) => { calls.push({ source, model }) },
})
assert.deepEqual(writes, ['model-new'])
assert.deepEqual(calls, [{ source: 'local:a', model: 'model-new' }], '必须按 Session.source 调用后端')

writes.length = 0
await assert.rejects(() => applySessionModelChange({
  source: 'local:b',
  nextModel: 'model-b-new',
  previousModel: 'model-b-old',
  writeModel: model => writes.push(model),
  invokeSet: async () => { throw new Error('agent unavailable') },
}), /agent unavailable/)
assert.deepEqual(writes, ['model-b-new', 'model-b-old'], '后端失败必须回滚旧模型')

for (const previousModel of [undefined, '', '   ', null as unknown as string]) {
  writes.length = 0
  await assert.rejects(() => applySessionModelChange({
    source: 'local:c',
    nextModel: 'model-c-new',
    previousModel,
    writeModel: model => writes.push(model),
    invokeSet: async () => { throw new Error('agent unavailable') },
  }), /agent unavailable/)
  assert.deepEqual(writes, ['model-c-new', 'default'], `非法旧模型 ${String(previousModel)} 必须回滚 default`)
  assert.ok(!writes.includes(undefined), '回滚不能写入 undefined')
}

console.log('sessionModelState 回归测试通过')
