import { strict as assert } from 'node:assert'
import { resolveToolPresentationState } from '../src/domains/tool/status.ts'

assert.equal(resolveToolPresentationState('pending').tone, 'run')
assert.equal(resolveToolPresentationState('in_progress').tone, 'run')
assert.equal(resolveToolPresentationState('completed').tone, 'ok')
assert.equal(resolveToolPresentationState('failed').tone, 'err')
assert.equal(resolveToolPresentationState('error').tone, 'err')
assert.equal(resolveToolPresentationState(undefined, true).tone, 'ok')
assert.equal(resolveToolPresentationState(undefined, false).tone, 'run')

console.log('toolStatus 回归测试通过（B2 唯一 API）')
