/**
 * U2-C：replay/live 单一路径回归。
 * replay 事件直写 messages（不再存在 replaying 缓冲）；作用域由事件标志承载。
 */
import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatEvent, type ChatRuntimeState } from '../sessionRuntimeStore'
import { toAgentContextKey } from '../../../agentContext'

const source = 'local:u2c'
const agentId = 'agent-u2c'
const key = toAgentContextKey({ agentId, source })
const context = { knownSources: [source], renderedSource: null, now: 1_000_000 }

function reduce(state: ChatRuntimeState, event: ChatEvent): ChatRuntimeState {
  return applyChatEvent(state, event, context)
}

describe('U2-C replay/live 单一路径', () => {
  it('replay 事件直写 messages：user/chunk/tool/done 不产生 replaying 缓冲', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'user', source, agentId, content: 'r-user', eventReplay: true })
    state = reduce(state, { type: 'thought-chunk', source, agentId, text: '思考', replay: true })
    state = reduce(state, { type: 'tool-call', source, agentId, toolCallId: 'tc-1', title: 'Read', replay: true })
    state = reduce(state, { type: 'tool-call-update', source, agentId, toolCallId: 'tc-1', rawOutput: 'ok', status: 'completed', replay: true })
    state = reduce(state, { type: 'done', source, agentId, replay: true, explicitReplay: true })

    const runtime = state[key]!
    expect((runtime as { replaying?: unknown }).replaying).toBeUndefined()
    expect(runtime.messages.map(message => message.role)).toEqual(['user', 'reasoning', 'tool'])
    expect(runtime.messages[2]).toMatchObject({ id: 'tool-tc-1', toolStatus: 'completed', running: false })
    expect(runtime.generating).toBe(false)
    expect(runtime.lastSummary).toBeUndefined()
  })

  it('replay done 无 summary；live done 写 summary（作用域由事件标志决定）', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'user', source, agentId, content: 'live', eventReplay: true })
    state = reduce(state, { type: 'done', source, agentId, replay: true })
    expect(state[key]!.lastSummary).toBeUndefined()

    state = reduce(state, { type: 'user', source, agentId, content: 'live2' })
    state = reduce(state, { type: 'done', source, agentId })
    expect(state[key]!.lastSummary?.reason).toBe('done')
  })

  it('replay toolCallId 去重语义保留（同一 id 不重复建卡）', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'tool-call', source, agentId, toolCallId: 'tc-dup', title: 'Bash', replay: true })
    state = reduce(state, { type: 'tool-call', source, agentId, toolCallId: 'tc-dup', title: 'Bash', replay: true })
    expect(state[key]!.messages.filter(message => message.role === 'tool')).toHaveLength(1)
  })

  it('replay error 追加错误消息但不写 live summary', () => {
    let state: ChatRuntimeState = {}
    state = reduce(state, { type: 'user', source, agentId, content: 'r', eventReplay: true })
    state = reduce(state, { type: 'error', source, agentId, error: 'boom', replay: true, explicitReplay: true })
    const runtime = state[key]!
    expect(runtime.messages.at(-1)?.sender).toBe('system')
    expect(runtime.messages.at(-1)?.content).toBe('boom')
    expect(runtime.lastSummary).toBeUndefined()
    expect(runtime.generating).toBe(false)
  })
})
