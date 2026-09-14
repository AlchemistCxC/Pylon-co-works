// 迁移自 scripts/test-chat-mock-data.mts（P91 A1，并入 demo 测试）
import { describe, expect, it } from 'vitest'
import { MOCK_MESSAGES, createMockMessages } from '../../components/chat/chatMockData.ts'

describe('ChatView mock display 场景（demo fixture 角色覆盖）', () => {
  it('mock 覆盖足够长的完整对话场景', () => {
    expect(MOCK_MESSAGES.length >= 20).toBe(true)
    expect(MOCK_MESSAGES.filter(message => message.role === 'reasoning').length >= 4).toBe(true)
    expect(MOCK_MESSAGES.filter(message => message.role === 'tool').length >= 12).toBe(true)
  })

  it('reasoning 消息带 thought 时长与开始时间', () => {
    expect(MOCK_MESSAGES.some(message => message.role === 'reasoning' && message.thoughtDurationMs && message.thoughtDurationMs > 0)).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'reasoning' && message.thoughtStartedAt)).toBe(true)
  })

  it('tool 消息覆盖 ANSI 输出与全部 toolStatus 分支', () => {
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolName === 'Bash' && message.toolOutput?.includes('\u001b'))).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'completed')).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'failed')).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'in_progress' && message.running === true)).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'waiting')).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'queued')).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'cancelled')).toBe(true)
    expect(MOCK_MESSAGES.some(message => message.role === 'tool' && message.toolStatus === 'future-status')).toBe(true)
  })

  it('覆盖空 assistant 消息与超长 toolOutput 行数', () => {
    expect(MOCK_MESSAGES.some(message => message.role === 'assistant' && message.content === '')).toBe(true)
    expect(MOCK_MESSAGES.some(message => (message.toolOutput?.split('\n').length || 0) > 30)).toBe(true)
  })

  it('createMockMessages 返回深等的新副本', () => {
    const cloned = createMockMessages()
    expect(cloned).not.toBe(MOCK_MESSAGES)
    expect(cloned).toEqual(MOCK_MESSAGES)
  })
})
