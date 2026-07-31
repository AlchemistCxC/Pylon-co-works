import { strict as assert } from 'node:assert'
import { MOCK_MESSAGES, createMockMessages } from '../src/components/chat/chatMockData.ts'

assert.ok(MOCK_MESSAGES.length >= 15, 'mock 必须覆盖完整消息场景')
assert.ok(MOCK_MESSAGES.some(message => message.role === 'user'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'assistant' && message.content.includes('```')))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'assistant' && message.content.includes('| 项目 |')))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'reasoning'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolName === 'Bash' && message.toolOutput?.includes('\u001b')))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'completed'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'failed'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'in_progress' && message.running === true))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'waiting'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'queued'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'cancelled'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'future-status'))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'assistant' && message.content === ''))
assert.ok(MOCK_MESSAGES.some(message => (message.toolOutput?.split('\n').length || 0) > 30))

const cloned = createMockMessages()
assert.notEqual(cloned, MOCK_MESSAGES)
assert.deepEqual(cloned, MOCK_MESSAGES)

console.log('ChatView mock display 场景回归测试通过')
