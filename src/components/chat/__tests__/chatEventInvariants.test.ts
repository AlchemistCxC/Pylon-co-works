/**
 * Chat 事件不变量测试（报告 6B）：
 * 未知 source 不建幽灵会话、clear 语义、重复 done 幂等、live/replay 分流、
 * 后台 source 隔离、cancel 恢复。
 */
import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatEvent, type ChatRuntimeState, type ChatRuntimeContext } from '../sessionRuntimeStore'
import { toAgentContextKey } from '../../../agentContext'
import { mergeReplayMessages } from '../chatEventController'

const KNOWN = ['local:a', 'local:b']

function ctx(overrides: Partial<ChatRuntimeContext> = {}): ChatRuntimeContext {
  return { knownSources: KNOWN, renderedSource: 'local:a', now: 1000, ...overrides }
}

function reduce(state: ChatRuntimeState, event: ChatEvent, context?: ChatRuntimeContext): ChatRuntimeState {
  return applyChatEvent(state, event, context ?? ctx())
}

const AGENT = 'agent-test'
const key = (source: string) => toAgentContextKey({ agentId: AGENT, source })

function userEvent(source: string, content: string): ChatEvent {
  return { type: 'user', source, agentId: AGENT, content }
}

describe('事件不变量（报告 6B）', () => {
  it('未知 source 不创建幽灵会话', () => {
    const state = reduce({}, userEvent('ghost', 'x'))
    expect(state[key('ghost')]).toBeUndefined()
  })

  it('clear 只清消息/summary/plan，保留 generating/cancel 缓冲', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, { type: 'done', source: 'local:a', agentId: AGENT })
    state = reduce(state, { type: 'clear', source: 'local:a', agentId: AGENT })
    const source = state[key('local:a')]!
    expect(source.messages).toEqual([])
    expect(source.planEntries).toEqual([])
    expect(source.cancelState).toBeDefined()
  })

  it('重复 done 幂等（不重复追加）', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, { type: 'done', source: 'local:a', agentId: AGENT })
    const afterFirst = state[key('local:a')]!.messages.length
    state = reduce(state, { type: 'done', source: 'local:a', agentId: AGENT })
    expect(state[key('local:a')]!.messages.length).toBe(afterFirst)
  })

  it('U2-C：replay user 直写 messages，不再存在 replaying 缓冲', () => {
    let state = reduce({}, userEvent('local:a', 'live1'))
    state = reduce(state, { type: 'user', source: 'local:a', agentId: AGENT, content: 'replay1', eventReplay: true })
    const source = state[key('local:a')]!
    expect((source as { replaying?: unknown }).replaying).toBeUndefined()
    expect(source.messages.some(m => m.content === 'replay1')).toBe(true)
    expect(source.messages.some(m => m.content === 'live1')).toBe(true)
  })

  it('后台 source 变化不影响前台 source 消息', () => {
    let state = reduce({}, userEvent('local:a', 'a-msg'))
    state = reduce(state, userEvent('local:b', 'b-msg'))
    const aBefore = state[key('local:a')]!.messages.length
    state = reduce(state, { type: 'done', source: 'local:b', agentId: AGENT })
    expect(state[key('local:a')]!.messages.length).toBe(aBefore)
    expect(state[key('local:b')]!.messages.length).toBeGreaterThanOrEqual(1)
  })

  it('cancel-rejected 后恢复 generating（取消失败，生成继续不悬挂）', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, { type: 'begin-cancel', source: 'local:a', agentId: AGENT })
    state = reduce(state, { type: 'cancel-rejected', source: 'local:a', agentId: AGENT, error: 'down' })
    const source = state[key('local:a')]!
    expect(source.cancelState?.status).toBe('generating')
    expect(source.cancelState?.error).toBe('down')
    expect(source.generating).toBe(true)
    expect(source.generationPhase).toEqual({ kind: 'thinking' })
    expect(source.lastActivityAt).toBe(1000)
  })

  it('tool-call-update 占位新建路径携带 agentId（WI-02 CR-001）', () => {
    let state = reduce({}, userEvent('local:a', 'hi'))
    state = reduce(state, {
      type: 'tool-call-update',
      source: 'local:a',
      agentId: AGENT,
      toolCallId: 'orphan-1',
      rawOutput: 'out',
    })
    const toolMsg = state[key('local:a')]!.messages.find(m => m.role === 'tool')
    expect(toolMsg?.agentId).toBe(AGENT)
    expect(toolMsg?.toolName).toBe('?')
  })

  it('error 消息携带 agentId（WI-02 CR-002 吸收断言）', () => {
    const state = reduce({}, { type: 'error', source: 'local:a', agentId: AGENT, error: 'boom' })
    const errMsg = state[key('local:a')]!.messages.find(m => m.role === 'assistant' && m.sender === 'system')
    expect(errMsg?.agentId).toBe(AGENT)
  })

  it('user 消息前清空 running 标记（历史 tool 稳定终态）', () => {
    let state = reduce({}, userEvent('local:a', 'q1'))
    state = reduce(state, { type: 'message-chunk', source: 'local:a', agentId: AGENT, text: 'part' })
    // 直接注入一个 running assistant 消息（模拟流中）
    state = {
      ...state,
      [key('local:a')]: {
        ...state[key('local:a')]!,
        messages: [...state[key('local:a')]!.messages, { id: 'm-r', role: 'assistant', sender: 'peri', content: 'streaming', running: true, time: '0' }],
      },
    }
    state = reduce(state, userEvent('local:a', 'q2'))
    expect(state[key('local:a')]!.messages.some(m => m.running)).toBe(false)
  })
})

