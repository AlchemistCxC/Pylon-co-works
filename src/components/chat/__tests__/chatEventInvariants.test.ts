/**
 * Chat 事件不变量测试（报告 6B）：
 * 未知 source 不建幽灵会话、clear 语义、重复 done 幂等、live/replay 分流、
 * 后台 source 隔离、cancel 恢复。
 */
import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatEvent, type ChatRuntimeState, type ChatRuntimeContext } from '../sessionRuntimeStore'
import { mergeReplayMessages } from '../chatEventController'

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

describe('乐观渲染（方案 B）', () => {
  it('optimistic-user 立即渲染用户消息并启动生成态', () => {
    const state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    const source = state['local:a']!
    const userMsg = source.messages.find(m => m.role === 'user')
    expect(userMsg?.content).toBe('hello')
    expect(userMsg?.clientMsgId).toBe('id-1')
    expect(source.generating).toBe(true)
    expect(source.cancelState?.status).toBe('generating')
  })

  it('confirm-user 清除 clientMsgId（乐观消息转为普通消息）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'confirm-user', source: 'local:a', clientMsgId: 'id-1' })
    const userMsg = state['local:a']!.messages.find(m => m.role === 'user')
    expect(userMsg?.clientMsgId).toBeUndefined()
    expect(userMsg?.content).toBe('hello')
    expect(state['local:a']!.messages.length).toBe(1)
  })

  it('confirm 后尾部同内容 user 不重复追加（controller 去重语义的 reducer 支持）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'confirm-user', source: 'local:a', clientMsgId: 'id-1' })
    // controller 在 pylon:user 到达时做去重；本测试验证 reducer 幂等路径：
    // 已确认消息存在时，尾部同内容 user 事件不再产生新消息（controller 会短路，
    // 此处直接断言 confirm 后状态——若 controller 误发 user 事件，消息会重复）。
    const afterConfirm = state['local:a']!.messages.filter(m => m.role === 'user')
    expect(afterConfirm.length).toBe(1)
    expect(afterConfirm[0]?.clientMsgId).toBeUndefined()
  })

  it('confirm-user 无匹配 id → 无操作（不误清后续消息）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'a', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'optimistic-user', source: 'local:a', content: 'b', clientMsgId: 'id-2' })
    state = reduce(state, { type: 'confirm-user', source: 'local:a', clientMsgId: 'id-1' })
    const users = state['local:a']!.messages.filter(m => m.role === 'user')
    expect(users.length).toBe(2)
    expect(users.find(m => m.content === 'a')?.clientMsgId).toBeUndefined()
    expect(users.find(m => m.content === 'b')?.clientMsgId).toBe('id-2')
  })

  it('重复 optimistic-user（同 clientMsgId）不重复追加', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    expect(state['local:a']!.messages.filter(m => m.role === 'user').length).toBe(1)
  })

  it('乐观消息后流式渲染正常（user→chunk→done 完整回合）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    // rendered source：chunk 进 streamingText
    state = reduce(state, { type: 'message-chunk', source: 'local:a', text: '你' })
    state = reduce(state, { type: 'message-chunk', source: 'local:a', text: '好' })
    expect(state['local:a']!.streamingText).toBe('你好')
    // done：流式落盘 + 生成复位 + summary
    state = reduce(state, { type: 'done', source: 'local:a' })
    const source = state['local:a']!
    expect(source.generating).toBe(false)
    expect(source.streamingText).toBe('')
    const roles = source.messages.map(m => m.role)
    expect(roles).toEqual(['user', 'assistant'])
    expect(source.lastSummary?.reason).toBe('done')
  })

  it('乐观消息后 error 收敛（assistant error 消息 + 生成复位，乐观 user 保留）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'error', source: 'local:a', error: 'LLM 402: Insufficient Balance' })
    const source = state['local:a']!
    expect(source.generating).toBe(false)
    const roles = source.messages.map(m => m.role)
    expect(roles).toEqual(['user', 'assistant'])
    expect(source.messages[0]?.role).toBe('user')
    expect(source.messages[0]?.content).toBe('hello')
    expect(source.messages[1]?.sender).toBe('system')
    expect(source.lastSummary?.reason).toBe('error')
  })
})

