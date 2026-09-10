// @vitest-environment jsdom
/**
 * A1-c P3 parity（P52 D4 改造）：canonical 归一化投影的聚合契约。
 * 原 controller replay 对照随 chatEventController 退役（重放产物 = 同一
 * projectMessagesFromCanonical 纯函数，对照失去独立信息量）；保留的核心
 * 断言：无 identity 相邻 chunk 聚合、混合 identity 采用后到 identity、
 * 工具行与文本行的顺序/字段。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRawEvent } from '../../../domains/events/canonicalNormalizer'
import { projectMessagesFromCanonical } from '../../../domains/events/messageProjection'
import type { CanonicalEventOwner } from '../../../domains/events/eventSchema'
import type { Message } from '../messageTypes'

function stripTransient(message: Message): Record<string, unknown> {
  // 时间戳字段（time/thoughtStartedAt/thoughtDurationMs）随路径取当前时间或事件时间，
  // parity 关注的是内容/顺序/身份/工具字段；undefined 键也归一。
  const { time: _time, thoughtStartedAt: _thoughtStartedAt, thoughtDurationMs: _thoughtDurationMs, ...rest } = message as Message & Record<string, unknown>
  const normalized: Record<string, unknown> = { ...rest, time: '' }
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) delete normalized[key]
  }
  return normalized
}

const source = 'local:projection-parity'
const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: source }
const CLIENT_GENERATION = 7

function project(wire: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const canonicalEvents = wire.map((update, index) => normalizeRawEvent(
    { source, update },
    { owner, clientGeneration: CLIENT_GENERATION, sequence: index + 1, receivedAt: '2026-08-14T00:00:00.000Z' },
  ).event)
  return projectMessagesFromCanonical(canonicalEvents).map(stripTransient)
}

describe('canonical 投影聚合契约（A1-c P3，P52 D4 宿主迁移）', () => {
  it('完整回合：user → 聚合 assistant → tool(Read) → done 的顺序与字段', () => {
    const projected = project([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '问题', messageId: 'u1' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回', messageId: 'a1' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '复', messageId: 'a1' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tc-p', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'preview' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-p', rawOutput: { ok: true }, status: 'completed' },
      { sessionUpdate: 'done' },
    ])

    expect(projected.filter(message => message.role !== 'tool').map(message => message.content)).toEqual(['问题', '回复'])
    expect(projected.some(message => message.role === 'tool' && message.toolName === 'Read')).toBe(true)
    expect(projected.map(message => message.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('无 identity 相邻 chunk：投影聚合为一条（修复助手消息一字一行）', () => {
    const projected = project([
      { sessionUpdate: 'user_message_chunk', content: { text: '问题' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '思' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '考' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '回' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '复' } },
      { sessionUpdate: 'done' },
    ])

    expect(projected.filter(message => message.role !== 'tool').map(message => message.content)).toEqual(['问题', '思考', '回复'])
  })

  it('混合 identity 相邻 chunk：聚合成一条并采用后到 identity', () => {
    const projected = project([
      { sessionUpdate: 'user_message_chunk', content: { text: '问题' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '思', turnId: 't1' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '考' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '回' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '复', messageId: 'm1' } },
      { sessionUpdate: 'done' },
    ])

    expect(projected.filter(message => message.role !== 'tool').map(message => message.content)).toEqual(['问题', '思考', '回复'])
    expect(projected[1].externalIdentity).toEqual({ turnId: 't1' })
    expect(projected[2].externalIdentity).toEqual({ messageId: 'm1' })
  })

  it('交错回合：工具行按 journal 顺序插在 user 与 assistant 之间（不聚顶/聚底）', () => {
    const projected = project([
      { sessionUpdate: 'user_message_chunk', content: { text: '问题' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tc-i', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'preview' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-i', status: 'completed', rawOutput: { ok: true } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } },
      { sessionUpdate: 'done' },
    ])

    expect(projected.map(message => message.role)).toEqual(['user', 'tool', 'assistant'])
    expect(projected[1]).toMatchObject({
      role: 'tool', toolName: 'Read', toolStatus: 'completed', running: false,
    })
    expect(projected[0].content).toBe('问题')
    expect(projected[2].content).toBe('回复')
  })
})