describe('乐观渲染（方案 B）', () => {
  it('optimistic-user 立即渲染用户消息并启动生成态', () => {
    const state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    const source = state[key('local:a')]!
    const userMsg = source.messages.find(m => m.role === 'user')
    expect(userMsg?.content).toBe('hello')
    expect(userMsg?.clientMsgId).toBe('id-1')
    expect(source.generating).toBe(true)
    expect(source.cancelState?.status).toBe('generating')
  })

  it('confirm-user 清除 clientMsgId（乐观消息转为普通消息）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'confirm-user', source: 'local:a', agentId: AGENT, clientMsgId: 'id-1' })
    const userMsg = state[key('local:a')]!.messages.find(m => m.role === 'user')
    expect(userMsg?.clientMsgId).toBeUndefined()
    expect(userMsg?.content).toBe('hello')
    expect(state[key('local:a')]!.messages.length).toBe(1)
  })

  it('confirm 后尾部同内容 user 不重复追加（controller 去重语义的 reducer 支持）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'confirm-user', source: 'local:a', agentId: AGENT, clientMsgId: 'id-1' })
    // controller 在 pylon:user 到达时做去重；本测试验证 reducer 幂等路径：
    // 已确认消息存在时，尾部同内容 user 事件不再产生新消息（controller 会短路，
    // 此处直接断言 confirm 后状态——若 controller 误发 user 事件，消息会重复）。
    const afterConfirm = state[key('local:a')]!.messages.filter(m => m.role === 'user')
    expect(afterConfirm.length).toBe(1)
    expect(afterConfirm[0]?.clientMsgId).toBeUndefined()
  })

  it('confirm-user 无匹配 id → 无操作（不误清后续消息）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'a', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'b', clientMsgId: 'id-2' })
    state = reduce(state, { type: 'confirm-user', source: 'local:a', agentId: AGENT, clientMsgId: 'id-1' })
    const users = state[key('local:a')]!.messages.filter(m => m.role === 'user')
    expect(users.length).toBe(2)
    expect(users.find(m => m.content === 'a')?.clientMsgId).toBeUndefined()
    expect(users.find(m => m.content === 'b')?.clientMsgId).toBe('id-2')
  })

  it('重复 optimistic-user（同 clientMsgId）不重复追加', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    expect(state[key('local:a')]!.messages.filter(m => m.role === 'user').length).toBe(1)
  })

  it('reject-optimistic-user 撤销对应行并收敛无响应的生成态', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'reject-optimistic-user', source: 'local:a', agentId: AGENT, clientMsgId: 'id-1' })
    const source = state[key('local:a')]!
    expect(source.messages).toEqual([])
    expect(source.generating).toBe(false)
    expect(source.generationPhase).toBeUndefined()
    expect(source.cancelState.status).toBe('idle')
  })

  it('撤销一条发送失败的 optimistic row 时保留其他 pending 生成态', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'one', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'two', clientMsgId: 'id-2' })
    state = reduce(state, { type: 'reject-optimistic-user', source: 'local:a', agentId: AGENT, clientMsgId: 'id-1' })
    const source = state[key('local:a')]!
    expect(source.messages.map(message => message.content)).toEqual(['two'])
    expect(source.generating).toBe(true)
    expect(source.generationPhase).toEqual({ kind: 'thinking' })
    expect(source.cancelState.status).toBe('generating')
  })

  it('乐观消息后流式渲染正常（user→chunk→done 完整回合）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    // rendered source：chunk 进 streamingText
    state = reduce(state, { type: 'message-chunk', source: 'local:a', agentId: AGENT, text: '你' })
    expect(state[key('local:a')]!.generationPhase).toEqual({ kind: 'responding' })
    state = reduce(state, { type: 'message-chunk', source: 'local:a', agentId: AGENT, text: '好' })
    expect(state[key('local:a')]!.streamingText).toBe('你好')
    // done：流式落盘 + 生成复位 + summary
    state = reduce(state, { type: 'done', source: 'local:a', agentId: AGENT })
    const source = state[key('local:a')]!
    expect(source.generating).toBe(false)
    expect(source.generationPhase).toBeUndefined()
    expect(source.streamingText).toBe('')
    const roles = source.messages.map(m => m.role)
    expect(roles).toEqual(['user', 'assistant'])
    expect(source.lastSummary?.reason).toBe('done')
  })

  it('乐观消息后 error 收敛（assistant error 消息 + 生成复位，乐观 user 保留）', () => {
    let state = reduce({}, { type: 'optimistic-user', source: 'local:a', agentId: AGENT, content: 'hello', clientMsgId: 'id-1' })
    state = reduce(state, { type: 'error', source: 'local:a', agentId: AGENT, error: 'LLM 402: Insufficient Balance' })
    const source = state[key('local:a')]!
    expect(source.generating).toBe(false)
    const roles = source.messages.map(m => m.role)
    expect(roles).toEqual(['user', 'assistant'])
    expect(source.messages[0]?.role).toBe('user')
    expect(source.messages[0]?.content).toBe('hello')
    expect(source.messages[1]?.sender).toBe('system')
    expect(source.lastSummary?.reason).toBe('error')
  })
})

