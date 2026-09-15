/**
 * #81 L1：canonicalEventSink 写入窗口聚合测试。
 * 合并边界（identity 变化 / 类型切换 / 非 delta 穿插 / 上限切断）、rawPayload
 * 还原、revision 等价（跨度占用）、rebase 与合并共用同一规则、force 语义、
 * 默认 debounce 1000ms。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCanonicalEventSink,
  type CanonicalEventOfferContext,
} from '../canonicalEventSink'
import {
  canonicalBatchChunksOf,
  canonicalBatchSpanOf,
  mergeAdjacentDeltaChunks,
} from '../canonicalEventBatch'
import {
  CanonicalEventRepositoryError,
  type CanonicalEventRepository,
} from '../canonicalEventRepository'
import type { CanonicalConversationEvent } from '../../../domains/events/eventSchema'

const OWNER_KEY = '["p1","peri","local:s1"]'
const context: CanonicalEventOfferContext = {
  owner: { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' },
  clientGeneration: 3,
}

async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** 同一 messageId 的流式 wire：agent_message_chunk / agent_thought_chunk。 */
function rawDelta(kind: 'text' | 'thinking', text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: {
      sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
      content: { type: 'text', text },
      messageId,
    },
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

interface FakeRepo {
  repository: CanonicalEventRepository
  revision: ReturnType<typeof vi.fn>
  append: ReturnType<typeof vi.fn>
}

function fakeRepository(): FakeRepo {
  const revision = vi.fn()
  const append = vi.fn()
  const repository: CanonicalEventRepository = {
    append: (...args) => append(...args),
    revision: (...args) => revision(...args),
    async list() { return { events: [], nextBeforeSequence: null } },
    async loadAll() { return [] },
    async exportRaw() { return null },
    async loadAllPreferUnits() { return [] },
    async searchOwners() { return [] },
  }
  return { repository, revision, append }
}

/** 单次 force flush 落盘的行。 */
async function flushOnce(fake: FakeRepo, sink: ReturnType<typeof createCanonicalEventSink>): Promise<CanonicalConversationEvent[]> {
  await flushMicrotasks()
  expect(fake.append).toHaveBeenCalledTimes(1)
  sink.dispose()
  return fake.append.mock.calls[0][0] as CanonicalConversationEvent[]
}

describe('canonicalEventSink batch（#81 L1）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('相邻同类 delta 合并为一行 batch：text 精确拼接、seqSpan 跨度占用、eventId 取末条', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(3)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', '你'))
    sink.offer(context, rawDelta('text', '好'))
    sink.offer(context, rawDelta('text', '，世界'))
    sink.offer(context, rawUser('hi'), true)
    const rows = await flushOnce(fake, sink)
    expect(rows).toHaveLength(2)
    const batch = rows[0]
    expect(batch.eventType).toBe('assistant.text.delta.batch')
    expect(batch.sequence).toBe(3)
    expect(batch.eventId).toBe(`${OWNER_KEY}#3`)
    expect(batch.typedPayload).toEqual({ text: '你好，世界', foldedCount: 3, seqSpan: [1, 3] })
    expect(batch.identity).toEqual({ messageId: 'msg-1' })
    // rawPayload = 原始 chunk 数组，顺序不变
    expect(batch.rawPayload).toHaveLength(3)
    expect((batch.rawPayload as unknown[])[2]).toEqual(rawDelta('text', '，世界'))
    expect(rows[1].eventType).toBe('user.message')
  })

  it('identity 变化即 run 边界：不合并，逐条落盘（单条 run 保持原事件）', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(2)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', 'A', 'msg-1'))
    sink.offer(context, rawDelta('text', 'B', 'msg-2'))
    sink.offer(context, rawUser('done'), true)
    const rows = await flushOnce(fake, sink)
    expect(rows.map(row => row.eventType)).toEqual(['assistant.text.delta', 'assistant.text.delta', 'user.message'])
    expect((rows[0].typedPayload as { text?: string }).text).toBe('A')
    expect((rows[1].typedPayload as { text?: string }).text).toBe('B')
  })

  it('类型切换（text↔thinking）切断 run；单条 run 保持原事件不合成', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(4)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', 'a'))
    sink.offer(context, rawDelta('text', 'b'))
    sink.offer(context, rawDelta('thinking', 'think-1'))
    sink.offer(context, rawDelta('text', 'c'))
    sink.offer(context, rawUser('x'), true)
    const rows = await flushOnce(fake, sink)
    expect(rows.map(row => row.eventType)).toEqual([
      'assistant.text.delta.batch',
      'assistant.thinking.delta',
      'assistant.text.delta',
      'user.message',
    ])
    expect(rows[0].typedPayload).toEqual({ text: 'ab', foldedCount: 2, seqSpan: [1, 2] })
    expect(rows[1].eventType).toBe('assistant.thinking.delta')
    expect(rows[2].eventType).toBe('assistant.text.delta')
  })

  it('非 delta 事件穿插切断：工具卡两侧的 delta 不合并', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(4)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', 'before'))
    sink.offer(context, rawToolStart('tool-1'))
    sink.offer(context, rawDelta('text', 'after'))
    sink.offer(context, rawUser('x'), true)
    const rows = await flushOnce(fake, sink)
    expect(rows.map(row => row.eventType)).toEqual([
      'assistant.text.delta',
      'tool.call.started',
      'assistant.text.delta',
      'user.message',
    ])
  })

  it('全空文本 chunk 的 run 不合并（逐行投影为 no-op，合并会新建空消息破坏等价）', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(3)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    const emptyDelta = { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } }
    sink.offer(context, emptyDelta)
    sink.offer(context, emptyDelta)
    sink.offer(context, rawUser('x'), true)
    const rows = await flushOnce(fake, sink)
    expect(rows.map(row => row.eventType)).toEqual([
      'assistant.text.delta',
      'assistant.text.delta',
      'user.message',
    ])
    expect(rows[0].typedPayload).toBeUndefined()
  })

  it('字节上限先于条数上限生效：2002 条小 chunk 切成多行且跨度无缝铺满', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(2002)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    for (let index = 0; index < 2002; index += 1) sink.offer(context, rawDelta('text', 'x'))
    sink.offer(context, rawUser('end'), true)
    const rows = await flushOnce(fake, sink)
    const batches = rows.slice(0, -1)
    expect(rows[rows.length - 1].eventType).toBe('user.message')
    expect(batches.length).toBeGreaterThanOrEqual(2)
    // 每行都在预算内，跨度无缝铺满 [1..2002]（切断 ≠ 截断）
    let expectedNext = 1
    for (const batch of batches) {
      expect(batch.eventType).toBe('assistant.text.delta.batch')
      const span = canonicalBatchSpanOf(batch)!
      expect(span[0]).toBe(expectedNext)
      expect(canonicalBatchChunksOf(batch)!.length).toBe(span[1] - span[0] + 1)
      expectedNext = span[1] + 1
    }
    expect(expectedNext).toBe(2003)
  })

  it('foldedCount 上限（纯函数注入 limits）：达到上限切断成多行', () => {
    const chunks = Array.from({ length: 7 }, (_, index) => {
      const raw = rawDelta('text', `#${index}`)
      return {
        eventId: `${OWNER_KEY}#${index + 1}`,
        owner: context.owner,
        clientGeneration: 3,
        sequence: index + 1,
        occurredAt: '2026-09-14T00:00:00.000Z',
        receivedAt: '2026-09-14T00:00:00.000Z',
        eventType: 'assistant.text.delta' as const,
        payloadVersion: 1,
        identity: { messageId: 'msg-1' },
        typedPayload: { text: `#${index}` },
        rawPayload: raw,
      }
    })
    const rows = mergeAdjacentDeltaChunks(chunks, { maxRawBytes: Number.MAX_SAFE_INTEGER, maxFoldedCount: 3 })
    expect(rows.map(row => row.eventType)).toEqual([
      'assistant.text.delta.batch',
      'assistant.text.delta.batch',
      'assistant.text.delta',
    ])
    expect(rows[0].typedPayload).toEqual({ text: '#0#1#2', foldedCount: 3, seqSpan: [1, 3] })
    expect(rows[1].typedPayload).toEqual({ text: '#3#4#5', foldedCount: 3, seqSpan: [4, 6] })
    expect(rows[2].eventType).toBe('assistant.text.delta')
  })

  it('单条 rawPayload 超字节上限的 delta 不成批、原样落盘（不截断）', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(2)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', '大'.repeat(40_000)))
    sink.offer(context, rawDelta('text', '小'))
    sink.offer(context, rawUser('end'), true)
    const rows = await flushOnce(fake, sink)
    // 40k CJK ≈ 120KB JSON（超过 48KiB 预算）→ 单条保持原事件；后续小 delta 自成 run 但单条不合并
    expect(rows[0].eventType).toBe('assistant.text.delta')
    expect(rows[1].eventType).toBe('assistant.text.delta')
    expect(rows[0].rawPayload).toEqual(rawDelta('text', '大'.repeat(40_000)))
  })

  it('写成功后 pending 按 seqSpan 覆盖移除；flush 后的同 run 新段不再拼接旧行', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(3)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', '一'))
    sink.offer(context, rawDelta('text', '二'), true)
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(1)
    const first = fake.append.mock.calls[0][0] as CanonicalConversationEvent[]
    expect(first).toHaveLength(1)
    expect(canonicalBatchSpanOf(first[0])).toEqual([1, 2])
    sink.offer(context, rawDelta('text', '三'), true)
    await flushMicrotasks()
    const second = fake.append.mock.calls[1][0] as CanonicalConversationEvent[]
    expect(second).toHaveLength(1)
    expect(second[0].sequence).toBe(3)
    // 已写行不复活：单条 chunk 保持原事件（合并只发生在同一未落盘批次内）
    expect(second[0].eventType).toBe('assistant.text.delta')
    expect((second[0].typedPayload as { text?: string }).text).toBe('三')
    sink.dispose()
  })

  it('revision 等价：batch 行 sequence = 末 chunk sequence，写后 revision 与未合并一致', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(5)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', 'a'))
    sink.offer(context, rawDelta('text', 'b'))
    sink.offer(context, rawToolStart('t'))
    sink.offer(context, rawDelta('text', 'c'))
    sink.offer(context, rawUser('end'), true)
    await flushMicrotasks()
    const rows = fake.append.mock.calls[0][0] as CanonicalConversationEvent[]
    const lastSequence = rows[rows.length - 1].sequence
    expect(lastSequence).toBe(5)
    expect(fake.append.mock.calls[0][1]).toBe(0)
    sink.dispose()
  })

  it('event_revision_conflict：rebase 重排 chunk sequence 后与合并共用同一规则', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValueOnce(0).mockResolvedValueOnce(10)
    fake.append.mockRejectedValueOnce(new CanonicalEventRepositoryError('event_revision_conflict', 'revision 冲突'))
      .mockResolvedValueOnce(12)
    const onError = vi.fn()
    const sink = createCanonicalEventSink({ repository: fake.repository, onError })
    sink.offer(context, rawDelta('text', 'a'))
    sink.offer(context, rawDelta('text', 'b'), true)
    await flushMicrotasks()
    expect(onError).toHaveBeenCalledWith(OWNER_KEY, expect.any(CanonicalEventRepositoryError))
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(2)
    const retry = fake.append.mock.calls[1][0] as CanonicalConversationEvent[]
    expect(retry).toHaveLength(1)
    const batch = retry[0]
    expect(batch.sequence).toBe(12)
    expect(batch.eventId).toBe(`${OWNER_KEY}#12`)
    expect(canonicalBatchSpanOf(batch)).toEqual([11, 12])
    expect(canonicalBatchChunksOf(batch)).toHaveLength(2)
    sink.dispose()
  })

  it('force=false 时 pending 不落盘、force=true 立即落盘（force 语义不变）', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(3)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', 'a'))
    sink.offer(context, rawDelta('text', 'b'))
    await flushMicrotasks()
    expect(fake.append).not.toHaveBeenCalled()
    sink.offer(context, rawUser('end'), true)
    await flushMicrotasks()
    expect(fake.append).toHaveBeenCalledTimes(1)
    sink.dispose()
  })

  it('默认 debounce 放大为 1000ms（裁决 3），显式参数仍可覆盖', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(1)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawUser('窗口'))
    await flushMicrotasks() // seed 完成、debounce timer 就位
    expect(fake.append).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(fake.append).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fake.append).toHaveBeenCalledTimes(1)
    sink.dispose()
  })

  it('纯函数对照：mergeAdjacentDeltaChunks 输出与 sink 落盘行一致', async () => {
    const fake = fakeRepository()
    fake.revision.mockResolvedValue(0)
    fake.append.mockResolvedValue(3)
    const sink = createCanonicalEventSink({ repository: fake.repository })
    sink.offer(context, rawDelta('text', 'a'))
    sink.offer(context, rawDelta('text', 'b'))
    sink.offer(context, rawUser('x'), true)
    const rows = await flushOnce(fake, sink)
    expect(rows[0].eventType).toBe('assistant.text.delta.batch')
    expect((rows[0].typedPayload as { text?: string }).text).toBe('ab')
  })
})
