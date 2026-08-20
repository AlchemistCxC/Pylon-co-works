import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatEvent, type ChatRuntimeState } from '../sessionRuntimeStore'
import { toAgentContextKey } from '../../../agentContext'

const source = 'local:identity-replay'
const agentId = 'agent-test'
const key = toAgentContextKey({ agentId, source })
const context = { knownSources: [source], renderedSource: null, now: 1000 }

type TestChatEvent = ChatEvent extends infer Event
  ? Event extends ChatEvent
    ? Omit<Event, 'source' | 'agentId'>
    : never
  : never

function reduce(state: ChatRuntimeState, event: TestChatEvent): ChatRuntimeState {
  return applyChatEvent(state, { ...event, source, agentId } as ChatEvent, context)
}

describe('回放外部 identity 与工具更新边界', () => {
  it('同一 messageId 的 assistant replay chunk 聚合为一条消息', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'message-chunk', text: '第一段', replay: true, externalIdentity: { messageId: 'm-1' } })
    state = reduce(state, { type: 'message-chunk', text: '第二段', replay: true, externalIdentity: { messageId: 'm-1' } })

    expect(state[key]?.messages.map(message => message.content)).toEqual(['第一段第二段'])
  })

  it('相邻无 identity 的 assistant replay chunk 聚合成一条（与 live/canonical 同语义）', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'message-chunk', text: '相', replay: true })
    state = reduce(state, { type: 'message-chunk', text: '同', replay: true })

    expect(state[key]?.messages.map(message => message.content)).toEqual(['相同'])
  })

  it('无 identity → 有 identity 的相邻 replay chunk 聚合，并采用后到的 identity', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'message-chunk', text: '开', replay: true })
    state = reduce(state, { type: 'message-chunk', text: '关', replay: true, externalIdentity: { messageId: 'm-late' } })

    const messages = state[key]?.messages ?? []
    expect(messages.map(message => message.content)).toEqual(['开关'])
    expect(messages[0].externalIdentity).toEqual({ messageId: 'm-late' })
  })

  it('同内容无 identity chunk 隔着 user 事件仍为两条（不按正文跨回合合并）', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'message-chunk', text: '相同', replay: true })
    state = reduce(state, { type: 'user', content: '问题', eventReplay: true })
    state = reduce(state, { type: 'message-chunk', text: '相同', replay: true })

    expect(state[key]?.messages.map(message => message.content)).toEqual(['相同', '问题', '相同'])
  })

  it('system error 后的相邻无 identity chunk 不并入错误消息', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'error', error: 'boom', replay: true, explicitReplay: true })
    state = reduce(state, { type: 'message-chunk', text: '新回复', replay: true })

    expect(state[key]?.messages.map(message => message.content)).toEqual(['boom', '新回复'])
    expect(state[key]?.messages[0]?.sender).toBe('system')
  })

  it('tool update 先到时创建占位卡，后续 tool call 补全同一张卡', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, {
      type: 'tool-call-update', toolCallId: 'tc-1', replay: true,
      rawOutput: '结果', status: 'completed', toolKind: 'read',
    })
    state = reduce(state, {
      type: 'tool-call', toolCallId: 'tc-1', replay: true,
      title: 'Read', toolKind: 'read', rawInput: { path: 'a.txt' },
    })

    const tools = state[key]?.messages.filter(message => message.role === 'tool') ?? []
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: 'tool-tc-1', toolName: 'Read', toolOutput: '结果', toolStatus: 'completed' })
  })
})
