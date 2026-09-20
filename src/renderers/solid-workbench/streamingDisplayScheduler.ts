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
   * Hard per-frame visual bound. It has two readings, both contract:
   * - one publication never adds more than this to a *single* row;
   * - one publication never adds more than this *in aggregate* across all rows
   *   either (D1: the budget is decremented row by row, so N running rows can
   *   no longer each take the full step in the same frame).
   * Accounting is in UTF-16 units (D2), and the step never splits a grapheme.
   * This is the contract that keeps a fast stream (and a finished one) from
   * painting a whole block in one frame, which is what breaks live layout
   * measurement; it doubles as the guard against a resumed background callback
   * painting an unbounded amount of text.
   */
  maxRevealUnitsPerTick: 128,
  /** Target time for the revealed text to converge with the newest snapshot. */
  maxRevealLagMs: 400,
})

/**
 * 帧源：请求一帧并返回取消函数。
 * 语义：回调最多被调用一次；取消后不得再调用。
 */
export type StreamingDisplayFrameSource = (callback: () => void) => () => void

export interface StreamingDisplaySchedulerOptions {
  /** Maximum number of display snapshot publications per second. */
  maxUpdatesPerSecond?: number
  /** Target number of Unicode grapheme clusters revealed per second. */
  revealUnitsPerSecond?: number
  /** Hard cap for one timer tick, even after a delayed background callback. */
  maxRevealUnitsPerTick?: number
  /** Maximum time the revealed text may trail the newest snapshot. */
  maxRevealLagMs?: number
  /**
   * 历史增长是否也走预算插值（默认**否**，#212）。
   *
   * 默认口径：预算插值只在「本拍有直播语义」时使用——快照 `generating === true`，
   * 或已有行处于揭示中（本调度器推进过、尚未收敛）。一批**已完成**的历史
   * （`generating === false` 且没有任何行在揭示中）**整发上屏**：插值对它们只是延迟，
   * 而且会让每一拍的新前缀都走静态路径整段重解析（静态路径不走 graft，见 #212 R2）。
   * 置 `true` 恢复本刀之前的行为（新行一律按预算逐拍揭示），是这一刀的回滚开关。
   */
  interpolateHistory?: boolean
  /**
   * 帧源（可注入，默认浏览器 rAF）：**可见时**把发布对齐到下一帧，
   * 避免"发布了但没显示"，并自动匹配 120/144Hz 屏幕。
   * 不注入或环境无 rAF 时走纯定时器路径（与帧对齐前行为一致）。
   * 隐藏时**不用**帧源——定时器就是心跳，发布继续（用户决策 D-A）。
   */
  frame?: StreamingDisplayFrameSource
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
  /** 整发（`whole`）与按预算（`budgeted`）发布的累计次数——判据 A 的 A/B 读数。 */
  readonly wholePublications: number
  readonly budgetedPublications: number
  /** #212 判据 A 命中次数：本应逐拍揭示的历史增长被整发上屏的次数。 */
  readonly historyPublications: number
  /** #212 判据 C：被观察到在增长的行 key 数（渲染层走增量路径的集合大小）。 */
  readonly growingRows: number
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
   * #212 判据 C：**本次会话里被观察到「文本在两次发布之间变长」的行 key 集合**
   * （`streamingRowKey(id, role)`）。渲染层据此把该行留在增量（graft）路径上；
   * 属行为判据，兜住权威活性的漏判。换会话/换 owner 时清空。
   */
  revealingRows(): ReadonlySet<string>
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

interface PrefixAdvance {
  readonly value: string
  /** 本次揭示消费的 UTF-16 单元数（D2：与预算/欠账同量纲） */
  readonly consumedUnits: number
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
  const interpolateHistory = options.interpolateHistory === true

  // ── #212 判据 A / C 的两份行集合 ──────────────────────────────
  // `midRevealKeys`：**瞬态**——本调度器推进过、尚未收敛的行。它非空是「非生成态的
  //   增长仍可插值」的唯一理由（终态交接：结构立刻落地，正在揭示的文本按同一节奏收敛）。
  // `growingKeys`：**粘滞**——被观察到「文本在两次发布之间变长」的行，渲染层据此把该行
  //   留在增量路径；换会话/换 owner 才清空（行 key 只在同一会话内可比）。
  const midRevealKeys = new Set<string>()
  const growingKeys = new Set<string>()

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

