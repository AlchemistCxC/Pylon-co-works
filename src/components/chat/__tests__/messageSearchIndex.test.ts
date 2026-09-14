// 迁移自 scripts/test-message-search-index.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { getMessageSearchText, messageMatchesQuery } from '../messageSearchIndex.ts'
import type { Message } from '../messageTypes.ts'

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

describe('message search index（迁移自 scripts/test-message-search-index.mts，P91 A1）', () => {
  it('搜索文本 memo 稳定且包含 toolInput/toolOutput', () => {
    const first = getMessageSearchText(tool)
    const second = getMessageSearchText(tool)
    expect(first).toBe(second)
    expect(first).toMatch(/src\/main\.ts/)
    expect(first).toMatch(/export const ready = true/)
  })

  it('query 匹配大小写不敏感；空白 query 恒真；无命中为假', () => {
    expect(messageMatchesQuery(tool, 'MAIN.TS')).toBe(true)
    expect(messageMatchesQuery(tool, 'missing-value')).toBe(false)
    expect(messageMatchesQuery(tool, '  ')).toBe(true)
  })

  it('assistant 正文可命中中文 query', () => {
    const assistant: Message = {
      id: 'assistant-1',
      role: 'assistant',
      sender: 'peri',
      content: '构建已经通过。',
      time: '10:01',
    }
    expect(messageMatchesQuery(assistant, '构建')).toBe(true)
  })
})
