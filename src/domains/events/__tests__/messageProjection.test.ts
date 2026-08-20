/**
 * A1-c P3：canonical events → Message[] 投影纯域测试。
 * 锁定与 live/replay reducer 对齐的聚合、工具卡生命周期、终态 settle 与 unknown 跳过。
 */
import { describe, expect, it } from 'vitest'
import { createCanonicalEvent, type CanonicalEventOwner } from '../eventSchema'
import { projectMessagesFromCanonical } from '../messageProjection'
import type { CanonicalConversationEvent } from '../eventSchema'

const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' }

function event(input: {
  sequence: number
  eventType: CanonicalConversationEvent['eventType']
  text?: string
  identity?: CanonicalConversationEvent['identity']
  tool?: Record<string, unknown>
  rawPayload?: unknown
}): CanonicalConversationEvent {
  const typedPayload: Record<string, unknown> = {}
  if (input.text !== undefined) typedPayload.text = input.text
  if (input.tool) typedPayload.tool = input.tool
  return createCanonicalEvent({
    owner,
    clientGeneration: 7,
    sequence: input.sequence,
    occurredAt: '2026-08-14T00:00:00.000Z',
    receivedAt: '2026-08-14T00:00:00.000Z',
    eventType: input.eventType,
    payloadVersion: 1,
    identity: input.identity,
    ...(Object.keys(typedPayload).length > 0 ? { typedPayload } : {}),
    rawPayload: input.rawPayload ?? {},
  })
}

