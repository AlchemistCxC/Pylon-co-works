import { afterEach, describe, expect, it } from 'vitest'
import { clearToolRegistryForTests } from '../../../tool/toolRegistry.ts'
import { normalizeAcpEvent } from '../acpNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const context: NormalizeContext = {
  provider: 'hermes',
  sessionId: 'session-1',
  sourceId: 'wire-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
}

describe('ACP normalizer plan entries (C08)', () => {
  it('keeps cancelled entries and unknown statuses with raw status instead of collapsing to completed', () => {
    const result = normalizeAcpEvent({
      source: 'hermes',
      update: { sessionUpdate: 'plan', entries: [
        { content: '已完成', status: 'completed', priority: 'high' },
        { content: '进行中', status: 'in_progress' },
        { content: '已取消', status: 'cancelled' },
        { content: '被阻塞', status: 'blocked' },
        { content: '未知状态', status: 'waiting_review' },
      ] },
    }, context)
    const event = result.events[0].event
    if (event.type !== 'plan.replaced') throw new Error(`expected plan.replaced, got ${event.type}`)
    expect(event.entries).toEqual([
      { id: '已完成', content: '已完成', status: 'completed', priority: 'high' },
      { id: '进行中', content: '进行中', status: 'in_progress' },
      { id: '已取消', content: '已取消', status: 'cancelled' },
      { id: '被阻塞', content: '被阻塞', status: 'blocked' },
      { id: '未知状态', content: '未知状态', status: 'unknown', rawStatus: 'waiting_review' },
    ])
  })

  it('derives stable ids from explicit id, itemId or content fallback and drops non-object entries', () => {
    const result = normalizeAcpEvent({
      source: 'hermes',
      update: { sessionUpdate: 'plan', entries: [
        { id: 't-9', content: '显式 id', status: 'pending' },
        { itemId: 'i-2', content: 'item id 兜底', status: 'pending' },
        { content: '内容兜底', status: 'pending' },
        'garbage',
        { noContent: true, status: 'pending' },
      ] },
    }, context)
    const event = result.events[0].event
    if (event.type !== 'plan.replaced') throw new Error(`expected plan.replaced, got ${event.type}`)
    expect(event.entries).toEqual([
      { id: 't-9', content: '显式 id', status: 'pending' },
      { id: 'i-2', content: 'item id 兜底', status: 'pending' },
      { id: '内容兜底', content: '内容兜底', status: 'pending' },
    ])
  })
})

afterEach(() => clearToolRegistryForTests())
