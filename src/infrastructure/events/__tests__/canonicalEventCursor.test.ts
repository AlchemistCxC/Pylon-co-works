import { describe, expect, it, vi } from 'vitest'
import type { CanonicalEventRow } from '../canonicalEventRepository.ts'
import { CanonicalEventCursor, CanonicalEventCursorError } from '../canonicalEventCursor.ts'

const OWNER_KEY = '["p1","peri","local:s1"]'

function event(sequence: number): CanonicalEventRow {
  return {
    eventId: `${OWNER_KEY}#${sequence}`,
    owner: { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' },
    clientGeneration: 1,
    sequence,
    occurredAt: '2026-08-20T00:00:00.000Z',
    receivedAt: '2026-08-20T00:00:00.000Z',
    eventType: 'assistant.text.delta',
    payloadVersion: 1,
    typedPayload: { text: String(sequence) },
    rawPayload: { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { text: String(sequence) } } },
  }
}

describe('CanonicalEventCursor', () => {
  it('serializes concurrent notifications and suppresses duplicates', async () => {
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    const applied: number[] = []
    await Promise.all([
      cursor.accept(event(1), async row => { await Promise.resolve(); applied.push(row.sequence) }),
      cursor.accept(event(2), row => { applied.push(row.sequence) }),
      cursor.accept(event(2), row => { applied.push(row.sequence) }),
    ])
    expect(applied).toEqual([1, 2])
    expect(cursor.cursor(OWNER_KEY)).toBe(2)
  })

  it('recovers a gap from the same journal before applying the current notification', async () => {
    const list = vi.fn().mockResolvedValue({ events: [event(2), event(3)], nextBeforeSequence: 2 })
    const cursor = new CanonicalEventCursor({ list })
    cursor.seed(OWNER_KEY, 1)
    const applied: Array<[number, boolean]> = []
    await cursor.accept(event(3), (row, current) => { applied.push([row.sequence, current]) })
    expect(applied).toEqual([[2, false], [3, true]])
    expect(list).toHaveBeenCalledWith(OWNER_KEY, 4, 2)
  })

  it('does not advance past an incomplete journal range', async () => {
    const cursor = new CanonicalEventCursor({
      list: vi.fn().mockResolvedValue({ events: [event(3)], nextBeforeSequence: 3 }),
    })
    cursor.seed(OWNER_KEY, 1)
    const error = await cursor.accept(event(3), () => {}).catch(value => value)
    expect(error).toBeInstanceOf(CanonicalEventCursorError)
    expect(error).toMatchObject({ code: 'canonical_gap_unrecoverable' })
    expect(cursor.cursor(OWNER_KEY)).toBe(1)
  })

  it('rejects malformed committed rows without invoking the consumer', async () => {
    const consume = vi.fn()
    const cursor = new CanonicalEventCursor({ list: vi.fn() })
    const error = await cursor.accept({ ...event(1), eventId: 'wrong' }, consume).catch(value => value)
    expect(error).toMatchObject({ code: 'canonical_event_invalid' })
    expect(consume).not.toHaveBeenCalled()
  })
})
