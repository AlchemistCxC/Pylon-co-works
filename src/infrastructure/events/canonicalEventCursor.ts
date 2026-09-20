import { toCanonicalOwnerKey, validateCanonicalEvent } from '../../domains/events/eventSchema.ts'
import { normalizeCanonicalEventRow, type CanonicalEventRow } from '../../domains/events/canonicalEventRow.ts'
import {
  loadCanonicalEventRange,
  type CanonicalEventRepository,
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
 * ADR-0016：`*.delta.batch` 的 `seqSpan` 是**占用**声明——跨度中间的编号没有行，都由这一行承载
 * （`canonicalRowToWorkbench` 会按 chunk 重建每个原始 sequence/eventId）。因此连续性判据从
 * 「下一号 == 该行 sequence」放宽为「该行跨度**覆盖**下一号」。
 *
 * 严格保留：只对 `*.delta.batch` 生效；`end` 必须等于该行 `sequence`（跨度必须止于自身）；
 * `start >= 1`。`turn.unit` 的 `rollup_*` 是**覆盖**声明，**不得**走这条路径（把覆盖当占用会
 * 跳过仍然存在的行 ⇒ 静默丢数据，见 `rowSemantics.test.ts` 覆盖组用例）。
 *
 * 形状一致性（`foldedCount` 与跨度宽度是否互洽）仍由读边界负责，此处不看。
 */
function spanStartOf(event: CanonicalEventRow): number | undefined {
  const eventType = typeof event.eventType === 'string' ? event.eventType : ''
  if (!eventType.endsWith('.batch')) return undefined
  const span = (event.typedPayload as { seqSpan?: unknown } | undefined)?.seqSpan
  if (!Array.isArray(span) || span.length !== 2) return undefined
  const [start, end] = span
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 1) return undefined
  if (end !== event.sequence || (end as number) < (start as number)) return undefined
  return start as number
}

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
      // ADR-0016：到货行**自己覆盖**游标下一号时无需补读——跨度行就是那个「缺号」的承载者。
      // 只有确实存在真空（单行但编号跳号，或跨度起点晚于游标下一号）才回库补读。
      const spanStart = spanStartOf(current)
      const coversNext = spanStart === undefined ? current.sequence === cursor + 1 : spanStart <= cursor + 1
      const batch = coversNext
        ? [current]
        : await loadCanonicalEventRange(this.repository, ownerKey, cursor, current.sequence)
      for (const event of batch) {
        // 单行行要求「下一号 == 自身 sequence」；聚合行要求「跨度覆盖下一号」。
        const eventSpanStart = spanStartOf(event)
        const eventCoversNext = eventSpanStart === undefined
          ? event.sequence === cursor + 1
          : eventSpanStart <= cursor + 1
        if (toCanonicalOwnerKey(event.owner) !== ownerKey || !eventCoversNext) {
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
