import { strict as assert } from 'node:assert'
import { extractMode, extractUsage, sessionResponseObject } from '../src/components/chat/acpTypes.ts'
import { nextSessionMode } from '../src/components/chat/sessionModeState.ts'

const response = sessionResponseObject({
  sessionId: 'peri-a',
  modes: { currentModeId: 'accept_edit' },
})
assert.equal(extractMode(response), 'accept_edit', '应保留 Peri 的 accept_edit mode ID')
assert.equal(nextSessionMode('default'), 'accept_edit', 'default 下一项必须是 Peri 接受的 accept_edit')
assert.equal(nextSessionMode('accept_edit'), 'auto')
assert.equal(nextSessionMode('auto'), 'bypass')
assert.equal(nextSessionMode('bypass'), 'default')
assert.equal(nextSessionMode('edit'), 'auto', '兼容旧前端 edit 值，但不得再发出 edit')

assert.deepEqual(extractUsage({
  sessionUpdate: 'usage_update',
  used: 3210,
  size: 200000,
  _meta: { cacheReadTokens: 987 },
}), {
  tokensUsed: 3210,
  tokensMax: 200000,
  cacheReadTokens: 987,
}, '应读取 ACP UsageUpdate 的标准 used/size 字段')

assert.deepEqual(extractUsage({
  sessionUpdate: 'usage_update',
  value: 123,
  size: 1000,
}), {
  tokensUsed: 123,
  tokensMax: 1000,
  cacheReadTokens: 0,
}, '应兼容旧 value 字段')

console.log('session context and mode tests passed')
