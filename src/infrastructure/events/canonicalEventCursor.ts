import { toCanonicalOwnerKey, validateCanonicalEvent } from '../../domains/events/eventSchema.ts'
import {
  loadCanonicalEventRange,
  normalizeCanonicalEventRow,
  type CanonicalEventRepository,
  type CanonicalEventRow,
} from './canonicalEventRepository.ts'

export class CanonicalEventCursorError extends Error {
  readonly code: 'canonical_event_invalid' | 'canonical_gap_unrecoverable'

  constructor(code: CanonicalEventCursorError['code'], message: string) {
    super(message)
    this.name = 'CanonicalEventCursorError'
    this.code = code
  }
}

export type CanonicalEventConsumer = (
  event: CanonicalEventRow,
  isCurrentNotification: boolean,
) => void | Promise<void>

/**
 * Owner-scoped committed-event cursor.
 *
 * The module serializes notification processing, detects gaps, reads only the missing
 * range from the same canonical journal, and advances the cursor after each applied row.
 * Callers do not manage locks, pagination, duplicate suppression, or partial failures.
 */
export class CanonicalEventCursor {
  private readonly cursors = new Map<string, number>()
  private readonly tails = new Map<string, Promise<void>>()

  constructor(private readonly repository: Pick<CanonicalEventRepository, 'list'>) {}

  seed(ownerKey: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return
    this.cursors.set(ownerKey, Math.max(this.cursors.get(ownerKey) ?? 0, sequence))
  }

  cursor(ownerKey: string): number {
    return this.cursors.get(ownerKey) ?? 0
  }

  forget(ownerKey: string): void {
    this.cursors.delete(ownerKey)
    this.tails.delete(ownerKey)
  }

  accept(value: unknown, consume: CanonicalEventConsumer): Promise<void> {
    const current = normalizeCanonicalEventRow(value)
    const problems = validateCanonicalEvent(current)
    if (problems.length > 0) {
      return Promise.reject(new CanonicalEventCursorError(
        'canonical_event_invalid',
        `Kernel committed event invalid: ${problems.join('; ')}`,
      ))
    }
    const ownerKey = toCanonicalOwnerKey(current.owner)
    const previous = this.tails.get(ownerKey) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      let cursor = this.cursor(ownerKey)
      if (current.sequence <= cursor) return
      const batch = current.sequence === cursor + 1
        ? [current]
        : await loadCanonicalEventRange(this.repository, ownerKey, cursor, current.sequence)
      for (const event of batch) {
        if (event.sequence !== cursor + 1 || toCanonicalOwnerKey(event.owner) !== ownerKey) {
          throw new CanonicalEventCursorError(
            'canonical_gap_unrecoverable',
            `Canonical gap for ${ownerKey}: expected ${cursor + 1}, received ${event.sequence}`,
          )
        }
        await consume(event, event.sequence === current.sequence)
        cursor = event.sequence
        this.cursors.set(ownerKey, cursor)
      }
      if (cursor !== current.sequence) {
        throw new CanonicalEventCursorError(
          'canonical_gap_unrecoverable',
          `Canonical gap for ${ownerKey}: expected through ${current.sequence}, recovered through ${cursor}`,
        )
      }
    })
    this.tails.set(ownerKey, run.then(() => {}, () => {}))
    return run
  }
}
