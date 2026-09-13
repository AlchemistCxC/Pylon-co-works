import type { ContentPart } from '../../domains/workbench/content/contentPartSchema.ts'
import type { WorkbenchDocument, WorkbenchMessage } from '../../domains/workbench/workbenchProjector.ts'
import type { WorkbenchRuntimeSnapshot } from '../../domains/workbench/workbenchRuntime.ts'

/**
 * Renderer-side pacing defaults.
 *
 * The runtime and canonical journal remain latest-wins and lossless. These
 * values only control how quickly a Solid tree consumes the already projected
 * snapshot. Keeping the constants here (instead of in the projector) makes
 * the seam explicit and leaves room for a future Presentation Profile token.
 *
 * Reveal policy (two bounds, whichever is stricter):
 * - a baseline typing pace (`revealUnitsPerSecond`), so a slow stream reads
 *   like a typewriter instead of a sequence of jumps; and
 * - a per-frame bound (`maxRevealUnitsPerTick`), raised towards by the
 *   catch-up window (`maxRevealLagMs`) so a backlog converges quickly without
 *   ever painting a whole block in one frame.
 * Both bounds apply to every publication, the terminal one included: a
 * finished response stops generating and shows its summary immediately, then
 * its remaining text keeps converging at the same pace.
 */
export const DEFAULT_STREAMING_DISPLAY_OPTIONS = Object.freeze({
  /**
   * One publication per display frame: fast streams advance in smaller steps
   * instead of being coalesced into a 30 Hz frame. The cost is a doubled
   * publication rate (incremental markdown parse + row measure per publish),
   * which is why this is the frame rate rather than "as fast as possible".
   */
  maxUpdatesPerSecond: 60,
  revealUnitsPerSecond: 120,
  /**
   * Hard per-frame visual bound: one publication never adds more than this to
   * a streaming row. This is the contract that keeps a fast stream (and a
   * finished one) from painting a whole block in one frame, which is what
   * breaks live layout measurement; it doubles as the guard against a resumed
   * background callback painting an unbounded amount of text.
   */
  maxRevealUnitsPerTick: 128,
  /** Target time for the revealed text to converge with the newest snapshot. */
  maxRevealLagMs: 400,
})

export interface StreamingDisplaySchedulerOptions {
  /** Maximum number of display snapshot publications per second. */
  maxUpdatesPerSecond?: number
  /** Target number of Unicode grapheme clusters revealed per second. */
  revealUnitsPerSecond?: number
  /** Hard cap for one timer tick, even after a delayed background callback. */
  maxRevealUnitsPerTick?: number
  /** Maximum time the revealed text may trail the newest snapshot. */
  maxRevealLagMs?: number
  /** Injectable clock for non-browser hosts and deterministic diagnostics. */
  now?: () => number
}

/** S0 诊断：一次发布是「按预算插值」还是「整发（replacement/reset/flush）。 */
export type StreamingDisplayPublicationKind = 'whole' | 'budgeted'

/**
 * S0 只读诊断读数。纯观测：不参与任何节奏决策，调用不得改变调度器状态。
 * 采样走固定容量环形缓冲（64）O(1) 记录，不新增全量扇描。
 */
export interface StreamingDisplayDiagnosticsSnapshot {
  readonly publishes: number
  readonly lastPublicationKind: StreamingDisplayPublicationKind
  /** budgeted 发布：单行最大新增（UTF-16 单元）；whole 发布为 null（整发不适用预算） */
  readonly lastPublicationMaxUnits: number | null
  /** budgeted 发布：所有行新增之和（UTF-16 单元）；whole 发布为 null */
  readonly lastPublicationTotalUnits: number | null
  /** 最近一次 revealBudget 计算出的欠账（UTF-16 单元） */
  readonly lastBacklogUnits: number
  /** 最近一次一拍预算（UTF-16 单元） */
  readonly lastBudget: number
  /** 追赶窗口（重新）开启的次数 */
  readonly catchUpWindows: number
  readonly terminalPublications: number
  readonly flushes: number
  /** 最近 ≤64 次发布的实际间隔（ms，按发生顺序） */
  readonly recentPublicationIntervalsMs: readonly number[]
}

