import { strict as assert } from 'node:assert'
import {
  isCurrentLoadGeneration,
  nextLoadGeneration,
  resolveLoadedMessages,
  serializeLoadedMessages,
} from '../src/components/chat/replayState.ts'
import { test } from 'vitest'

test('replay 状态与 load generation 回归（legacy 迁移）', async () => {
assert.equal(nextLoadGeneration(undefined), 1)
assert.equal(nextLoadGeneration(4), 5)
assert.equal(isCurrentLoadGeneration(5, 5), true)
assert.equal(isCurrentLoadGeneration(4, 5), false)
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: true, cached: ['cached'], replayed: [] }), ['cached'])
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: true, cached: ['cached'], replayed: ['replayed'] }), ['replayed'])
assert.deepEqual(resolveLoadedMessages({ loadSucceeded: false, cached: ['cached'], replayed: ['replayed'] }), ['cached'])
assert.equal(serializeLoadedMessages([]), null)
assert.equal(serializeLoadedMessages(['message']), '["message"]')

console.log('replay 状态与 load generation 回归测试通过')
})
