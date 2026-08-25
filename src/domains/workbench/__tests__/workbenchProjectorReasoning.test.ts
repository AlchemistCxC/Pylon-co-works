import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  reduceWorkbenchEvent,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

/**
 * C01 RED：reasoning 聚合契约。
 *
 * 卡面要求：
 * - projector 按 canonical timeline 边界聚合 delta，完成时记录 duration；
 * - provider 逐 chunk 轮换 message identity 时仍保持一整段 reasoning；
 * - redacted 是独立状态：内容不可见、原因可见，与普通 completed 区分。
 */

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  messageId: string,
  occurredAt: string,
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    occurredAt,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity: { messageId },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

function delta(sequence: number, messageId: string, text: string, at: string): WorkbenchEventEnvelope {
  return envelope(sequence, { type: 'reasoning.delta', parts: [{ kind: 'text', text }] }, messageId, at)
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

describe('C01 reasoning projector aggregation', () => {
  it('aggregates deltas by identity and records duration on completion', () => {
    const document = reduce([
      delta(1, 'thought-a', '第一段', '1970-01-01T00:00:01.000Z'),
      delta(2, 'thought-a', '第二段', '1970-01-01T00:00:01.500Z'),
      envelope(3, { type: 'reasoning.completed', parts: [] }, 'thought-a', '1970-01-01T00:00:03.400Z'),
    ])

    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]!.content).toBe('第一段第二段')
    // 完成时长 = completed.occurredAt − 首个 delta.occurredAt = 2400ms
    expect(thoughts[0]!.thoughtDurationMs).toBe(2400)
    expect(thoughts[0]!.running).toBe(false)
  })

  it('settles an existing reasoning segment when its empty completion arrives after a tool', () => {
    const document = reduce([
      delta(1, 'thought-a', 'inspect first', '1970-01-01T00:00:01.000Z'),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, 'tool-1', '1970-01-01T00:00:02.000Z'),
      envelope(3, { type: 'reasoning.completed', parts: [] }, 'thought-a', '1970-01-01T00:00:03.000Z'),
    ])

    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]).toMatchObject({ content: 'inspect first', running: false, thoughtDurationMs: 2_000 })
  })

  it('keeps the first terminal duration when completion is repeated with a distinct event id', () => {
    const document = reduce([
      delta(1, 'thought-terminal', '稳定正文', '1970-01-01T00:00:01.000Z'),
      envelope(2, { type: 'reasoning.completed', parts: [] }, 'thought-terminal', '1970-01-01T00:00:03.000Z'),
      envelope(3, { type: 'reasoning.completed', parts: [] }, 'thought-terminal', '1970-01-01T00:00:09.000Z'),
    ])

    const thought = document.messages.find(message => message.identity.messageId === 'thought-terminal')!
    expect(thought.content).toBe('稳定正文')
    expect(thought.running).toBe(false)
    expect(thought.thoughtDurationMs).toBe(2_000)
  })

  it('aggregates one reasoning stream when the provider rotates identity on every chunk', () => {
    const document = reduce([
      delta(1, 'thought-a', '第一段思考', '1970-01-01T00:00:01.000Z'),
      delta(2, 'thought-b', '继续思考', '1970-01-01T00:00:02.000Z'),
      envelope(3, { type: 'reasoning.completed', parts: [] }, 'thought-terminal', '1970-01-01T00:00:03.000Z'),
    ])

    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts).toHaveLength(1)
    expect(thoughts[0]!.content).toBe('第一段思考继续思考')
    expect(thoughts[0]!.running).toBe(false)
    expect(thoughts[0]!.thoughtDurationMs).toBe(2_000)
  })

  it('starts a new reasoning segment after the previous segment completed', () => {
    const document = reduce([
      delta(1, 'thought-a', '第一段', '1970-01-01T00:00:01.000Z'),
      envelope(2, { type: 'reasoning.completed', parts: [] }, 'thought-a-terminal', '1970-01-01T00:00:02.000Z'),
      delta(3, 'thought-b', '第二段', '1970-01-01T00:00:03.000Z'),
    ])

    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts.map(thought => thought.content)).toEqual(['第一段', '第二段'])
    expect(thoughts.map(thought => thought.running)).toEqual([false, true])
  })

  it('preserves a completed visible segment when a distinct redacted segment follows', () => {
    const document = reduce([
      delta(1, 'thought-visible', '可见思考', '1970-01-01T00:00:01.000Z'),
      envelope(2, { type: 'reasoning.completed', parts: [] }, 'thought-visible', '1970-01-01T00:00:02.000Z'),
      envelope(3, { type: 'reasoning.redacted', parts: [], reason: 'provider_policy' }, 'thought-redacted', '1970-01-01T00:00:03.000Z'),
    ])

    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts.map(thought => thought.content)).toEqual(['可见思考', ''])
    expect(thoughts.map(thought => thought.redacted ?? false)).toEqual([false, true])
  })

  it('marks redacted segments distinctly with reason and never exposes raw content', () => {
    const document = reduce([
      delta(1, 'thought-c', '部分可见', '1970-01-01T00:00:01.000Z'),
      envelope(
        2,
        {
          type: 'reasoning.redacted',
          parts: [{ kind: 'redacted-reasoning', text: '[REDACTED]' }],
          reason: 'provider_redacted',
        },
        'thought-c',
        '1970-01-01T00:00:02.000Z',
      ),
    ])

    const thoughts = document.messages.filter(message => message.role === 'reasoning')
    expect(thoughts).toHaveLength(1)
    const thought = thoughts[0]!
    // 独立 redacted 标记：渲染层据此显示安全占位而非正文
    expect(thought.redacted).toBe(true)
    expect(thought.redactedReason).toBe('provider_redacted')
    // 隐藏内容不得以原文形式保留在 content 中
    expect(thought.content).not.toContain('[REDACTED]')
    expect(JSON.stringify(thought.parts)).not.toContain('部分可见')
    // redacted 即完成态
    expect(thought.running).toBe(false)
    // duration 同样记录（首 delta → redacted 时刻）
    expect(thought.thoughtDurationMs).toBe(1000)
  })
})