  // ── S1 帧对齐（D-A：隐藏不停发，定时器即心跳）─────────────────
  const requestFrame = options.frame ?? defaultFrameSource()
  let cancelFrame: (() => void) | undefined
  let frameRequestedAt = 0

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
  let diagnosticsWholePublications = 0
  let diagnosticsBudgetedPublications = 0
  let diagnosticsHistoryPublications = 0

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  /** 排一个心跳定时器（单例：已有定时器时不重复排）。 */
  const armTimer = (delayMs: number) => {
    if (disposed || paused || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      publishOnDue()
    }, Math.max(0, delayMs))
  }

  const clearFrame = () => {
    if (cancelFrame === undefined) return
    cancelFrame()
    cancelFrame = undefined
  }

  /**
   * 可见且帧源可用时才把发布对齐到帧；隐藏（或无帧源）直接走定时器——
   * 用户决策 D-A：窗口隐藏也继续收敛，定时器就是心跳。
   */
  const framesAlignable = (): boolean => requestFrame !== undefined
    && (typeof document === 'undefined' || document.visibilityState === 'visible')

  /**
   * 到期即发布：可见时排到下一帧，隐藏/无帧源时立即发布。
   * 帧停摆兜底：帧源存在但一帧都没来（遮挡/合成器节流）时，超过两拍就取消并直接发布，
   * 保证"隐藏或遮挡也继续收敛"不被一个不流动的 rAF 破坏（心跳语义优先）。
   */
  const publishOnDue = () => {
    const scheduleFrame = requestFrame
    if (scheduleFrame === undefined || !framesAlignable()) {
      tick()
      return
    }
    const timestamp = now()
    if (cancelFrame !== undefined) {
      const sinceRequest = timestamp - frameRequestedAt
      if (sinceRequest < updateIntervalMs * 2) {
        // 还在等这一帧：**按整拍**重挂心跳（不能挂 0ms——那会变成热循环），
        // 同时保证下一拍仍能走到停摆判定。
        armTimer(Math.max(updateIntervalMs, updateIntervalMs * 2 - sinceRequest))
        return
      }
      // 帧停摆（遮挡/节流）：取消该帧并**直接发布**，不重排——心跳语义优先于帧对齐。
      clearFrame()
      tick()
      return
    }
    frameRequestedAt = timestamp
    cancelFrame = scheduleFrame(() => {
      cancelFrame = undefined
      // 帧到了：清掉等帧心跳，由 tick() 的 schedule() 按**实际发布节奏**重排。
      clearTimer()
      tick()
    })
    // 排了帧也要给下一次机会：帧若一直不来，下一拍会在这里发现停摆并直接发布。
    armTimer(updateIntervalMs)
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
    if (publication.kind === 'budgeted') diagnosticsBudgetedPublications += 1
    else diagnosticsWholePublications += 1
    // 整发意味着没有东西在揭示了（结构替换、终态收敛、历史整发都在此清账）。
    if (publication.kind !== 'budgeted') midRevealKeys.clear()
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
    armTimer(delay)
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
      midRevealKeys.clear()
      if (displayed !== target) publishSnapshot(target, timestamp)
      return
    }

    replaceKeySet(midRevealKeys, projection.pendingKeys)
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

    // 判据 C：行 key 只在同一会话内可比；换会话/换 owner 后两份集合都无意义。
    const sameBinding = displayed.sessionId === snapshot.sessionId
      && displayed.ownerKey === snapshot.ownerKey
    if (!sameBinding) {
      midRevealKeys.clear()
      growingKeys.clear()
    } else {
      // 跨会话不记账：id+role 可能撞 key（ACP 消息 id 常从 0 起），会把新会话的行
      // 误判成"在长"（今天有"提升即全量"自愈，但那是巧合而非契约）。
      noteObservedGrowth(displayed, snapshot, growingKeys)
    }

    if (requiresReplacementFlush(displayed, snapshot)) {
      clearTimer()
      publishSnapshot(snapshot)
      return
    }

    const pending = hasPendingTextGrowth(displayed, snapshot)

    // 判据 A（#212）：预算插值只在「本拍有直播语义」时使用。一批**已完成**的历史
    // （`generating === false` 且没有任何行处于揭示中）整发上屏——逐拍揭示对它们只是延迟，
    // 而且每一拍的新前缀都会走静态路径整段重解析（R2）。
    if (pending && !interpolateHistory && snapshot.generating !== true && midRevealKeys.size === 0) {
      clearTimer()
      catchUpDeadline = Number.NEGATIVE_INFINITY
      diagnosticsHistoryPublications += 1
      publishSnapshot(snapshot)
      return
    }

