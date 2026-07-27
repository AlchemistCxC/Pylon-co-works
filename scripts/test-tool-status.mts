import { strict as assert } from 'node:assert'
import { resolveToolVisualStatus } from '../src/components/chat/toolStatus.ts'

assert.equal(resolveToolVisualStatus('pending'), 'run')
assert.equal(resolveToolVisualStatus('in_progress'), 'run')
assert.equal(resolveToolVisualStatus('completed'), 'ok')
assert.equal(resolveToolVisualStatus('failed'), 'err')
assert.equal(resolveToolVisualStatus('error'), 'err')
assert.equal(resolveToolVisualStatus(undefined, true), 'ok')
assert.equal(resolveToolVisualStatus(undefined, false), 'run')

console.log('toolStatus 回归测试通过')
