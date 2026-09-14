/**
 * #81 L1 等价性 golden：同一段流式 chunk 分别走"逐 chunk 存储"与"sink 窗口聚合"
 * 两条路径，projectMessagesFromCanonical 产出的 Message[] 必须逐字节相等。
 *
 * 行构造经 normalizeRawEvent（与真实落盘管线同源），逐 chunk 行携带互不相同的
 * receivedAt（真实库中每 chunk 时间戳不同）——等价性不得依赖时间戳巧合。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRawEvent } from '../canonicalNormalizer'
import { mergeAdjacentDeltaChunks } from '../../../infrastructure/events/canonicalEventBatch'
import type { CanonicalConversationEvent, CanonicalEventOwner } from '../eventSchema'
import { projectMessagesFromCanonical } from '../messageProjection.ts'

const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' }

function rawText(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
  }
}

function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId },
  }
}

function rawUser(text: string): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}

function rawToolStart(toolCallId: string): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'Read', kind: 'read' },
  }
}

function rawDone(): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'done' } }
}

/** 按到达顺序把 wire 列表归一为逐 chunk canonical 行；每行 receivedAt 互不相同。 */
function chunkRows(wires: readonly unknown[]): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, {
    owner,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index).toISOString(),
  }).event)
}

function expectEquivalence(wires: readonly unknown[], options: { readonly expectMerge?: boolean } = {}): void {
  const perChunk = chunkRows(wires)
  const merged = mergeAdjacentDeltaChunks(perChunk)
  const left = JSON.stringify(projectMessagesFromCanonical(perChunk))
  const right = JSON.stringify(projectMessagesFromCanonical(merged))
  expect(right).toBe(left)
  // 聚合必须真的发生（至少出现一个 batch 行），否则等价断言是空转
  if (options.expectMerge !== false) {
    expect(merged.some(row => row.eventType.endsWith('.batch'))).toBe(true)
  }
}

describe('messageProjection batch 等价性（#81 L1 golden）', () => {
  it('同 identity 文本 run：逐 chunk 与聚合的 Message[] 逐字节相等', () => {
    expectEquivalence([
      rawUser('问题'),
      rawText('你'),
      rawText('好'),
      rawText('，'),
      rawText('世'),
      rawText('界'),
      rawDone(),
    ])
  })

  it('thinking 与 text 交替：类型切换切断 run 仍等价', () => {
    expectEquivalence([
      rawUser('问题'),
      rawThinking('思考'),
      rawThinking('中…'),
      rawText('答'),
      rawText('案'),
      rawDone(),
    ])
  })

  it('工具卡切断 run：两侧 delta 折叠结果一致', () => {
    expectEquivalence([
      rawUser('查一下'),
      rawText('先看看'),
      rawToolStart('tool-1'),
      rawText('结论是'),
      rawText('…'),
      rawDone(),
    ])
  })

  it('messageId 变化：identity 元数据取末次出现，文本折叠一致', () => {
    expectEquivalence([
      rawUser('问题'),
      rawText('A', 'msg-1'),
      rawText('B', 'msg-1'),
      rawText('C', 'msg-2'),
      rawText('D', 'msg-2'),
      rawDone(),
    ])
  })

  it('空文本 chunk 混入 run：无 string text 的 chunk 不合并（审核 P1-2），但投影仍等价', () => {
    expectEquivalence([
      rawUser('问题'),
      rawText('x'),
      rawText(''),
      rawText('y'),
      rawDone(),
    ], { expectMerge: false })
  })

  it('终态后再续流：settle 语义不受聚合影响（done 切断 run，不发生合并）', () => {
    expectEquivalence([
      rawUser('一'),
      rawText('a'),
      rawDone(),
      rawText('b'),
      rawDone(),
    ], { expectMerge: false })
  })

  it('sink 落盘行形状：batch 行展开还原出逐 chunk 原始 wire（顺序不变）', () => {
    const wires = [rawText('你'), rawText('好')]
    const perChunk = chunkRows(wires)
    const [batch] = mergeAdjacentDeltaChunks(perChunk)
    expect(batch.eventType).toBe('assistant.text.delta.batch')
    expect(batch.rawPayload).toEqual(wires)
    expect(batch.typedPayload).toEqual({ text: '你好', foldedCount: 2, seqSpan: [1, 2] })
  })
})