    if (isTerminalFlush(displayed, snapshot, pending)) {
      // The finished state has to land now (summary, elapsed, running=false),
      // but not the text that is still being revealed: coalesce the
      // transition into one budgeted publication instead of a whole-block
      // paint. A 6000 units/s response used to hand its entire tail to one
      // frame here, which is exactly what a live row cannot lay out.
      clearTimer()
      queueTerminalFlush()
      return
    }

    if (!pending) {
      // Nothing is left to reveal for this snapshot, so any catch-up window is
      // stale. Non-streaming changes should stay responsive; while a stream is
      // active they still respect the same cadence, so a burst of usage/tool
      // updates cannot create an independent render storm.
      catchUpDeadline = Number.NEGATIVE_INFINITY
      const activeStream = hasActiveTextStream(snapshot)
      if (!activeStream || now() - lastPublishedAt >= updateIntervalMs) publishOnDue()
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
    clearFrame()
  }

  const resume = (snapshot?: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    paused = false
    if (snapshot !== undefined) target = cohereDisplaySnapshot(snapshot)
    if (target === undefined || displayed === undefined) return
    // 暂停期间的快速增长也要记进判据 C（resume 不走 push）——同样只在同一绑定内记账。
    if (displayed.sessionId === target.sessionId && displayed.ownerKey === target.ownerKey) {
      noteObservedGrowth(displayed, target, growingKeys)
    }
    // 判据 A：后台攒下来的历史（非生成态、无行在揭示中）整发，不从预算里爬。
    if (!interpolateHistory && target.generating !== true && midRevealKeys.size === 0
      && hasPendingTextGrowth(displayed, target)) {
      diagnosticsHistoryPublications += 1
      publishSnapshot(target)
      return
    }
    noteBacklog(target)
    tick()
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    terminalFlushToken = undefined
    clearTimer()
    clearFrame()
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
      wholePublications: diagnosticsWholePublications,
      budgetedPublications: diagnosticsBudgetedPublications,
      historyPublications: diagnosticsHistoryPublications,
      growingRows: growingKeys.size,
      recentPublicationIntervalsMs: recent,
    }
  }

  return { push, flush, pause, resume, dispose, revealingRows: () => growingKeys, diagnostics }
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

/** 默认帧源：浏览器 rAF；无 rAF 的宿主（或测试）返回 undefined ⇒ 纯定时器路径。 */
function defaultFrameSource(): StreamingDisplayFrameSource | undefined {
  if (typeof requestAnimationFrame !== 'function') return undefined
  return callback => {
    const handle = requestAnimationFrame(() => callback())
    return () => cancelAnimationFrame(handle)
  }
}

function hasActiveTextStream(snapshot: WorkbenchRuntimeSnapshot): boolean {
  // #213：本进程没有在途回合时，文档里遗留的 `running` 行不算"流在跑"——否则一批
  // 非文本更新会被一个已死回合拖进节流档。
  if (snapshot.generating !== true) return false
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
  // D3：与 pendingTextUnits 同一口径（归并双列表），避免两处判据分叉。
  return pendingRowPlans(current, next).size > 0
}

/**
 * Cheap size of the not-yet-revealed text, used only to size the catch-up
 * budget. It counts UTF-16 units (never grapheme clusters) on purpose: the
 * budget must not pay for segmenting the entire backlog on every tick.
 * D3：双列表同源时按 id+role 归并，同一行只计费一次。
 */
function pendingTextUnits(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): number {
  let total = 0
  for (const plan of pendingRowPlans(current, next).values()) {
    total += plan.nextText.length - plan.previousText.length
  }
  return total
}

/** 一行待揭示文本的计费/决策单元（D3：同 id+role 出现在两个列表时只算一行）。 */
interface StreamRowPlan {
  readonly previousText: string
  readonly nextText: string
}

/**
 * 收集"待揭示"行：只认 assistant/reasoning 的前缀增长。
 * 两个列表（legacy `messages` 与 canonical `document.messages`）按 id+role 归并：
 * 同一行只计费一次、只决策一次（D3）——否则双列表同源时欠账与预算双双翻倍。
 */