export interface StreamingDisplayScheduler {
  /** Offer the newest raw runtime snapshot (latest target wins). */
  push(snapshot: WorkbenchRuntimeSnapshot): void
  /** Publish the complete target immediately, or retain it until resume if paused. */
  flush(snapshot?: WorkbenchRuntimeSnapshot): void
  /** Stop timer work while retaining the latest target/display state. */
  pause(): void
  /**
   * Resume from the newest raw snapshot and publish its structure immediately.
   * Unrevealed text keeps converging under the reveal bounds, so returning to a
   * surface that streamed in the background never paints one whole block.
   */
  resume(snapshot?: WorkbenchRuntimeSnapshot): void
  /** Cancel pending work and release references. */
  dispose(): void
  /**
   * S0 只读诊断读数：纯观测，调用不改变任何节奏状态。
   * 用于在真机会话里验证“发布节奏/单拍增量/追赶次数”，也是行几何诊断的入口。
   */
  diagnostics(): StreamingDisplayDiagnosticsSnapshot
}

/** Renderer safety net: never publish an impossible terminal combination. */
export function cohereDisplaySnapshot(snapshot: WorkbenchRuntimeSnapshot): WorkbenchRuntimeSnapshot {
  if (snapshot.summary === null && snapshot.terminalFence === undefined) return snapshot
  if (!snapshot.generating && snapshot.generationStart === 0 && snapshot.generationPhase === undefined && snapshot.generationActivity === undefined && snapshot.thinkingStart === undefined) return snapshot
  return {
    ...snapshot,
    generating: false,
    generationStart: 0,
    generationPhase: undefined,
    generationActivity: undefined,
    thinkingStart: undefined,
  }
}

type DisplayMessage = {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly running?: boolean
  readonly parts?: readonly ContentPart[]
}

/** 一次发布的可选标注（S0）：kind 必填，单位仅在 budgeted 时有效。 */
interface StreamingDisplayPublication {
  readonly kind: StreamingDisplayPublicationKind
  readonly maxUnits?: number
  readonly totalUnits?: number
}

interface MessageProgress<T extends DisplayMessage> {
  readonly messages: readonly T[]
  readonly pending: boolean
  /** S0：本列表本次推进的单行最大新增（UTF-16 单元） */
  readonly advancedMaxUnits: number
  /** S0：本列表本次推进的所有行新增之和（UTF-16 单元） */
  readonly advancedTotalUnits: number
}

interface PrefixAdvance {
  readonly value: string
  readonly consumed: number
}

interface GraphemeSegment {
  readonly segment: string
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
  ) => GraphemeSegmenter
}

const graphemeSegmenter = createGraphemeSegmenter()

/**
 * Create a renderer-only latest-wins display scheduler.
 *
 * `publish` is called at most `maxUpdatesPerSecond` for ordinary stream
 * updates, and no publication ever adds more than `maxRevealUnitsPerTick` to a
 * streaming row. Identity/reset transitions replace the displayed rows whole
 * (the text cannot be interpolated anyway); every other transition — a segment
 * finishing mid-turn, a new row, a terminal state, a resume — publishes its
 * structure immediately while the not-yet-revealed text keeps converging under
 * the same bounds.
 */
