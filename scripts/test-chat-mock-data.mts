import { strict as assert } from 'node:assert'
import { MOCK_MESSAGES, createMockMessages } from '../src/components/chat/chatMockData.ts'

assert.ok(MOCK_MESSAGES.length >= 20, 'mock 必须覆盖足够长的完整对话场景')
assert.ok(MOCK_MESSAGES.filter(message => message.role === 'reasoning').length >= 4)
assert.ok(MOCK_MESSAGES.filter(message => message.role === 'tool').length >= 12)
assert.ok(MOCK_MESSAGES.some(message => message.role === 'reasoning' && message.thoughtDurationMs && message.thoughtDurationMs > 0))
assert.ok(MOCK_MESSAGES.some(message => message.role === 'reasoning' && message.thoughtStartedAt))
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
