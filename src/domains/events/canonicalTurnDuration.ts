import type { CanonicalConversationEvent } from './eventSchema.ts'

export interface CanonicalTurnDuration {
  readonly elapsedMs: number
  readonly startedAt: number
  readonly completedAt: number
  readonly source: 'canonical-events'
}

export type CanonicalTurnBoundaryEvent = Pick<CanonicalConversationEvent, 'sequence' | 'eventType'> & {
  /** Persisted rows normally contain both; malformed/recovered rows may not. */
  readonly occurredAt?: string
  readonly receivedAt?: string
}

/**
 * Derive the most recent completed turn from durable event timestamps.
 *
 * This helper intentionally does not use Date.now: it is consumed while a
 * restarted Workbench is rebuilding history, where the process-local
 * generation clock no longer exists.  Invalid/missing boundaries return
 * undefined so callers can show "duration unavailable" instead of inventing
 * a zero-second result.
 */
export function deriveCanonicalTurnDuration(
  events: readonly CanonicalTurnBoundaryEvent[],
): CanonicalTurnDuration | undefined {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence)
  let startedAt: number | undefined
  let latest: CanonicalTurnDuration | undefined

  for (const event of ordered) {
    const timestamp = parseTimestamp(event.occurredAt) ?? parseTimestamp(event.receivedAt)
    if (event.eventType === 'user.message') {
      // A malformed user row must not erase a valid boundary from the same
      // turn; a later valid user row may still establish a new turn. Multiple
      // canonical user chunks belong to one turn, so retain the first valid
      // user timestamp until a terminal boundary closes it.
      if (timestamp !== undefined && startedAt === undefined) startedAt = timestamp
      continue
    }
    if (event.eventType !== 'turn.completed' && event.eventType !== 'turn.failed') continue
    if (startedAt === undefined || timestamp === undefined || timestamp < startedAt) continue
    latest = {
      elapsedMs: timestamp - startedAt,
      startedAt,
      completedAt: timestamp,
      source: 'canonical-events',
    }
    // A subsequent user row starts the next turn; an extra terminal event
    // without a new user row is a duplicate and must not replace the first
    // terminal boundary.
    startedAt = undefined
  }

  return latest
}

/** Whether a canonical projection contains a terminal turn boundary.  This is
 * intentionally separate from duration derivation: a restarted session may
 * have a valid completed turn but malformed/missing timestamps.  Callers can
 * still render the terminal footer with an explicit “duration unavailable”
 * state instead of inventing `0s` or hiding the result. */
export function hasCanonicalTurnTerminal(
  events: readonly Pick<CanonicalTurnBoundaryEvent, 'eventType'>[],
): boolean {
  return events.some(event => event.eventType === 'turn.completed' || event.eventType === 'turn.failed')
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