describe('projectMessagesFromCanonical', () => {
  it('user → assistant delta 同角色连续流聚合，identity 取最后出现者（live flush 同语义）', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'user.message', text: '问题' }),
      event({ sequence: 2, eventType: 'assistant.text.delta', text: '回', identity: { messageId: 'm1' } }),
      event({ sequence: 3, eventType: 'assistant.text.delta', text: '复', identity: { messageId: 'm1' } }),
      event({ sequence: 4, eventType: 'assistant.text.delta', text: '另一条' }),
    ])
    expect(messages.map(m => m.content)).toEqual(['问题', '回复另一条'])
    expect(messages[1].externalIdentity).toEqual({ messageId: 'm1' })
  })

  it('无 identity → 有 identity 的相邻 delta 聚合，并采用后到的 identity', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'assistant.text.delta', text: '开' }),
      event({ sequence: 2, eventType: 'assistant.text.delta', text: '关', identity: { messageId: 'm-late' } }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'assistant', content: '开关', externalIdentity: { messageId: 'm-late' } })
  })

  it('相邻无 identity 的 assistant delta 聚合成一条（live flush 同语义）', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'assistant.text.delta', text: '你' }),
      event({ sequence: 2, eventType: 'assistant.text.delta', text: '好' }),
      event({ sequence: 3, eventType: 'assistant.text.delta', text: '吗' }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'msg-1',
      role: 'assistant',
      content: '你好吗',
    })
    expect(messages[0].externalIdentity).toBeUndefined()
  })

  it('相邻无 identity 的 thinking delta 聚合成一条', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'assistant.thinking.delta', text: '思' }),
      event({ sequence: 2, eventType: 'assistant.thinking.delta', text: '考' }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: 'thought-1', role: 'reasoning', content: '思考' })
    expect(messages[0].externalIdentity).toBeUndefined()
  })

  it('reasoning delta 按同 turnId 聚合，保留外部 identity', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'assistant.thinking.delta', text: '思考一', identity: { turnId: 't1' } }),
      event({ sequence: 2, eventType: 'assistant.thinking.delta', text: '思考二', identity: { turnId: 't1' } }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'thought-1',
      role: 'reasoning',
      content: '思考一思考二',
      externalIdentity: { turnId: 't1' },
    })
  })

  it('tool started → completed 同一张卡，字段与 replay 语义一致', () => {
    const messages = projectMessagesFromCanonical([
      event({
        sequence: 1, eventType: 'tool.call.started', identity: { toolCallId: 'tc-1' },
        tool: { title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, contentBlocks: [{ type: 'text', text: 'preview' }] },
      }),
      event({
        sequence: 2, eventType: 'tool.call.completed', identity: { toolCallId: 'tc-1' },
        tool: { rawOutput: { ok: true, lines: 3 }, status: 'completed' },
      }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'tool-tc-1',
      role: 'tool',
      sender: 'tool:Read',
      toolName: 'Read',
      toolInput: 'a.txt',
      toolKind: 'read_file',
      toolStatus: 'completed',
      running: false,
      rawInput: { path: 'a.txt' },
      rawOutput: { ok: true, lines: 3 },
      contentBlocks: [{ type: 'text', text: 'preview' }],
      clientGeneration: 7,
      externalIdentity: { toolCallId: 'tc-1' },
    })
    expect(messages[0].toolOutput).toContain('"ok": true')
    expect(messages[0].toolOutputLines).toBe(4)
  })

  it('update 先到创建占位卡，后续 started 补全同一张卡', () => {
    const messages = projectMessagesFromCanonical([
      event({
        sequence: 1, eventType: 'tool.call.completed', identity: { toolCallId: 'tc-u' },
        tool: { rawOutput: 'early', status: 'completed' },
      }),
      event({
        sequence: 2, eventType: 'tool.call.started', identity: { toolCallId: 'tc-u' },
        tool: { title: 'Late', kind: 'read', rawInput: { x: 1 } },
      }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'tool-tc-u',
      toolName: 'Late',
      toolInput: '',
      toolOutput: 'early',
      toolStatus: 'completed',
      running: false,
    })
  })

  it('turn.completed / turn.failed settle 全部 running；error 不额外落卡', () => {
    const wire = (terminal: 'turn.completed' | 'turn.failed') => [
      event({ sequence: 1, eventType: 'user.message', text: 'q' }),
      event({ sequence: 2, eventType: 'assistant.text.delta', text: 'a' }),
      event({ sequence: 3, eventType: 'tool.call.started', identity: { toolCallId: 'tc-r' }, tool: { title: 'Run', kind: 'execute', rawInput: 'ls' } }),
      event({ sequence: 4, eventType: terminal }),
    ]
    const completed = projectMessagesFromCanonical(wire('turn.completed'))
    expect(completed.map(m => m.running)).toEqual([false, false, false])
    expect(completed[2].toolStatus).toBe('completed')

    const failed = projectMessagesFromCanonical(wire('turn.failed'))
    expect(failed).toHaveLength(3)
    expect(failed.map(m => m.running)).toEqual([false, false, false])
    expect(failed[2].toolStatus).toBe('completed')
  })

  it('unknown 事件跳过但保留 raw（投影不丢后续事件）', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'unknown' }),
      event({ sequence: 2, eventType: 'user.message', text: 'after' }),
    ])
    expect(messages.map(m => m.content)).toEqual(['after'])
  })

  it('输入乱序时按 sequence 排序投影', () => {
    const messages = projectMessagesFromCanonical([
      event({ sequence: 2, eventType: 'assistant.text.delta', text: '回复' }),
      event({ sequence: 1, eventType: 'user.message', text: '问题' }),
    ])
    expect(messages.map(m => m.content)).toEqual(['问题', '回复'])
    expect(messages[0].id).toBe('user-1')
    expect(messages[1].id).toBe('msg-2')
  })

  it('history.snapshot 行被忽略：投影只用实时行按 sequence 展开', () => {
    // 旧契约（snapshot 作为基线去重/补漏）已被 Bug2 修复取代：canonical_events 的权威是
    // 实时逐 chunk 行。history.snapshot 及其 replayEvents 内容一律不纳入投影。
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'assistant.text.delta', text: 'answer' }),
      event({ sequence: 2, eventType: 'user.message', text: 'local-only' }),
      event({
        sequence: 3,
        eventType: 'history.snapshot',
        rawPayload: {
          kind: 'complete-session-replay',
          replayEvents: [
            {
              source: 'local:s1',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { text: 'persona\n\n---\n\nquestion' },
                _meta: { pylonReplayImport: true },
              },
            },
            {
              source: 'local:s1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: 'answer' },
                _meta: { pylonReplayImport: true },
              },
            },
          ],
        },
      }),
      event({ sequence: 4, eventType: 'assistant.text.delta', text: 'after-live' }),
    ])

    // snapshot 被忽略 → 只保留实时行，按 sequence 交错展开；快照内的 question/answer 不复现。
    expect(messages.map(message => [message.role, message.content])).toEqual([
      ['assistant', 'answer'],
      ['user', 'local-only'],
      ['assistant', 'after-live'],
    ])
  })

  it('Bug2：history.snapshot 不纳入投影——即便其分组内容存在，也只按 sqlite 实时行交错还原', () => {
    // 冷启动重放的权威是 canonical_events 里的实时逐 chunk 行（dispatcher 逐条 ingest，
    // 已按真实交错序持久化）。history.snapshot 是 Hermes 分组重放（text→tools 批量）导入
    // 的产物，若纳入投影会整块前置、盖过实时交错序 → 工具/文字聚簇。修复后投影忽略
    // snapshot 行，只按实时行 sequence 展开，恢复出交错原样。
    const messages = projectMessagesFromCanonical([
      event({ sequence: 1, eventType: 'user.message', text: '问题' }),
      event({ sequence: 2, eventType: 'tool.call.started', identity: { toolCallId: 'tc-1' }, tool: { title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' } } }),
      event({ sequence: 3, eventType: 'tool.call.completed', identity: { toolCallId: 'tc-1' }, tool: { rawOutput: { ok: true }, status: 'completed' } }),
      event({ sequence: 4, eventType: 'assistant.text.delta', text: '回复' }),
      // 一个"带内容"的 Hermes 分组重放快照（text→tools 分组）。若被纳入投影按 snapshot-first
      // 展开，会产生 [user, assistant, tool, tool] 聚簇；修复后它必须被忽略。
      event({
        sequence: 5,
        eventType: 'history.snapshot',
        rawPayload: {
          kind: 'complete-session-replay',
          replayEvents: [
            { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text: 'qX' }, _meta: { pylonReplayImport: true } } },
            { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'aX' }, _meta: { pylonReplayImport: true } } },
            { source: 'local:s1', update: { sessionUpdate: 'tool_call', toolCallId: 'tc-x', title: 'Read', rawInput: { path: 'x' }, _meta: { pylonReplayImport: true } } },
            { source: 'local:s1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-x', status: 'completed', rawOutput: 'x', _meta: { pylonReplayImport: true } } },
          ],
        },
      }),
    ])

    // 权威是实时行：user → tool(Read) → assistant 交错；快照内容 qX/aX 不得混入。
    const roles = messages.map(message => message.role)
    expect(roles).toEqual(['user', 'tool', 'assistant'])
    expect(messages[1]).toMatchObject({ role: 'tool', toolName: 'Read', toolStatus: 'completed', running: false })
    expect(messages[0].content).toBe('问题')
    expect(messages[2].content).toBe('回复')
    expect(messages.map(m => m.content).filter(c => c === 'qX' || c === 'aX')).toEqual([])
    expect(messages).toHaveLength(3)
  })
})
