import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { normalizeToolId, shouldAcceptToolCall } from '../src/components/chat/replayState.ts'

const source = readFileSync(new URL('../src/components/chat/chatEventController.ts', import.meta.url), 'utf8')

assert.equal(normalizeToolId(' tool-1 '), 'tool-1')
assert.equal(normalizeToolId(''), null)
assert.equal(normalizeToolId('   '), null)
assert.equal(normalizeToolId(undefined), null)
assert.equal(shouldAcceptToolCall('tool-1', []), true)
assert.equal(shouldAcceptToolCall('tool-1', ['tool-1']), false)
assert.equal(shouldAcceptToolCall('', []), false)
assert.match(source, /const toolId = normalizeToolId\(upd\.toolCallId\)/, 'tool_call 必须先归一化 ID')
assert.match(source, /shouldAcceptToolCall\(toolId, refs\.replayToolIdsRef\.current\[source\]/, 'replay tool_call 必须拒绝缺失和重复 ID')
assert.match(source, /if \(!toolId\) break/, 'tool_call_update 缺失 ID 必须安全忽略')
assert.match(source, /refs\.replayToolIdsRef\.current\[source\] =/, 'replay tool ID 必须按 source 隔离记录')

console.log('replay Tool ID 缺失/重复/乱序防护回归测试通过')
