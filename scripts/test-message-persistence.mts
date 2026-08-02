import { strict as assert } from 'node:assert'
import { canPersistMessages, parseMessageSnapshot, persistMessageSnapshot } from '../src/components/chat/messagePersistence.ts'

assert.equal(canPersistMessages({
  ownerId: 'session-a',
  source: 'local:a',
  renderedSessionId: 'session-a',
  renderedSource: 'local:a',
}), true, 'owner、source 与当前 render 一致时应允许持久化')

assert.equal(canPersistMessages({
  ownerId: 'session-a',
  source: 'local:a',
  renderedSessionId: 'session-b',
  renderedSource: 'local:b',
}), false, 'A 的旧消息不得以 B 的 sessionId 持久化')

assert.equal(canPersistMessages({
  ownerId: 'session-a',
  source: 'local:a',
  renderedSessionId: 'session-a',
  renderedSource: 'local:b',
}), false, 'owner 正确但 source 不一致时不得持久化')

assert.equal(canPersistMessages({
  ownerId: null,
  source: null,
  renderedSessionId: 'session-b',
  renderedSource: 'local:b',
}), false, '会话切换清理 owner 后不得持久化')

const writes: Array<[string, string]> = []
const removes: string[] = []
const storage = {
  setItem: (key: string, value: string) => writes.push([key, value]),
  removeItem: (key: string) => removes.push(key),
}

persistMessageSnapshot('session-a', [{ id: 'm1' }], storage)
assert.deepEqual(writes, [['pylon-msgs-session-a', '{"version":1,"messages":[{"id":"m1"}]}']])
persistMessageSnapshot('session-a', [], storage)
assert.deepEqual(removes, ['pylon-msgs-session-a'])

// 2026-08-02 版本 envelope：读取兼容新 envelope 与旧裸数组，损坏返回 null
assert.deepEqual(parseMessageSnapshot('{"version":1,"messages":[{"id":"m1"}]}'), [{ id: 'm1' }])
assert.deepEqual(parseMessageSnapshot('[{"id":"m1"}]'), [{ id: 'm1' }], '旧裸数组格式必须兼容')
assert.equal(parseMessageSnapshot('{"version":1,"messages":"not-array"}'), null)
assert.equal(parseMessageSnapshot('{not json'), null)
assert.equal(parseMessageSnapshot(null), null)

console.log('messagePersistence 回归测试通过')