export function createStreamingDisplayScheduler(
  publish: (snapshot: WorkbenchRuntimeSnapshot) => void,
  options: StreamingDisplaySchedulerOptions = {},
): StreamingDisplayScheduler {
  const maxUpdatesPerSecond = positiveFinite(
    options.maxUpdatesPerSecond,
    DEFAULT_STREAMING_DISPLAY_OPTIONS.maxUpdatesPerSecond,
  )
  const revealUnitsPerSecond = positiveFinite(
    options.revealUnitsPerSecond,
    DEFAULT_STREAMING_DISPLAY_OPTIONS.revealUnitsPerSecond,
  )
  const maxRevealUnitsPerTick = Math.max(1, Math.floor(positiveFinite(
    options.maxRevealUnitsPerTick,
    DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealUnitsPerTick,
  )))
  const maxRevealLagMs = positiveFinite(
    options.maxRevealLagMs,
    DEFAULT_STREAMING_DISPLAY_OPTIONS.maxRevealLagMs,
  )
  const updateIntervalMs = 1000 / maxUpdatesPerSecond
  /** Ticks a full backlog is allowed to take to catch up. */
  const catchUpTicks = Math.max(1, Math.ceil(maxRevealLagMs / updateIntervalMs))
  /** Backlog the smooth typing pace already clears within the lag window. */
  const smoothBacklogCapacity = revealUnitsPerSecond * maxRevealLagMs / 1000
  const now = options.now ?? defaultNow

  let target: WorkbenchRuntimeSnapshot | undefined
  let displayed: WorkbenchRuntimeSnapshot | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let paused = false
  let disposed = false
  let lastPublishedAt = Number.NEGATIVE_INFINITY
  let lastTickAt = now()
  let terminalFlushToken: object | undefined
  /** Start of the window in which the current backlog must be fully revealed. */
  let catchUpDeadline = Number.NEGATIVE_INFINITY

  // ── S0 只读诊断（不参与任何节奏决策）────────────────────────
  const DIAGNOSTIC_INTERVAL_CAPACITY = 64
  const publicationIntervals: number[] = []
  let publicationIntervalCursor = 0
  let previousPublicationAt = Number.NEGATIVE_INFINITY
  let diagnosticsPublishes = 0
  let diagnosticsKind: StreamingDisplayPublicationKind = 'whole'
  let diagnosticsMaxUnits: number | null = null
  let diagnosticsTotalUnits: number | null = null
  let diagnosticsBacklogUnits = 0
  let diagnosticsBudget = 0
  let diagnosticsCatchUpWindows = 0
  let diagnosticsTerminalPublications = 0
  let diagnosticsFlushes = 0

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  /**
   * A push that outruns the typing pace starts (or extends) a fixed catch-up
   * window. Extending it on every such push is what makes the policy a *lag*
   * bound: continuous fast text keeps the window open while a one-shot burst
   * drains completely within it.
   */
  const noteBacklog = (snapshot: WorkbenchRuntimeSnapshot) => {
    if (displayed === undefined) return
    if (pendingTextUnits(displayed, snapshot) <= smoothBacklogCapacity) return
    catchUpDeadline = Math.max(catchUpDeadline, now() + maxRevealLagMs)
  }

  const publishSnapshot = (
    snapshot: WorkbenchRuntimeSnapshot,
    timestamp = now(),
    publication: StreamingDisplayPublication = { kind: 'whole' },
  ) => {
    if (disposed) return
    // A synchronous flush or owner switch supersedes an older queued terminal.
    terminalFlushToken = undefined
    displayed = snapshot
    lastPublishedAt = timestamp
    lastTickAt = timestamp
    // Publishing the full target means nothing is left to catch up.
    if (snapshot === target) catchUpDeadline = Number.NEGATIVE_INFINITY
    // S0：只读计数（O(1)，不扇扫）。整发不适用预算，故单位字段记 null，避免伪造读数。
    diagnosticsPublishes += 1
    diagnosticsKind = publication.kind
    diagnosticsMaxUnits = publication.kind === 'budgeted' ? Math.max(0, publication.maxUnits ?? 0) : null
    diagnosticsTotalUnits = publication.kind === 'budgeted' ? Math.max(0, publication.totalUnits ?? 0) : null
    if (Number.isFinite(previousPublicationAt)) {
      const gap = Math.max(0, timestamp - previousPublicationAt)
      if (publicationIntervals.length < DIAGNOSTIC_INTERVAL_CAPACITY) publicationIntervals.push(gap)
      else {
        publicationIntervals[publicationIntervalCursor] = gap
        publicationIntervalCursor = (publicationIntervalCursor + 1) % DIAGNOSTIC_INTERVAL_CAPACITY
      }
    }
    previousPublicationAt = timestamp
    publish(snapshot)
  }

  const schedule = () => {
    if (disposed || paused || timer !== undefined || target === undefined || displayed === undefined) return
    const elapsed = now() - lastPublishedAt
    const delay = Number.isFinite(elapsed)
      ? Math.max(0, updateIntervalMs - elapsed)
      : 0
    timer = setTimeout(() => {
      timer = undefined
      tick()
    }, delay)
  }

  /**
   * Reveal budget for one tick: the smooth typing pace, raised whenever the
   * backlog would otherwise outlive its catch-up deadline.
   */
  const revealBudget = (timestamp: number): number => {
    const elapsedSinceTick = Math.max(0, timestamp - lastTickAt)
    const baseline = Math.max(1, Math.round(
      revealUnitsPerSecond * Math.max(elapsedSinceTick, updateIntervalMs) / 1000,
    ))
    if (displayed === undefined || target === undefined) return Math.min(maxRevealUnitsPerTick, baseline)
    const backlog = pendingTextUnits(displayed, target)
    diagnosticsBacklogUnits = backlog
    if (backlog <= 0) return Math.min(maxRevealUnitsPerTick, baseline)
    // An unarmed window (smooth stream) or one already elapsed (throttled
    // background timer) restarts here, so the countdown never degrades into
    // "reveal everything left in this frame".
    if (!(catchUpDeadline > timestamp)) {
      catchUpDeadline = timestamp + maxRevealLagMs
      diagnosticsCatchUpWindows += 1
    }
    const ticksLeft = Math.max(1, Math.ceil((catchUpDeadline - timestamp) / updateIntervalMs))
    const catchUp = Math.ceil(backlog / Math.min(catchUpTicks, ticksLeft))
    const budget = Math.min(maxRevealUnitsPerTick, Math.max(baseline, catchUp))
    diagnosticsBudget = budget
    return budget
  }

  const tick = () => {
    if (disposed || paused || target === undefined || displayed === undefined) return
    const timestamp = now()
    const budget = revealBudget(timestamp)
    lastTickAt = timestamp

    if (requiresReplacementFlush(displayed, target)) {
      clearTimer()
      publishSnapshot(target, timestamp)
      return
    }

    const projection = interpolateSnapshot(displayed, target, budget)
    if (!projection.pending) {
      // `interpolateSnapshot` uses target's non-text fields. Once all text has
      // caught up, publish the original object to restore every canonical part
      // and preserve reference identity for unaffected consumers.
      clearTimer()
      catchUpDeadline = Number.NEGATIVE_INFINITY
      if (displayed !== target) publishSnapshot(target, timestamp)
      return
    }

    publishSnapshot(projection.snapshot, timestamp, {
      kind: 'budgeted',
      maxUnits: projection.advancedMaxUnits,
      totalUnits: projection.advancedTotalUnits,
    })
    schedule()
  }

  const push = (snapshot: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    snapshot = cohereDisplaySnapshot(snapshot)
    if (paused) { target = snapshot; return }
    if (displayed !== undefined) snapshot = preserveDisplayedPrefix(displayed, snapshot)
    target = snapshot
    if (displayed === undefined) {
      publishSnapshot(snapshot)
      return
    }

    if (requiresReplacementFlush(displayed, snapshot)) {
      clearTimer()
      publishSnapshot(snapshot)
      return
    }

    if (isTerminalFlush(displayed, snapshot)) {
      // The finished state has to land now (summary, elapsed, running=false),
      // but not the text that is still being revealed: coalesce the
      // transition into one budgeted publication instead of a whole-block
      // paint. A 6000 units/s response used to hand its entire tail to one
      // frame here, which is exactly what a live row cannot lay out.
      clearTimer()
      queueTerminalFlush()
      return
    }

    const pending = hasPendingTextGrowth(displayed, snapshot)
    if (!pending) {
      // Nothing is left to reveal for this snapshot, so any catch-up window is
      // stale. Non-streaming changes should stay responsive; while a stream is
      // active they still respect the same cadence, so a burst of usage/tool
      // updates cannot create an independent render storm.
      catchUpDeadline = Number.NEGATIVE_INFINITY
      const activeStream = hasActiveTextStream(snapshot)
      if (!activeStream || now() - lastPublishedAt >= updateIntervalMs) tick()
      else schedule()
      return
    }

    noteBacklog(snapshot)
    if (now() - lastPublishedAt >= updateIntervalMs) tick()
    else schedule()
  }

  const flush = (snapshot?: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    if (snapshot !== undefined) target = cohereDisplaySnapshot(snapshot)
    if (target === undefined) return
    clearTimer()
    terminalFlushToken = undefined
    if (!paused) {
      diagnosticsFlushes += 1
      publishSnapshot(target)
    }
  }

  // Canonical projection and legacy generation metadata can arrive back to
  // back for one terminal event. Coalesce the terminal transition into one
  // microtask publication so the finished state lands immediately; the
  // publication is an ordinary tick, so "the turn is over" never becomes a
  // whole-block paint of the text that was still being revealed.
  function queueTerminalFlush(): void {
    if (terminalFlushToken !== undefined || disposed) return
    const token = terminalFlushToken = {}
    queueMicrotask(() => {
      if (terminalFlushToken !== token) return
      terminalFlushToken = undefined
      if (disposed || paused) return
      diagnosticsTerminalPublications += 1
      tick()
    })
  }

  const pause = () => {
    if (disposed) return
    paused = true
    terminalFlushToken = undefined
    clearTimer()
  }

  const resume = (snapshot?: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    paused = false
    if (snapshot !== undefined) target = cohereDisplaySnapshot(snapshot)
    if (target === undefined || displayed === undefined) return
    noteBacklog(target)
    tick()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    terminalFlushToken = undefined
    clearTimer()
    target = undefined
    displayed = undefined
  }

  const diagnostics = (): StreamingDisplayDiagnosticsSnapshot => {
    const recent: number[] = []
    if (publicationIntervals.length < DIAGNOSTIC_INTERVAL_CAPACITY) {
      for (const gap of publicationIntervals) recent.push(gap)
    } else {
      for (let index = 0; index < DIAGNOSTIC_INTERVAL_CAPACITY; index += 1) {
        recent.push(publicationIntervals[(publicationIntervalCursor + index) % DIAGNOSTIC_INTERVAL_CAPACITY])
      }
    }
    return {
      publishes: diagnosticsPublishes,
      lastPublicationKind: diagnosticsKind,
      lastPublicationMaxUnits: diagnosticsMaxUnits,
      lastPublicationTotalUnits: diagnosticsTotalUnits,
      lastBacklogUnits: diagnosticsBacklogUnits,
      lastBudget: diagnosticsBudget,
      catchUpWindows: diagnosticsCatchUpWindows,
      terminalPublications: diagnosticsTerminalPublications,
      flushes: diagnosticsFlushes,
      recentPublicationIntervalsMs: recent,
    }
  }

  return { push, flush, pause, resume, dispose, diagnostics }
}

