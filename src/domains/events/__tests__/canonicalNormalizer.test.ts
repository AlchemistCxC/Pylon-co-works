import { describe, expect, it } from 'vitest'
import {
  canonicalEventTypeFor,
  normalizeRawEvent,
  resolveEventIdentity,
  resolveToolCallId,
  type CanonicalNormalizeContext,
} from '../canonicalNormalizer'
import { toCanonicalEventId, toCanonicalOwnerKey, validateCanonicalEvent } from '../eventSchema'

const owner = { profileId: 'p1', agentId: 'agent-a', localSessionId: 'local:demo' }

function context(sequence: number, overrides: Partial<CanonicalNormalizeContext> = {}): CanonicalNormalizeContext {
  return { owner, clientGeneration: 3, sequence, receivedAt: '2026-08-14T00:00:00.000Z', ...overrides }
}

describe('canonicalEventTypeFor（wire → canonical 映射）', () => {
  it.each([
    ['user_message_chunk', undefined, 'user.message'],
    ['agent_message_chunk', undefined, 'assistant.text.delta'],
    ['agent_thought_chunk', undefined, 'assistant.thinking.delta'],
    ['tool_call', undefined, 'tool.call.started'],
    ['tool_call_update', 'completed', 'tool.call.completed'],
    ['tool_call_update', 'failed', 'tool.call.failed'],
    ['tool_call_update', 'error', 'tool.call.failed'],
    ['tool_call_update', 'running', 'tool.call.updated'],
    ['tool_call_update', undefined, 'tool.call.updated'],
    ['done', undefined, 'turn.completed'],
    ['error', undefined, 'turn.failed'],
  ])('%s + %s → %s', (sessionUpdate, status, expected) => {
    expect(canonicalEventTypeFor(sessionUpdate, status)).toBe(expected)
  })

  it('未知 sessionUpdate 归 unknown（不丢）', () => {
    expect(canonicalEventTypeFor('future_update', undefined)).toBe('unknown')
  })
})

describe('resolveToolCallId（单一路径：root → content → _meta）', () => {
  it.each([
    ['toolCallId', 'tc-root'],
    ['tool_call_id', 'tc-snake'],
    ['toolUseId', 'tc-use'],
    ['tool_use_id', 'tc-use-snake'],
  ])('识别根层别名 %s', (key, expected) => {
    expect(resolveToolCallId({ sessionUpdate: 'tool_call', [key]: expected })).toBe(expected)
  })

  it('content 嵌套工具 id（replay wire 形状）', () => {
    expect(resolveToolCallId({ sessionUpdate: 'tool_call', content: { toolCallId: 'nested-1' } })).toBe('nested-1')
    expect(resolveToolCallId({ sessionUpdate: 'tool_call', content: { tool_use_id: 'nested-2' } })).toBe('nested-2')
  })

  it('_meta 内工具 id（回退层）', () => {
    expect(resolveToolCallId({ sessionUpdate: 'tool_call', _meta: { toolUseId: 'meta-1' } })).toBe('meta-1')
  })

  it('root 优先于 content/_meta（既有 replay 路径保序）', () => {
    expect(resolveToolCallId({
      sessionUpdate: 'tool_call',
      toolCallId: 'root-1',
      content: { toolCallId: 'content-1' },
      _meta: { toolCallId: 'meta-1' },
    })).toBe('root-1')
  })

  it('缺 id 返回 undefined', () => {
    expect(resolveToolCallId({ sessionUpdate: 'tool_call', title: 'Read' })).toBeUndefined()
    expect(resolveToolCallId(null)).toBeUndefined()
    expect(resolveToolCallId('nope')).toBeUndefined()
  })
})

describe('resolveEventIdentity（messageId/eventId/turnId content 优先）', () => {
  it('从 content 提取消息 id（Peri wire 形状）', () => {
    expect(resolveEventIdentity({ sessionUpdate: 'agent_message_chunk', content: { messageId: 'm-1', turnId: 't-1' } }))
      .toEqual({ messageId: 'm-1', turnId: 't-1' })
  })

  it('从根层提取 id', () => {
    expect(resolveEventIdentity({ sessionUpdate: 'agent_message_chunk', message_id: 'm-2' }))
      .toEqual({ messageId: 'm-2' })
  })

  it('content 优先于根（extractExternalIdentity(upd.content ?? upd) 保序）', () => {
    expect(resolveEventIdentity({ sessionUpdate: 'agent_message_chunk', messageId: 'root', content: { messageId: 'content' } }))
      .toEqual({ messageId: 'content' })
  })
})