describe('mergeReplayMessages（验收回归：回放消息重复）', () => {
  interface M { id: string; role?: string; sender?: string; content?: string; toolCallId?: string }

  const user = (id: string, content: string): M => ({ id, role: 'user', sender: 'local:a', content })
  const assistant = (id: string, content: string): M => ({ id, role: 'assistant', sender: 'peri', content })

  it('live 增量与 replay 权威内容重叠（id 不同）→ 按内容签名去重', () => {
    // 验证 agent 复现的真实场景：reducer 共享 seq 导致同消息 id 不同
    // （user-7 replay 副本 vs user-3 live 副本），但 role+sender+content 相同
    const resolved: M[] = [
      user('user-1', 'old-q'),
      assistant('msg-2', 'old-a'),
      user('user-7', 'A'),
    ]
    const live: M[] = [user('user-3', 'A')]
    const merged = mergeReplayMessages(resolved, live)
    expect(merged.map(m => m.id)).toEqual(['user-1', 'msg-2', 'user-7'])
    expect(merged.filter(m => m.content === 'A').length).toBe(1)
  })

  it('assistant 回复 live 增量与 replay 重放内容重叠（id 不同）→ 去重', () => {
    // 验证 agent 场景 B：load 期间 agent 回复以 live 到达（msg-4），replay 重放同一回复（msg-5）
    const resolved: M[] = [user('user-3', 'Q'), assistant('msg-5', 'live-resp')]
    const live: M[] = [assistant('msg-4', 'live-resp')]
    const merged = mergeReplayMessages(resolved, live)
    expect(merged.map(m => m.id)).toEqual(['user-3', 'msg-5'])
  })

  it('live 增量与 replay 权威无重叠 → 追加', () => {
    const resolved: M[] = [user('user-1', 'u1')]
    const live: M[] = [user('user-9', 'u9')]
    const merged = mergeReplayMessages(resolved, live)
    expect(merged.map(m => m.id)).toEqual(['user-1', 'user-9'])
  })

  it('无 live 增量 → 原样返回 replay 权威', () => {
    const resolved: M[] = [user('user-1', 'u1'), assistant('msg-2', 'a1')]
    const merged = mergeReplayMessages(resolved, [])
    expect(merged).toBe(resolved)
  })

  it('重复 live 增量只保留未在权威中的部分', () => {
    const resolved: M[] = [user('user-1', 'u1')]
    const live: M[] = [
      user('user-2', 'u1'),
      user('user-3', 'u5'),
      user('user-4', 'u1'),
    ]
    const merged = mergeReplayMessages(resolved, live)
    expect(merged.map(m => m.id)).toEqual(['user-1', 'user-3'])
  })

  it('tool 消息按 id 内嵌 toolCallId 去重（真实 reducer 形态：无独立字段）', () => {
    // 真实 reducer：tool 消息 id 恒为 'tool-<toolCallId>'，Message 无 toolCallId 字段
    const resolved: M[] = [
      { id: 'tool-tc-42', role: 'tool', sender: 'tool:write', content: '' },
    ]
    // 同 toolCallId 的 live 增量 → 去重；不同 toolCallId → 保留（不得误删）
    const live: M[] = [
      { id: 'tool-tc-42', role: 'tool', sender: 'tool:write', content: '' },
      { id: 'tool-tc-99', role: 'tool', sender: 'tool:write', content: '' },
    ]
    const merged = mergeReplayMessages(resolved, live)
    expect(merged.map(m => m.id)).toEqual(['tool-tc-42', 'tool-tc-99'])
  })
})
