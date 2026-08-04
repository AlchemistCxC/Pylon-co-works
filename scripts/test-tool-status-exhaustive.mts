import { strict as assert } from 'node:assert'
import { assertNeverToolStatus, normalizeToolStatus, resolveToolPresentationState } from '../src/domains/tool/status.ts'

assert.equal(normalizeToolStatus('pending'), 'queued')
assert.equal(normalizeToolStatus('in_progress'), 'running')
assert.equal(normalizeToolStatus('completed'), 'completed')
assert.equal(normalizeToolStatus('failed'), 'failed')
assert.equal(normalizeToolStatus('cancelled'), 'cancelled')
assert.equal(normalizeToolStatus('future-status'), 'unknown')
assert.equal(resolveToolPresentationState('waiting').tone, 'run')
assert.equal(resolveToolPresentationState('completed').tone, 'ok')
assert.equal(resolveToolPresentationState('failed').tone, 'err')
assert.equal(resolveToolPresentationState(undefined, true).tone, 'ok')
assert.equal(resolveToolPresentationState(undefined, false).tone, 'run')
assert.throws(() => assertNeverToolStatus('invalid' as never), /未处理的工具状态: invalid/)

console.log('ToolVisualState TypeScript 穷举回归测试通过')
