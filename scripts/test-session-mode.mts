import { strict as assert } from 'node:assert'
import { applySessionModeChange, normalizeSessionMode, nextSessionMode, resolvePreviousSessionMode } from '../src/components/chat/sessionModeState.ts'

const writes: string[] = []
const calls: Array<{ source: string; mode: string }> = []

await applySessionModeChange({
  source: 'local:a',
  nextMode: 'edit',
  previousMode: 'auto',
  writeMode: mode => writes.push(mode),
  invokeSet: async (source, mode) => { calls.push({ source, mode }) },
})
assert.deepEqual(writes, ['edit'])
assert.deepEqual(calls, [{ source: 'local:a', mode: 'edit' }], '必须按 Session.source 调用 set_mode')

writes.length = 0
await assert.rejects(() => applySessionModeChange({
  source: 'local:b',
  nextMode: 'bypass',
  previousMode: 'default',
  writeMode: mode => writes.push(mode),
  invokeSet: async () => { throw new Error('set mode failed') },
}), /set mode failed/)
assert.deepEqual(writes, ['bypass', 'default'], 'set_mode 失败必须回滚旧 mode')

writes.length = 0
await assert.rejects(() => applySessionModeChange({
  source: 'local:c',
  nextMode: 'auto',
  writeMode: mode => writes.push(mode),
  invokeSet: async () => { throw new Error('set mode failed without previous') },
}), /set mode failed without previous/)
assert.deepEqual(writes, ['auto', 'default'], '缺省 previousMode 时必须回滚到明确 default')
assert.equal(resolvePreviousSessionMode(undefined), 'default')
assert.equal(resolvePreviousSessionMode('edit'), 'accept_edit')

assert.equal(nextSessionMode('unknown'), 'accept_edit')
assert.equal(normalizeSessionMode('edit'), 'accept_edit')
assert.equal(normalizeSessionMode('invalid'), null)

console.log('sessionModeState 回归测试通过')
