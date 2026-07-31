import { strict as assert } from 'node:assert'
import { getMessageSearchText, messageMatchesQuery, warmMessageSearchIndex } from '../src/components/chat/messageSearchIndex.ts'
import type { Message } from '../src/components/chat/messageTypes.ts'

const tool: Message = {
  id: 'tool-read',
  role: 'tool',
  sender: 'tool:Read',
  content: '',
  time: '10:00',
  toolName: 'Read',
  toolInput: 'src/main.ts',
  toolOutput: 'export const ready = true',
}

const first = getMessageSearchText(tool)
const second = getMessageSearchText(tool)
assert.equal(first, second)
assert.match(first, /src\/main\.ts/)
assert.match(first, /export const ready = true/)
assert.equal(messageMatchesQuery(tool, 'MAIN.TS'), true)
assert.equal(messageMatchesQuery(tool, 'missing-value'), false)
assert.equal(messageMatchesQuery(tool, '  '), true)

const assistant: Message = {
  id: 'assistant-1',
  role: 'assistant',
  sender: 'peri',
  content: '构建已经通过。',
  time: '10:01',
}
assert.equal(messageMatchesQuery(assistant, '构建'), true)

const warmMessages = Array.from({ length: 3 }, (_, index): Message => ({
  id: `warm-${index}`,
  role: 'assistant',
  sender: 'peri',
  content: `消息 ${index}`,
  time: '10:02',
}))
await warmMessageSearchIndex(warmMessages, 2)
assert.equal(messageMatchesQuery(warmMessages[2], '消息 2'), true)
await warmMessageSearchIndex(warmMessages, 0)
assert.equal(messageMatchesQuery(warmMessages[0], '消息 0'), true)

console.log('message search index 回归测试通过')