/**
 * Canonical and compatibility streams may briefly publish different-length
 * prefixes for the same running row. Do not make the display retract while
 * the newer canonical snapshot is still active; retain the longer displayed
 * prefix until a later snapshot catches up (or a terminal snapshot arrives).
 */
function preserveDisplayedPrefix(
  displayed: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): WorkbenchRuntimeSnapshot {
  if (!next.generating
    || displayed.sessionId !== next.sessionId
    || displayed.ownerKey !== next.ownerKey
    || displayed.generation !== next.generation
    || displayed.turnEpoch !== next.turnEpoch) return next
  const messages = preserveMessagePrefixes(displayed.messages, next.messages)
  const documentMessages = displayed.document && next.document
    ? preserveMessagePrefixes(displayed.document.messages, next.document.messages)
    : next.document?.messages
  const document = next.document && documentMessages !== next.document.messages
    ? { ...next.document, messages: documentMessages as WorkbenchDocument['messages'] } : next.document
  if (messages === next.messages && document === next.document) return next
  return {
    ...next,
    messages,
    ...(document ? { document } : {}),
  }
}

function preserveMessagePrefixes<T extends DisplayMessage>(
  displayed: readonly T[],
  next: readonly T[],
): readonly T[] {
  if (displayed === next) return next
  const displayedById = new Map(displayed.map(message => [message.id, message]))
  let corrected: T[] | undefined
  next.forEach((message, index) => {
    const previous = displayedById.get(message.id)
    if (!previous || previous.role !== message.role || !message.running || message.content.length >= previous.content.length) return
    if (!previous.content.startsWith(message.content)) return
    corrected ??= [...next]
    corrected[index] = previous
  })
  return corrected ?? next
}

