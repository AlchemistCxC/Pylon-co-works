/**
 * Chat 事件不变量测试（报告 6B）：
 * 未知 source 不建幽灵会话、clear 语义、重复 done 幂等、live/replay 分流、
 * 后台 source 隔离、cancel 恢复。
 */
import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatEvent, type ChatRuntimeState, type ChatRuntimeContext } from '../sessionRuntimeStore'

const KNOWN = ['local:a', 'local:b']

function ctx(overrides: Partial<ChatRuntimeContext> = {}): ChatRuntimeContext {
  return { knownSources: KNOWN, renderedSource: 'local:a', now: 1000, ...overrides }
}

function reduce(state: ChatRuntimeState, event: ChatEvent, context?: ChatRuntimeContext): ChatRuntimeState {
  return applyChatEvent(state, event, context ?? ctx())
}

function userEvent(source: string, content: string): ChatEvent {
  return { type: 'user', source, content }
}

describe('事件不变量（报告 6B）', () => {
  it('未知 source 不创建幽灵会话', () => {
    const state = reduce({}, userEvent('ghost', 'x'))
    expect(state['ghost']).toBeUndefined()
  })

  it('clear 只清消息/summary/plan，保留 generating/cancel 缓冲', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, { type: 'done', source: 'local:a' })
    state = reduce(state, { type: 'clear', source: 'local:a' })
    const source = state['local:a']!
    expect(source.messages).toEqual([])
    expect(source.planEntries).toEqual([])
    expect(source.cancelState).toBeDefined()
  })

  it('重复 done 幂等（不重复追加）', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, { type: 'done', source: 'local:a' })
    const afterFirst = state['local:a']!.messages.length
    state = reduce(state, { type: 'done', source: 'local:a' })
    expect(state['local:a']!.messages.length).toBe(afterFirst)
  })

  it('live 与 replay 消息分流（replay 进缓冲，不混写 live 流）', () => {
    let state = reduce({}, userEvent('local:a', 'live1'))
    // replay user（loadInProgress 期间）
    state = reduce(state, { type: 'user', source: 'local:a', content: 'replay1', loadInProgress: true })
    const source = state['local:a']!
    expect(source.replaying?.some(m => m.content === 'replay1')).toBe(true)
    expect(source.messages.some(m => m.content === 'replay1')).toBe(false)
    expect(source.messages.some(m => m.content === 'live1')).toBe(true)
  })

  it('后台 source 变化不影响前台 source 消息', () => {
    let state = reduce({}, userEvent('local:a', 'a-msg'))
    state = reduce(state, userEvent('local:b', 'b-msg'))
    const aBefore = state['local:a']!.messages.length
    state = reduce(state, { type: 'done', source: 'local:b' })
    expect(state['local:a']!.messages.length).toBe(aBefore)
    expect(state['local:b']!.messages.length).toBeGreaterThanOrEqual(1)
  })

  it('cancel-rejected 后恢复 generating（取消失败，生成继续不悬挂）', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, { type: 'begin-cancel', source: 'local:a' })
    state = reduce(state, { type: 'cancel-rejected', source: 'local:a', error: 'down' })
    const source = state['local:a']!
    expect(source.cancelState?.status).toBe('generating')
    expect(source.cancelState?.error).toBe('down')
    expect(source.generating).toBe(true)
  })

  it('user 消息前清空 running 标记（历史 tool 稳定终态）', () => {
    let state = reduce({}, userEvent('local:a', 'q1'))
    state = reduce(state, { type: 'message-chunk', source: 'local:a', text: 'part' })
    // 直接注入一个 running assistant 消息（模拟流中）
    state = {
      ...state,
      'local:a': {
        ...state['local:a']!,
        messages: [...state['local:a']!.messages, { id: 'm-r', role: 'assistant', sender: 'peri', content: 'streaming', running: true, time: '0' }],
      },
    }
    state = reduce(state, userEvent('local:a', 'q2'))
    expect(state['local:a']!.messages.some(m => m.running)).toBe(false)
  })
})
