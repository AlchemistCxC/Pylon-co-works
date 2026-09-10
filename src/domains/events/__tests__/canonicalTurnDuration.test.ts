import { describe, expect, it } from 'vitest'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../canonicalTurnDuration.ts'

const row = (sequence: number, eventType: 'user.message' | 'turn.completed' | 'turn.failed', at: string) => ({
  sequence,
  eventType,
  occurredAt: at,
  receivedAt: at,
})

describe('deriveCanonicalTurnDuration', () => {
  it('derives the latest completed turn from canonical event timestamps', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', '2026-09-03T00:00:10.000Z'),
      row(2, 'turn.completed', '2026-09-03T00:00:13.250Z'),
    ])).toEqual({
      elapsedMs: 3250,
      startedAt: Date.parse('2026-09-03T00:00:10.000Z'),
      completedAt: Date.parse('2026-09-03T00:00:13.250Z'),
      source: 'canonical-events',
    })
  })

  it('uses the terminal failure boundary and ignores an earlier turn', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', '2026-09-03T00:00:01.000Z'),
      row(2, 'turn.completed', '2026-09-03T00:00:02.000Z'),
      row(3, 'user.message', '2026-09-03T00:01:00.000Z'),
      row(4, 'turn.failed', '2026-09-03T00:01:04.500Z'),
    ])).toMatchObject({ elapsedMs: 4500, source: 'canonical-events' })
  })

  it('anchors a turn at the first user chunk rather than the last chunk', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', '2026-09-03T00:00:10.000Z'),
      row(2, 'user.message', '2026-09-03T00:00:10.500Z'),
      row(3, 'turn.completed', '2026-09-03T00:00:13.000Z'),
    ])?.elapsedMs).toBe(3000)
  })

  it('returns undefined when either boundary timestamp is missing', () => {
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', ''),
      row(2, 'turn.completed', '2026-09-03T00:00:02.000Z'),
    ])).toBeUndefined()
  })

  it('separates a completed turn from whether its duration is measurable', () => {
    expect(hasCanonicalTurnTerminal([
      { eventType: 'turn.completed' },
    ])).toBe(true)
    expect(deriveCanonicalTurnDuration([
      row(1, 'user.message', ''),
      row(2, 'turn.completed', ''),
    ])).toBeUndefined()
  })
})
