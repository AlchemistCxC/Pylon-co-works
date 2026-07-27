import { strict as assert } from 'node:assert'
import { canPersistMessages } from '../src/components/chat/messagePersistence.ts'

assert.equal(canPersistMessages({
  ownerId: 'session-a',
  source: 'local:a',
  renderedSessionId: 'session-a',
}), true, '消息 owner 与当前 render 一致时应允许持久化')

assert.equal(canPersistMessages({
  ownerId: 'session-a',
  source: 'local:a',
  renderedSessionId: 'session-b',
}), false, 'A 的旧消息不得以 B 的 sessionId 持久化')

assert.equal(canPersistMessages({
  ownerId: null,
  source: null,
  renderedSessionId: 'session-b',
}), false, '会话切换清理 owner 后不得持久化旧消息')

console.log('messagePersistence 回归测试通过')