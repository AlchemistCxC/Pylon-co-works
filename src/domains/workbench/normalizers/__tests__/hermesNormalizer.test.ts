import { describe, expect, it } from 'vitest'
import { normalizeHermesEvent } from '../hermesNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const context: NormalizeContext = {
  provider: 'hermes',
  sessionId: 'hermes-session',
  sourceId: 'replay-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  replay: true,
  provenance: { origin: 'recovery-import', trust: 'unverified', provider: 'hermes', importId: 'hermes-import-1' },
}

describe('Hermes normalizer', () => {
  it('marks grouped replay ordering without changing semantic payload', () => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'replayed' },
      _meta: { hermesReplay: true },
    }, context)
    expect(result.events[0]).toMatchObject({
      provenance: { origin: 'recovery-import', trust: 'unverified', orderConfidence: 'grouped', collectionComplete: true },
      event: { type: 'message.delta', role: 'assistant' },
    })
  })

  it('does not guess incomplete delegation/media shapes', () => {
    const result = normalizeHermesEvent({ sessionUpdate: 'delegate', payload: { id: 'missing-target' } }, context)
    expect(result.events[0].event).toMatchObject({ type: 'event.unknown', originalType: 'delegate' })
    expect(result.diagnostics[0]).toMatchObject({ provider: 'hermes', recoverable: true })
  })
})