function isTerminalTransition(current: WorkbenchRuntimeSnapshot, next: WorkbenchRuntimeSnapshot): boolean {
  if (current.sessionId !== next.sessionId || current.ownerKey !== next.ownerKey) return false
  if (next.summary !== null && next.summary !== current.summary) return true
  return current.generating && !next.generating
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function hasActiveTextStream(snapshot: WorkbenchRuntimeSnapshot): boolean {
  return snapshot.messages.some(message => (
    (message.role === 'assistant' || message.role === 'reasoning') && message.running === true
  )) || Boolean(snapshot.document?.messages.some(message => (
    (message.role === 'assistant' || message.role === 'reasoning') && message.running === true
  )))
}

function hasPendingTextGrowth(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): boolean {
  if (messageListHasPendingGrowth(current.messages, next.messages)) return true
  if (current.document && next.document
    && messageListHasPendingGrowth(current.document.messages, next.document.messages)) return true
  return false
}

/**
 * Cheap size of the not-yet-revealed text, used only to size the catch-up
 * budget. It counts UTF-16 units (never grapheme clusters) on purpose: the
 * budget must not pay for segmenting the entire backlog on every tick.
 */
function pendingTextUnits(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): number {
  let total = messageListPendingUnits(current.messages, next.messages)
  if (current.document && next.document) {
    total += messageListPendingUnits(current.document.messages, next.document.messages)
  }
  return total
}

function messageListPendingUnits<T extends DisplayMessage>(
  current: readonly T[],
  next: readonly T[],
): number {
  if (current === next) return 0
  const currentById = new Map(current.map(message => [message.id, message]))
  let total = 0
  for (const message of next) {
    if (!isStreamMessage(message)) continue
    const previous = currentById.get(message.id)
    const previousText = previous?.role === message.role ? previous.content : ''
    if (isPrefixGrowth(previousText, message.content)) total += message.content.length - previousText.length
  }
  return total
}

function isPrefixGrowth(current: string, next: string): boolean {
  return next.length > current.length && next.startsWith(current)
}

/**
 * Transitions that *replace* what is on screen. Their text cannot be
 * interpolated (the rows are gone, re-keyed or rewritten), so they stay
 * synchronous and whole.
 */
function requiresReplacementFlush(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): boolean {
  if (current.sessionId !== next.sessionId
    || current.ownerKey !== next.ownerKey
    || current.generation !== next.generation
    || current.turnEpoch !== next.turnEpoch) return true
  if (current.document?.sessionId !== next.document?.sessionId) return true

  if (requiresImmediateReplacement(current.messages, next.messages)
    || current.document && next.document && requiresImmediateReplacement(current.document.messages, next.document.messages)
    || current.document === undefined !== (next.document === undefined)) return true

  if (hasNonPrefixMessageChange(current.messages, next.messages)) return true
  if (current.document && next.document && hasNonPrefixMessageChange(current.document.messages, next.document.messages)) return true
  return false
}

/**
 * The finished/aborted state of a turn — summary, elapsed time, error status,
 * `running=false` — has to land now; its *text* must not. Routing these through
 * the coalesced budgeted publication is what keeps "the turn is over" from
 * becoming one whole-block paint of everything that was still being revealed.
 */
function isTerminalFlush(current: WorkbenchRuntimeSnapshot, next: WorkbenchRuntimeSnapshot): boolean {
  if (isTerminalTransition(current, next)) return true
  if (next.status === 'error') return true
  return hasPendingTextGrowth(current, next) && next.generating === false
}

function hasNonPrefixMessageChange<T extends DisplayMessage>(
  current: readonly T[],
  next: readonly T[],
): boolean {
  if (current === next) return false
  const currentById = new Map(current.map(message => [message.id, message]))
  for (const message of next) {
    const previous = currentById.get(message.id)
    if (!previous || previous.role !== message.role) continue
    if (message.content !== previous.content && !message.content.startsWith(previous.content)) return true
  }
  return false
}

/**
 * A list may append one or more *running* assistant/reasoning rows while a
 * stream crosses a semantic boundary, and it may append rows that are already
 * finished. Neither is a replacement: appended rows are new text (revealed
 * under the same pace) and an appended non-stream row such as a user echo is
 * never clipped. Only a shorter or re-keyed list invalidates what is on screen
 * and must be published wholesale.
 */
function requiresImmediateReplacement<T extends DisplayMessage>(
  current: readonly T[],
  next: readonly T[],
): boolean {
  if (current === next) return false
  if (next.length < current.length) return true
  for (let index = 0; index < current.length; index += 1) {
    const previous = current[index]
    const incoming = next[index]
    if (!previous || !incoming || previous.id !== incoming.id || previous.role !== incoming.role) return true
  }
  return false
}

function isStreamMessage(message: DisplayMessage): boolean {
  return message.role === 'assistant' || message.role === 'reasoning'
}

function messageListHasPendingGrowth<T extends DisplayMessage>(
  current: readonly T[],
  next: readonly T[],
): boolean {
  if (current === next) return false
  const currentById = new Map(current.map(message => [message.id, message]))
  for (const message of next) {
    if (!isStreamMessage(message)) continue
    const previous = currentById.get(message.id)
    const previousText = previous?.role === message.role ? previous.content : ''
    if (isPrefixGrowth(previousText, message.content)) return true
  }
  return false
}

interface SnapshotProjection {
  readonly snapshot: WorkbenchRuntimeSnapshot
  readonly pending: boolean
  readonly advancedMaxUnits: number
  readonly advancedTotalUnits: number
}

function interpolateSnapshot(
  current: WorkbenchRuntimeSnapshot,
  target: WorkbenchRuntimeSnapshot,
  budget: number,
): SnapshotProjection {
  const legacy = interpolateMessageList(current.messages, target.messages, budget)
  const documentProgress = target.document && current.document
    ? interpolateMessageList(current.document.messages, target.document.messages, budget)
    : target.document
      ? interpolateMessageList([], target.document.messages, budget)
      : { messages: [], pending: false, advancedMaxUnits: 0, advancedTotalUnits: 0 }

  const pending = legacy.pending || documentProgress.pending

  if (!pending) return { snapshot: target, pending: false, advancedMaxUnits: 0, advancedTotalUnits: 0 }

  const document = target.document
    ? {
        ...target.document,
        messages: documentProgress.messages as readonly WorkbenchMessage[],
      } as WorkbenchDocument
    : undefined
  return {
    snapshot: {
      ...target,
      messages: legacy.messages,
      ...(document ? { document } : {}),
    },
    pending: true,
    advancedMaxUnits: Math.max(legacy.advancedMaxUnits, documentProgress.advancedMaxUnits),
    advancedTotalUnits: legacy.advancedTotalUnits + documentProgress.advancedTotalUnits,
  }
}

function interpolateMessageList<T extends DisplayMessage>(
  current: readonly T[],
  target: readonly T[],
  budget: number,
): MessageProgress<T> {
  if (current === target) return { messages: target, pending: false, advancedMaxUnits: 0, advancedTotalUnits: 0 }
  const currentById = new Map(current.map(message => [message.id, message]))
  let pending = false
  let advancedMaxUnits = 0
  let advancedTotalUnits = 0
  const messages = target.map(message => {
    if (!isStreamMessage(message)) return message
    const previous = currentById.get(message.id)
    const previousText = previous?.role === message.role ? previous.content : ''
    if (!message.content.startsWith(previousText) || message.content.length <= previousText.length) return message
    const advanced = advancePrefix(previousText, message.content, budget)
    // S0：按 UTF-16 单元计数（与欠账口径一致），仅观测。
    const advancedUnits = Math.max(0, advanced.value.length - previousText.length)
    advancedTotalUnits += advancedUnits
    if (advancedUnits > advancedMaxUnits) advancedMaxUnits = advancedUnits
    if (advanced.value === message.content) return message
    pending = true
    const parts = partialTextParts(message.parts, advanced.value)
    return {
      ...message,
      content: advanced.value,
      ...(parts !== undefined ? { parts } : {}),
    } as T
  })
  return { messages, pending, advancedMaxUnits, advancedTotalUnits }
}

function partialTextParts(
  parts: readonly ContentPart[] | undefined,
  visibleText: string,
): readonly ContentPart[] | undefined {
  if (parts === undefined) return undefined
  if (visibleText.length === 0) return []

  // Keep the canonical block kinds during interpolation. Replacing a rich
  // multi-part message with one synthetic markdown part changes paragraph/
  // code-block geometry on every terminal handoff, which is visible as a
  // height jump. Clip only text-bearing parts to the visible prefix and do
  // not expose later rich parts until their text range is reached.
  const textKinds = new Set(['text', 'markdown', 'code', 'ansi', 'reasoning', 'thinking'])
  let remaining = visibleText.length
  const clipped: ContentPart[] = []
  for (const part of parts) {
    if (!textKinds.has(part.kind) || typeof (part as { text?: unknown }).text !== 'string') {
      if (remaining > 0) continue
      break
    }
    const text = (part as { text: string }).text
    const take = Math.min(remaining, text.length)
    if (take > 0) clipped.push({ ...part, text: text.slice(0, take) } as ContentPart)
    remaining -= take
    if (remaining <= 0) break
  }
  return clipped
}

function advancePrefix(current: string, target: string, budget: number): PrefixAdvance {
  if (current === target) return { value: current, consumed: 0 }
  if (!target.startsWith(current)) return { value: target, consumed: 0 }
  const remaining = target.slice(current.length)
  if (!remaining || budget <= 0) return { value: current, consumed: 0 }

  let consumed = 0
  let codeUnits = 0
  if (graphemeSegmenter) {
    for (const item of graphemeSegmenter.segment(remaining)) {
      if (consumed >= budget) break
      codeUnits += item.segment.length
      consumed += 1
    }
  } else {
    // `for…of` iterates Unicode code points (not UTF-16 halves), which is a
    // safe fallback for older WebView implementations without Segmenter.
    for (const item of remaining) {
      if (consumed >= budget) break
      codeUnits += item.length
      consumed += 1
    }
  }
  return { value: current + remaining.slice(0, codeUnits), consumed }
}

function createGraphemeSegmenter(): GraphemeSegmenter | undefined {
  if (typeof Intl === 'undefined') return undefined
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  if (!Segmenter) return undefined
  try {
    return new Segmenter(undefined, { granularity: 'grapheme' })
  } catch {
    return undefined
  }
}