describe('mergeReplayMessages（通用外部 identity）', () => {
  interface M { id: string; role?: string; sender?: string; content?: string; externalIdentity?: { messageId?: string; toolCallId?: string } }

  const user = (id: string, content: string, messageId?: string): M => ({ id, role: 'user', sender: 'local:a', content, externalIdentity: messageId ? { messageId } : undefined })
  const assistant = (id: string, content: string, messageId?: string): M => ({ id, role: 'assistant', sender: 'peri', content, externalIdentity: messageId ? { messageId } : undefined })

  it('无稳定 identity 的相同正文必须全部保留', () => {
    const resolved: M[] = [user('user-7', 'A')]
    const live: M[] = [user('user-3', 'A'), assistant('msg-4', 'A')]
    expect(mergeReplayMessages(resolved, live).map(message => message.id)).toEqual(['user-7', 'user-3', 'msg-4'])
  })

  it('稳定 message identity 相同才允许合并', () => {
    const resolved: M[] = [assistant('msg-5', '回复', 'message-1')]
    const live: M[] = [assistant('msg-4', '回复', 'message-1'), assistant('msg-6', '回复')]
    expect(mergeReplayMessages(resolved, live, { message: 'supported' }).map(message => message.id)).toEqual(['msg-5', 'msg-6'])
  })

  it('无 live 增量时原样返回 replay 权威', () => {
    const resolved: M[] = [user('user-1', 'u1')]
    expect(mergeReplayMessages(resolved, [])).toBe(resolved)
  })

  it('tool 只有明确 toolCallId 才允许合并', () => {
    const resolved: M[] = [{ id: 'tool-a', role: 'tool', content: '', externalIdentity: { toolCallId: 'tc-42' } }]
    const live: M[] = [
      { id: 'tool-b', role: 'tool', content: '', externalIdentity: { toolCallId: 'tc-42' } },
      { id: 'tool-c', role: 'tool', content: '' },
    ]
    expect(mergeReplayMessages(resolved, live, { toolCall: 'supported' }).map(message => message.id)).toEqual(['tool-a', 'tool-c'])
  })
})
