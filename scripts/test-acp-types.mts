import { strict as assert } from 'node:assert'
import { extractMode, extractModelConfig, sessionResponseObject } from '../src/components/chat/acpTypes.ts'

const response = sessionResponseObject({
  sessionId: 'peri-a',
  modes: { currentModeId: 'edit' },
  configOptions: [{ id: 'model', currentValue: 'sonnet', options: [{ id: 'sonnet' }, { id: 'opus' }] }],
})
assert.equal(response.sessionId, 'peri-a')
assert.deepEqual(extractModelConfig(response.configOptions), { model: 'sonnet', models: ['sonnet', 'opus'] })
assert.equal(extractMode(response), 'edit')
assert.deepEqual(sessionResponseObject('legacy-id'), { sessionId: 'legacy-id' })
assert.deepEqual(extractModelConfig(undefined), {})

console.log('acpTypes 回归测试通过')