describe('turn.unit 消息侧展开（#81 L2）', () => {
  it('单元行展开为 segment 事件；被覆盖行丢弃；投影与逐行等价', async () => {
    const { expandTurnUnitRows } = await import('../canonicalUnit')
    const { createCanonicalEvent } = await import('../eventSchema')
    const unitRow = createCanonicalEvent({
      owner,
      clientGeneration: 1,
      sequence: 5,
      occurredAt: '2026-09-14T00:00:04.000Z',
      receivedAt: '2026-09-14T00:00:04.000Z',
      eventType: 'turn.unit',
      payloadVersion: 1,
      typedPayload: {
        aggregateKind: 'turn-rollup',
        seqStart: 2,
        seqEnd: 4,
        foldedCount: 3,
        foldScheme: 'adjacent-delta-fold-v1',
        contentSha256: 'deadbeef',
        terminal: { eventType: 'turn.completed', occurredAt: '2026-09-14T00:00:04.000Z' },
        segments: [
          { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 3, identity: { messageId: 'msg-1' }, text: '答案', occurredAt: '2026-09-14T00:00:02.000Z', markdown: false },
          { kind: 'event', event: createCanonicalEvent({
            owner,
            clientGeneration: 1,
            sequence: 4,
            occurredAt: '2026-09-14T00:00:04.000Z',
            receivedAt: '2026-09-14T00:00:04.000Z',
            eventType: 'turn.completed',
            payloadVersion: 1,
            typedPayload: { stopReason: 'end_turn' },
            rawPayload: { update: { sessionUpdate: 'done' } },
          }) },
        ],
      },
      rawPayload: { kind: 'turn-unit' },
    })
    const covered = [
      createCanonicalEvent({
        owner, clientGeneration: 1, sequence: 2,
        occurredAt: '2026-09-14T00:00:02.000Z', receivedAt: '2026-09-14T00:00:02.000Z',
        eventType: 'assistant.text.delta', payloadVersion: 1,
        identity: { messageId: 'msg-1' }, typedPayload: { text: '答' },
        rawPayload: rawText('答'),
      }),
      createCanonicalEvent({
        owner, clientGeneration: 1, sequence: 3,
        occurredAt: '2026-09-14T00:00:03.000Z', receivedAt: '2026-09-14T00:00:03.000Z',
        eventType: 'assistant.text.delta', payloadVersion: 1,
        identity: { messageId: 'msg-1' }, typedPayload: { text: '案' },
        rawPayload: rawText('案'),
      }),
      createCanonicalEvent({
        owner, clientGeneration: 1, sequence: 4,
        occurredAt: '2026-09-14T00:00:04.000Z', receivedAt: '2026-09-14T00:00:04.000Z',
        eventType: 'turn.completed', payloadVersion: 1,
        typedPayload: { stopReason: 'end_turn' },
        rawPayload: rawDone(),
      }),
    ]
    // 混合读取（单元 + 被覆盖行）⇒ 展开为 segment 事件，被覆盖行不重复
    const mixed = expandTurnUnitRows([covered[0], covered[1], covered[2], unitRow])
    expect(mixed.map(event => event.eventType)).toEqual(['assistant.text.delta', 'turn.completed'])
    const projected = JSON.stringify(projectMessagesFromCanonical(mixed))
    // 与"逐行（无单元）"投影一致
    const perRow = JSON.stringify(projectMessagesFromCanonical(covered))
    expect(projected).toBe(perRow)
  })
})
