// 迁移自 scripts/test-message-types-exhaustive.mts（P91 A1）
import { describe, expect, it } from 'vitest'
import { assertNever, toRenderMessage, type Message } from '../messageTypes.ts'

const base: Message = { id: 'm', role: 'assistant', sender: 'peri', content: 'ok', time: '10:00' }

describe('RenderMessage role 穷举映射（迁移自 scripts/test-message-types-exhaustive.mts，P91 A1）', () => {
  it('四个已知 role 映射到对应 RenderMessage type', () => {
    expect(toRenderMessage({ ...base, role: 'user' }).type).toBe('user')
    expect(toRenderMessage({ ...base, role: 'assistant' }).type).toBe('assistant')
    expect(toRenderMessage({ ...base, role: 'reasoning' }).type).toBe('reasoning')
    expect(toRenderMessage({ ...base, role: 'tool' }).type).toBe('tool_call')
  })

  it('tool 带 toolOutput → tool_result；sender system → error', () => {
    expect(toRenderMessage({
      ...base,
      role: 'tool',
      toolOutput: 'done',
    }).type).toBe('tool_result')
    expect(toRenderMessage({ ...base, sender: 'system' }).type).toBe('error')
  })

  it('未知 role 回退 system；assertNever 抛出带上下文的错误', () => {
    expect(toRenderMessage({ ...base, role: 'future-role' as Message['role'] }).type).toBe('system')
    expect(() => assertNever('unexpected' as never, '测试')).toThrow(/测试: unexpected/)
  })
})