describe('normalizeRawEvent（统一入口：live/replay/restart 三路径）', () => {
  it('产出合法 canonical 事件（identity 推导一致、owner 维、raw 保留）', () => {
    const result = normalizeRawEvent(
      { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'x' }] } },
      context(1),
    )
    expect(result.malformed).toBe(false)
    expect(result.event.eventType).toBe('tool.call.started')
    expect(result.event.identity?.toolCallId).toBe('tc-1')
    expect(result.event.owner).toEqual(owner)
    expect(result.event.sequence).toBe(1)
    expect(result.event.eventId).toBe(toCanonicalEventId(owner, 1))
    expect(validateCanonicalEvent(result.event)).toEqual([])
    expect(result.event.rawPayload).toEqual({ update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'x' }] } })
  })

  it('tool 负载字段全保留（字段不丢）', () => {
    const result = normalizeRawEvent(
      { update: { sessionUpdate: 'tool_call_update', content: { tool_use_id: 'tc-2' }, rawOutput: { ok: true }, status: 'completed' } },
      context(2),
    )
    const tool = (result.event.typedPayload as { tool?: Record<string, unknown> } | undefined)?.tool
    expect(result.event.eventType).toBe('tool.call.completed')
    expect(result.event.identity?.toolCallId).toBe('tc-2')
    expect(tool?.rawOutput).toEqual({ ok: true })
    expect(tool?.status).toBe('completed')
    expect(tool?.contentBlocks).toEqual({ tool_use_id: 'tc-2' })
  })

  it('文本类事件提取 text', () => {
    const text = normalizeRawEvent({ update: { sessionUpdate: 'agent_message_chunk', content: { text: '完成', messageId: 'm-1' } } }, context(3))
    expect(text.event.eventType).toBe('assistant.text.delta')
    expect((text.event.typedPayload as { text?: string }).text).toBe('完成')
    expect(text.event.identity?.messageId).toBe('m-1')

    const thought = normalizeRawEvent({ update: { sessionUpdate: 'agent_thought_chunk', content: { text: '思考' } } }, context(4))
    expect(thought.event.eventType).toBe('assistant.thinking.delta')

    const user = normalizeRawEvent({ update: { sessionUpdate: 'user_message_chunk', content: { text: '问' } } }, context(5))
    expect(user.event.eventType).toBe('user.message')
  })

  it('宽容 envelope 形状：$.params.update / 裸 SessionUpdate', () => {
    const nested = normalizeRawEvent({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'nested' } } } }, context(6))
    expect(nested.malformed).toBe(false)
    expect(nested.event.eventType).toBe('assistant.text.delta')

    const bare = normalizeRawEvent({ sessionUpdate: 'usage_update', used: 12 }, context(7))
    expect(bare.malformed).toBe(false)
    expect(bare.event.eventType).toBe('unknown')
    expect(bare.sessionUpdate).toBe('usage_update')
  })

  it('unknown/malformed 不静默丢弃——raw 恒保留、恒产出 canonical', () => {
    const unknown = normalizeRawEvent({ update: { sessionUpdate: 'future_update', value: 1 } }, context(8))
    expect(unknown.event.eventType).toBe('unknown')
    expect(unknown.malformed).toBe(false)
    expect(unknown.event.rawPayload).toEqual({ update: { sessionUpdate: 'future_update', value: 1 } })

    const nonObject = normalizeRawEvent('garbage', context(9))
    expect(nonObject.malformed).toBe(true)
    expect(nonObject.event.eventType).toBe('unknown')
    expect(nonObject.warning).toBeTruthy()
    expect(nonObject.event.rawPayload).toBe('garbage')

    const noUpdate = normalizeRawEvent({ params: { nope: true } }, context(10))
    expect(noUpdate.malformed).toBe(true)
    expect(noUpdate.event.rawPayload).toEqual({ params: { nope: true } })

    const empty = normalizeRawEvent(null, context(11))
    expect(empty.malformed).toBe(true)
    expect(empty.event.rawPayload).toBeNull()
  })

  it('owner_key 序列化纪律（JSON 数组）与 eventId 推导', () => {
    const result = normalizeRawEvent({ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' } } }, context(12))
    expect(result.event.eventId).toContain(`${toCanonicalOwnerKey(owner)}#12`)
  })
})

describe('三路径等价（§5.11：同一个 ACP event 经 live/replay/restart 归一化后深等）', () => {
  const wire = {
    sessionId: 'peri-session',
    update: {
      sessionUpdate: 'tool_call',
      toolUseId: 'tc-unified',
      title: 'Write',
      kind: 'write_file',
      rawInput: '{"path":"x"}',
      content: [{ type: 'text', text: 'payload' }],
    },
  }

  it('live 入口（payload.update 直达）与 replay 入口（envelope.update）产出同一 canonical 事件', () => {
    // rawPayload 恒为各自输入原样（live 含 source、replay 含 sessionId）——设计使然；
    // canonical 其余字段（owner/sequence/eventId/identity/typedPayload/eventType）必须一致。
    const liveShape = normalizeRawEvent({ source: 'local:s', ...wire.update }, context(1))
    const replayShape = normalizeRawEvent(wire, context(1))

    expect(liveShape.malformed).toBe(false)
    expect(replayShape.malformed).toBe(false)
    expect(liveShape.event.rawPayload).toEqual({ source: 'local:s', ...wire.update })
    expect(replayShape.event.rawPayload).toEqual(wire)
    const { rawPayload: _liveRaw, ...liveFields } = liveShape.event
    const { rawPayload: _replayRaw, ...replayFields } = replayShape.event
    expect(liveFields).toEqual(replayFields)
    expect(liveShape.event.identity?.toolCallId).toBe('tc-unified')
  })

  it('同一 wire 的 live/replay 归一化后工具 identity 字段深等', () => {
    const live = normalizeRawEvent({ update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-x', status: 'completed', rawOutput: { ok: 1 } } }, context(2))
    const replay = normalizeRawEvent({ params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-x', status: 'completed', rawOutput: { ok: 1 } } } }, context(2))

    const toolFields = (result: { event: { identity?: { toolCallId?: string }; typedPayload?: unknown } }) => {
      const typed = result.event.typedPayload as { tool?: Record<string, unknown> } | undefined
      return {
        toolCallId: result.event.identity?.toolCallId,
        status: typed?.tool?.status,
        rawOutput: typed?.tool?.rawOutput,
      }
    }
    expect(toolFields(live)).toEqual(toolFields(replay))
    expect(toolFields(live)).toEqual({ toolCallId: 'tc-x', status: 'completed', rawOutput: { ok: 1 } })
  })
})
