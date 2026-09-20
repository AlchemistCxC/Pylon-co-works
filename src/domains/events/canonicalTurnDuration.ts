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
  /**
   * #199：compact 读（`evt_load_compact`）只返回 unit 行 + 未覆盖行，回合的
   * `user.message` 锚点只作为内嵌 event segment 存在于 `typedPayload.segments`。
   * 顶层缺锚点时从这里恢复起点；形状异常视同无锚点（不得凭空造 0s）。
   */
  readonly typedPayload?: unknown
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
    // #81 L2：单元行（occurredAt = 其 terminal 的 occurredAt）同样封存 turn 边界——
    // compact 读返回单元 + 未覆盖行，terminal 行可能已被 L3 裁剪。
    if (event.eventType !== 'turn.completed' && event.eventType !== 'turn.failed' && event.eventType !== 'turn.unit') continue
    // #199：顶层没有 user 锚点行时（compact 读的常态），从 unit 内嵌 segments 恢复
    // 起点——只认内嵌 event 段的 user.message，取首个有效时间戳（segments 保序）。
    if (startedAt === undefined) {
      startedAt = embeddedUserAnchorAt(event.typedPayload)
    }
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
  return events.some(event => event.eventType === 'turn.completed' || event.eventType === 'turn.failed' || event.eventType === 'turn.unit')
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * #199：unit 行内嵌 segments 里的 user.message 锚点（首个有效 occurredAt）。
 * 形状与 `turn.unit` 的 segment 契约一致（`{kind:'event', event}`）；任何形状
 * 异常都返回 undefined——推导宁可「不可测」也不猜。
 */
function embeddedUserAnchorAt(typedPayload: unknown): number | undefined {
  if (!typedPayload || typeof typedPayload !== 'object') return undefined
  const segments = (typedPayload as { segments?: unknown }).segments
  if (!Array.isArray(segments)) return undefined
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue
    const holder = segment as { kind?: unknown; event?: unknown }
    if (holder.kind !== 'event' || !holder.event || typeof holder.event !== 'object') continue
    const event = holder.event as { eventType?: unknown; occurredAt?: unknown }
    if (event.eventType !== 'user.message') continue
    const anchor = parseTimestamp(typeof event.occurredAt === 'string' ? event.occurredAt : undefined)
    if (anchor !== undefined) return anchor
  }
  return undefined
}
