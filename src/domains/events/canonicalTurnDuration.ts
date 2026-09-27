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
 * state instead of inventing `0s` or hiding the result.
 *
 * **与 `latestTurnBoundary` 的区别：本函数是回合无关的**（「历史上出现过终态」），
 * 只可用于「有没有历史耗时可呈现」这类问题。**不得**用它判定「当前回合是否已收敛」
 * ——那会把上一轮的终态行当成这一轮收敛的证据（见 `latestTurnBoundary`）。 */
export function hasCanonicalTurnTerminal(
  events: readonly Pick<CanonicalTurnBoundaryEvent, 'eventType'>[],
): boolean {
  return events.some(event => TURN_TERMINAL_EVENT_TYPES.has(event.eventType))
}

/** 回合开始锚点：`user.message` 之后尚未出现终态边界 ⇒ 该回合（从 journal 视角）仍在途。 */
const TURN_ANCHOR_EVENT_TYPE = 'user.message'

/**
 * 终态边界事件集合。`turn.unit` 计入是因为 compact 读会裁剪掉 `turn.completed|failed`
 * 单行，单元行是同一事务内写的替代证据（`canonicalUnit.ts`：单元行由内核在写入
 * `turn.completed|failed` 的**同一事务**内追加）
 *——它只在回合收敛时出现，不会在回合中途出现。
 */
const TURN_TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set(['turn.completed', 'turn.failed', 'turn.unit'])

/**
 * 观测到的**最新**回合边界形态（回合作用域）。
 *
 * - `'terminal'`：最新的边界事件是终态边界 ⇒ journal 证明「当前回合已收敛」；
 * - `'open'`：最新的边界事件是 `user.message` 锚点（其后无终态）⇒ 当前回合未收敛；
 * - `'unknown'`：没有任何回合边界事件 ⇒ 无证据（不猜）。
 *
 * 这是「当前回合是否已终态」的**唯一**合法判据；`hasCanonicalTurnTerminal` 的
 * 回合无关语义不能用于此（见其文档）。同序号畸形输入取锚点——宁可判「未收敛」
 * （随后到达的终帧可自愈），也不误判「已收敛」（会不可逆地封存回合时钟）。
 */
export function latestTurnBoundary(
  events: readonly Pick<CanonicalTurnBoundaryEvent, 'sequence' | 'eventType'>[],
): LatestTurnBoundary {
  let latest: { readonly sequence: number; readonly kind: 'anchor' | 'terminal' } | undefined
  for (const event of events) {
    const kind = event.eventType === TURN_ANCHOR_EVENT_TYPE
      ? 'anchor' as const
      : TURN_TERMINAL_EVENT_TYPES.has(event.eventType) ? 'terminal' as const : undefined
    if (kind === undefined) continue
    if (latest === undefined
      || event.sequence > latest.sequence
      || (event.sequence === latest.sequence && kind === 'anchor')) {
      latest = { sequence: event.sequence, kind }
    }
  }
  if (latest === undefined) return 'unknown'
  return latest.kind === 'terminal' ? 'terminal' : 'open'
}

export type LatestTurnBoundary = 'terminal' | 'open' | 'unknown'

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * #376-b：分页装载的终态判据累积——把行投影成「推导只需要的那几个标量」。
 *
 * **不得**保留行引用或整份 `typedPayload`：unit 行的载荷是整段回合正文，留下它等于没分页。
 * 投影的形状与 `embeddedUserAnchorAt` 的读点一一对应，故二者同处一个文件，改读点即改这里。
 */
export function canonicalBoundaryProjection(rows: readonly unknown[]): CanonicalTurnBoundaryEvent[] {
  const projected: CanonicalTurnBoundaryEvent[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const candidate = row as {
      sequence?: unknown
      eventType?: unknown
      occurredAt?: unknown
      receivedAt?: unknown
      typedPayload?: unknown
    }
    if (typeof candidate.sequence !== 'number' || typeof candidate.eventType !== 'string') continue
    projected.push({
      sequence: candidate.sequence,
      eventType: candidate.eventType as CanonicalTurnBoundaryEvent['eventType'],
      ...(typeof candidate.occurredAt === 'string' ? { occurredAt: candidate.occurredAt } : {}),
      ...(typeof candidate.receivedAt === 'string' ? { receivedAt: candidate.receivedAt } : {}),
      ...(candidate.eventType === 'turn.unit' ? { typedPayload: userAnchorOnly(candidate.typedPayload) } : {}),
    })
  }
  return projected
}

/** 只留 `embeddedUserAnchorAt` 会读的字段（内嵌 event 段里的 user.message 时间戳）。 */
function userAnchorOnly(typedPayload: unknown): { segments: readonly unknown[] } | undefined {
  if (!typedPayload || typeof typedPayload !== 'object') return undefined
  const segments = (typedPayload as { segments?: unknown }).segments
  if (!Array.isArray(segments)) return undefined
  const anchors = segments.flatMap(segment => {
    if (!segment || typeof segment !== 'object') return []
    const holder = segment as { kind?: unknown; event?: unknown }
    if (holder.kind !== 'event' || !holder.event || typeof holder.event !== 'object') return []
    const event = holder.event as { eventType?: unknown; occurredAt?: unknown }
    if (event.eventType !== 'user.message' || typeof event.occurredAt !== 'string') return []
    return [{ kind: 'event' as const, event: { eventType: 'user.message', occurredAt: event.occurredAt } }]
  })
  return { segments: anchors }
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
