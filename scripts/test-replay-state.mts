import { strict as assert } from 'node:assert'
import {
  isCurrentLoadGeneration,
  isReplayEvent,
  nextLoadGeneration,
  resolveLoadedMessages,
  resolveReplayEventMode,
  serializeLoadedMessages,
  shouldStartLiveGeneration,
} from '../src/components/chat/replayState.ts'

assert.equal(resolveReplayEventMode({ eventReplay: false, loadInProgress: true }), 'buffer')
assert.equal(resolveReplayEventMode({ eventReplay: true, loadInProgress: true }), 'buffer')
assert.equal(resolveReplayEventMode({ eventReplay: true, loadInProgress: false }), 'late')
assert.equal(resolveReplayEventMode({ eventReplay: false, loadInProgress: false }), 'live')
assert.equal(isReplayEvent({ eventReplay: true, loadInProgress: false }), true)
assert.equal(isReplayEvent({ eventReplay: false, loadInProgress: true }), true)
assert.equal(isReplayEvent({ eventReplay: false, loadInProgress: false }), false)
assert.equal(shouldStartLiveGeneration({ replay: false }), true)
assert.equal(shouldStartLiveGeneration({ replay: true }), false)
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
