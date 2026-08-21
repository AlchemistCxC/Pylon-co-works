import { describe, expect, it } from 'vitest'
import { normalizePeriEvent } from '../periNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const base: NormalizeContext = {
  provider: 'peri',
  sessionId: 'peri-session',
  sourceId: 'live-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
  seenEventKeys: new Set(),
}

describe('Peri normalizer', () => {
  it('deduplicates repeated stable identities without dropping the first event', () => {
    const input = { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'same' } }
    const first = normalizePeriEvent(input, base)
    const second = normalizePeriEvent(input, { ...base, sequence: 2 })
    expect(first.events).toHaveLength(1)
    expect(second.events).toHaveLength(0)
    expect(second.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'duplicate.identity', recoverable: true }),
    ]))
  })

  it('keeps unstable events out of the timeline and emits a diagnostic', () => {
    const result = normalizePeriEvent({ sessionUpdate: 'unstable-event', payload: { trace: true } }, { ...base, observe: true })
    expect(result.events[0]?.event.type).not.toBe('event.unknown')
    expect(result.events[0]?.event.type).toBe('diagnostic.notice')
    expect(result.diagnostics[0]).toMatchObject({ code: 'peri.unstable-event', provider: 'peri' })
  })
})
