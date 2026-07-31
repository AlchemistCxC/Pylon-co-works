import { strict as assert } from 'node:assert'
import { assertNeverToolStatus, normalizeToolStatus, resolveToolVisualStatus } from '../src/components/chat/toolStatus.ts'

assert.equal(normalizeToolStatus('pending'), 'queued')
assert.equal(normalizeToolStatus('in_progress'), 'running')
assert.equal(normalizeToolStatus('completed'), 'completed')
assert.equal(normalizeToolStatus('failed'), 'failed')
assert.equal(normalizeToolStatus('cancelled'), 'cancelled')
assert.equal(normalizeToolStatus('future-status'), 'unknown')
assert.equal(resolveToolVisualStatus('waiting'), 'run')
assert.equal(resolveToolVisualStatus('completed'), 'ok')
assert.equal(resolveToolVisualStatus('failed'), 'err')
assert.equal(resolveToolVisualStatus(undefined, true), 'ok')
assert.equal(resolveToolVisualStatus(undefined, false), 'run')
assert.throws(() => assertNeverToolStatus('invalid' as never), /未处理的工具状态: invalid/)

console.log('ToolVisualState TypeScript 穷举回归测试通过')