function collectStreamRowPlans(
  current: readonly DisplayMessage[],
  target: readonly DisplayMessage[],
  plans: Map<string, StreamRowPlan>,
): void {
  if (current === target) return
  const currentById = new Map(current.map(message => [message.id, message]))
  for (const message of target) {
    if (!isStreamMessage(message)) continue
    const previous = currentById.get(message.id)
    const previousText = previous?.role === message.role ? previous.content : ''
    if (!isPrefixGrowth(previousText, message.content)) continue
    const key = streamingRowKey(message.id, message.role)
    const existing = plans.get(key)
    // 双写正常时两份文本一致；万一短暂分叉，以更长的目标文本作为可见量（保守不超发）。
    if (existing === undefined || message.content.length > existing.nextText.length) {
      plans.set(key, { previousText, nextText: message.content })
    }
  }
}

/**
 * 当前快照对下所有待揭示行的归并集合。
 * 注：`current.document` 缺失而 `next.document` 存在属于整发转换（`requiresReplacementFlush`），
 * 不会走到插值；此处与 `interpolateSnapshot` 保持同一条件，避免两处判据分叉。
 */
function pendingRowPlans(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): Map<string, StreamRowPlan> {
  const plans = new Map<string, StreamRowPlan>()
  collectStreamRowPlans(current.messages, next.messages, plans)
  if (next.document !== undefined) {
    collectStreamRowPlans(current.document?.messages ?? [], next.document.messages, plans)
  }
  return plans
}

/**
 * 行 key：显示调度器与渲染层共用的**唯一**格式（判据 C 的集合成员判据）。
 * 不要在渲染层手写这份字符串——两份定义一旦漂移，`revealingRows()` 会静默失配。
 */
export function streamingRowKey(id: string, role: string): string {
  return `${id}\u0000${role}`
}

const EMPTY_ROW_KEYS: readonly string[] = Object.freeze([])

function replaceKeySet(target: Set<string>, source: readonly string[]): void {
  target.clear()
  for (const key of source) target.add(key)
}

/**
 * #212 判据 C：把「同一行文本在两次发布之间变长」记进 `into`。
 *
 * 只认**已存在**行（同一 id+role 之前就在显示态里）的前缀增长：首次出现的行没有参照物，
 * 「新」不等于「在长」——它的活性由权威判据（运行时在途回合）负责。两份列表（legacy
 * `messages` 与 canonical `document.messages`）同源时按同一 key 记账，天然去重。
 */
function noteObservedGrowth(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
  into: Set<string>,
): void {
  collectObservedGrowth(current.messages, next.messages, into)
  if (next.document !== undefined) {
    collectObservedGrowth(current.document?.messages ?? [], next.document.messages, into)
  }
}

