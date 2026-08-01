import { strict as assert } from 'node:assert'
import { clearMessageStorage, messageStorageKey } from '../src/components/chat/messagePersistence.ts'

assert.equal(messageStorageKey('session-a'), 'pylon-msgs-session-a')

const removed: string[] = []
clearMessageStorage('session-a', { removeItem: key => removed.push(key) })
assert.deepEqual(removed, ['pylon-msgs-session-a'])

console.log('消息持久化清除回归测试通过')
