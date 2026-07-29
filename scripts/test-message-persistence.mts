import { strict as assert } from 'node:assert'
import { canPersistMessages, persistMessageSnapshot } from '../src/components/chat/messagePersistence.ts'

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
assert.deepEqual(writes, [['pylon-msgs-session-a', '[{"id":"m1"}]']])
persistMessageSnapshot('session-a', [], storage)
assert.deepEqual(removes, ['pylon-msgs-session-a'])

console.log('messagePersistence 回归测试通过')