function collectObservedGrowth(
  current: readonly DisplayMessage[],
  next: readonly DisplayMessage[],
  into: Set<string>,
): void {
  if (current === next) return
  const currentByKey = new Map(current.map(message => [streamingRowKey(message.id, message.role), message]))
  for (const message of next) {
    if (!isStreamMessage(message)) continue
    const previous = currentByKey.get(streamingRowKey(message.id, message.role))
    if (previous === undefined) continue
    if (isPrefixGrowth(previous.content, message.content)) into.add(streamingRowKey(message.id, message.role))
  }
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
function isTerminalFlush(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
  pendingGrowth: boolean = hasPendingTextGrowth(current, next),
): boolean {
  if (isTerminalTransition(current, next)) return true
  if (next.status === 'error') return true
  return pendingGrowth && next.generating === false
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

interface SnapshotProjection {
  readonly snapshot: WorkbenchRuntimeSnapshot
  readonly pending: boolean
  readonly advancedMaxUnits: number
  readonly advancedTotalUnits: number
  /** #212 判据 A：本拍结束时仍未收敛的行 key（`pending` 为假时为空）。 */
  readonly pendingKeys: readonly string[]
}

/** 一行的本拍决策：揭示到的前缀 + 该行分到的预算（供两列表短暂分叉时回落）。 */
interface RowDecision {
  readonly value: string
  readonly perRow: number
}

function interpolateSnapshot(
  current: WorkbenchRuntimeSnapshot,
  target: WorkbenchRuntimeSnapshot,
  budget: number,
): SnapshotProjection {
  const plans = pendingRowPlans(current, target)
  if (plans.size === 0) return { snapshot: target, pending: false, advancedMaxUnits: 0, advancedTotalUnits: 0, pendingKeys: EMPTY_ROW_KEYS }

  // D1：递减预算——逐行决策一次，任何一次发布的**聚合**新增不超过 budget。
  // budget ≥ 行数 时每行至少分到 1；budget < 行数 时末尾行本拍分到 0（不饿死：下一拍重算）。
  const decisions = new Map<string, RowDecision>()
  const pendingKeys: string[] = []
  let remaining = Math.max(0, Math.floor(budget))
  let rowsLeft = plans.size
  let advancedMaxUnits = 0
  let advancedTotalUnits = 0
  let pending = false
  for (const [key, plan] of plans) {
    const perRow = rowsLeft > 1 ? Math.max(1, Math.floor(remaining / rowsLeft)) : remaining
    const advanced = advancePrefix(plan.previousText, plan.nextText, perRow)
    decisions.set(key, { value: advanced.value, perRow })
    advancedTotalUnits += advanced.consumedUnits
    if (advanced.consumedUnits > advancedMaxUnits) advancedMaxUnits = advanced.consumedUnits
    remaining = Math.max(0, remaining - advanced.consumedUnits)
    rowsLeft -= 1
    if (advanced.value.length < plan.nextText.length) {
      pending = true
      pendingKeys.push(key)
    }
  }

  if (!pending) return { snapshot: target, pending: false, advancedMaxUnits: 0, advancedTotalUnits: 0, pendingKeys: EMPTY_ROW_KEYS }

  const legacyMessages = applyRowDecisions(current.messages, target.messages, decisions)
  const documentMessages = applyRowDecisions(
    current.document?.messages ?? [],
    target.document?.messages ?? [],
    decisions,
  )
  const document = target.document
    ? {
        ...target.document,
        messages: documentMessages as readonly WorkbenchMessage[],
      } as WorkbenchDocument
    : undefined
  return {
    snapshot: {
      ...target,
      messages: legacyMessages,
      ...(document ? { document } : {}),
    },
    pending: true,
    advancedMaxUnits,
    advancedTotalUnits,
    pendingKeys,
  }
}

/**
 * 把本拍决策写回一个列表：同一 id+role 的行共用同一决策（D3），
 * 因此两列表同源时不会各自推进一次，聚合也不会翻倍。
 * 决策不是该行目标文本的前缀时（两列表短暂分叉）用该行自己的预算回落推进，绝不整发。
 */
function applyRowDecisions<T extends DisplayMessage>(
  current: readonly T[],
  target: readonly T[],
  decisions: ReadonlyMap<string, RowDecision>,
): readonly T[] {
  if (decisions.size === 0 || current === target) return target
  const currentById = new Map(current.map(message => [message.id, message]))
  let changed = false
  const messages = target.map(message => {
    if (!isStreamMessage(message)) return message
    const decision = decisions.get(streamingRowKey(message.id, message.role))
    if (decision === undefined) return message
    const previous = currentById.get(message.id)
    const previousText = previous?.role === message.role ? previous.content : ''
    // 决策可用时两列表得到**同一**前缀；否则回落为本行预算（不整发、不回退）。
    const value = isDecisionUsable(previousText, decision.value, message.content)
      ? decision.value
      : advancePrefix(previousText, message.content, decision.perRow).value
    if (value === message.content) return message
    changed = true
    const parts = partialTextParts(message.parts, value)
    return {
      ...message,
      content: value,
      ...(parts !== undefined ? { parts } : {}),
    } as T
  })
  return changed ? messages : target
}

/** 决策可用于该行：必须是该行目标文本的前缀，且不得让该行回退。 */
function isDecisionUsable(previousText: string, value: string, targetText: string): boolean {
  return value.length >= previousText.length && targetText.startsWith(value)
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
  if (current === target) return { value: current, consumedUnits: 0 }
  if (!target.startsWith(current)) return { value: target, consumedUnits: 0 }
  const remaining = target.slice(current.length)
  if (!remaining || budget <= 0) return { value: current, consumedUnits: 0 }

  // D2：记账量纲 = UTF-16 单元（与欠账/预算一致），步进单位 = 字素（不切开字素）。
  // 于是 astral 文本（1 字素 = 2+ 单元）也不会超预算，代价是最多少用一个字素的余量。
  let codeUnits = 0
  if (graphemeSegmenter) {
    for (const item of graphemeSegmenter.segment(remaining)) {
      const next = codeUnits + item.segment.length
      if (next > budget) break
      codeUnits = next
    }
  } else {
    // `for…of` iterates Unicode code points (not UTF-16 halves), which is a
    // safe fallback for older WebView implementations without Segmenter.
    for (const item of remaining) {
      const next = codeUnits + item.length
      if (next > budget) break
      codeUnits = next
    }
  }
  return { value: current + remaining.slice(0, codeUnits), consumedUnits: codeUnits }
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
