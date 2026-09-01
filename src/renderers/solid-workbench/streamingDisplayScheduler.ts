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
 */
export const DEFAULT_STREAMING_DISPLAY_OPTIONS = Object.freeze({
  maxUpdatesPerSecond: 30,
  revealUnitsPerSecond: 120,
  maxRevealUnitsPerTick: 12,
})

export interface StreamingDisplaySchedulerOptions {
  /** Maximum number of display snapshot publications per second. */
  maxUpdatesPerSecond?: number
  /** Target number of Unicode grapheme clusters revealed per second. */
  revealUnitsPerSecond?: number
  /** Hard cap for one timer tick, even after a delayed background callback. */
  maxRevealUnitsPerTick?: number
  /** Injectable clock for non-browser hosts and deterministic diagnostics. */
  now?: () => number
}

export interface StreamingDisplayScheduler {
  /** Offer the newest raw runtime snapshot (latest target wins). */
  push(snapshot: WorkbenchRuntimeSnapshot): void
  /** Publish the complete target immediately, discarding display backlog. */
  flush(snapshot?: WorkbenchRuntimeSnapshot): void
  /** Stop timer work while retaining the latest target/display state. */
  pause(): void
  /** Resume from the newest raw snapshot and converge in one publication. */
  resume(snapshot?: WorkbenchRuntimeSnapshot): void
  /** Cancel pending work and release references. */
  dispose(): void
}

type DisplayMessage = {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly running?: boolean
  readonly parts?: readonly ContentPart[]
}

interface MessageProgress<T extends DisplayMessage> {
  readonly messages: readonly T[]
  readonly pending: boolean
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
 * updates. Hard resets and terminal flushes are deliberately immediate so a
 * completed response can never remain visually truncated.
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
  const updateIntervalMs = 1000 / maxUpdatesPerSecond
  const now = options.now ?? defaultNow

  let target: WorkbenchRuntimeSnapshot | undefined
  let displayed: WorkbenchRuntimeSnapshot | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let paused = false
  let disposed = false
  let lastPublishedAt = Number.NEGATIVE_INFINITY
  let lastTickAt = now()
  let terminalFlushQueued = false

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const publishSnapshot = (snapshot: WorkbenchRuntimeSnapshot, timestamp = now()) => {
    if (disposed) return
    displayed = snapshot
    lastPublishedAt = timestamp
    lastTickAt = timestamp
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

  const tick = () => {
    if (disposed || paused || target === undefined || displayed === undefined) return
    const timestamp = now()
    const elapsedSinceTick = Math.max(0, timestamp - lastTickAt)
    const budget = Math.min(
      maxRevealUnitsPerTick,
      Math.max(1, Math.round(revealUnitsPerSecond * Math.max(elapsedSinceTick, updateIntervalMs) / 1000)),
    )
    lastTickAt = timestamp

    if (requiresImmediateFlush(displayed, target)) {
      clearTimer()
      if (isTerminalTransition(displayed, target)) queueTerminalFlush()
      else publishSnapshot(target, timestamp)
      return
    }

    const projection = interpolateSnapshot(displayed, target, budget)
    if (!projection.pending) {
      // `interpolateSnapshot` uses target's non-text fields. Once all text has
      // caught up, publish the original object to restore every canonical part
      // and preserve reference identity for unaffected consumers.
      if (displayed !== target) publishSnapshot(target, timestamp)
      clearTimer()
      return
    }

    publishSnapshot(projection.snapshot, timestamp)
    schedule()
  }

  const push = (snapshot: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    target = snapshot
    if (displayed === undefined) {
      publishSnapshot(snapshot)
      return
    }

    if (requiresImmediateFlush(displayed, snapshot)) {
      clearTimer()
      if (isTerminalTransition(displayed, snapshot)) queueTerminalFlush()
      else publishSnapshot(snapshot)
      return
    }

    const pending = hasPendingTextGrowth(displayed, snapshot)
    if (!pending) {
      // Non-streaming changes should stay responsive. While a stream is active
      // they still respect the same cadence, so a burst of usage/tool updates
      // cannot create an independent render storm.
      const activeStream = hasActiveTextStream(snapshot)
      if (!activeStream || now() - lastPublishedAt >= updateIntervalMs) tick()
      else schedule()
      return
    }

    if (now() - lastPublishedAt >= updateIntervalMs) tick()
    else schedule()
  }

  const flush = (snapshot?: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    if (snapshot !== undefined) target = snapshot
    if (target === undefined) return
    clearTimer()
    publishSnapshot(target)
  }

  // Canonical projection and legacy generation metadata can arrive back to
  // back for one terminal event. Coalesce only terminal transitions within the
  // current microtask; explicit flush() and structural session switches remain
  // synchronous so a completed response is never visibly truncated.
  function queueTerminalFlush(): void {
    if (terminalFlushQueued || disposed) return
    terminalFlushQueued = true
    queueMicrotask(() => {
      terminalFlushQueued = false
      if (disposed || paused || target === undefined) return
      clearTimer()
      publishSnapshot(target)
    })
  }

  const pause = () => {
    if (disposed) return
    paused = true
    clearTimer()
  }

  const resume = (snapshot?: WorkbenchRuntimeSnapshot) => {
    if (disposed) return
    paused = false
    if (snapshot !== undefined) target = snapshot
    if (target !== undefined) flush(target)
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    clearTimer()
    target = undefined
    displayed = undefined
  }

  return { push, flush, pause, resume, dispose }
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
  if (snapshot.streamingText.length > 0 || snapshot.streamingThinking.length > 0) return true
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
  if (isPrefixGrowth(current.streamingText, next.streamingText)
    || isPrefixGrowth(current.streamingThinking, next.streamingThinking)) return true
  if (messageListHasPendingGrowth(current.messages, next.messages)) return true
  if (current.document && next.document
    && messageListHasPendingGrowth(current.document.messages, next.document.messages)) return true
  return false
}

function isPrefixGrowth(current: string, next: string): boolean {
  return next.length > current.length && next.startsWith(current)
}

function requiresImmediateFlush(
  current: WorkbenchRuntimeSnapshot,
  next: WorkbenchRuntimeSnapshot,
): boolean {
  if (current.sessionId !== next.sessionId
    || current.ownerKey !== next.ownerKey
    || current.generation !== next.generation) return true
  if (current.document?.sessionId !== next.document?.sessionId) return true
  if (next.status === 'error' || next.summary !== null && next.summary !== current.summary) return true

  if (messageShapeRequiresReset(current.messages, next.messages)
    || current.document && next.document && messageShapeRequiresReset(current.document.messages, next.document.messages)
    || current.document === undefined !== (next.document === undefined)) return true

  if (hasNonPrefixMessageChange(current.messages, next.messages)) return true
  if (current.document && next.document && hasNonPrefixMessageChange(current.document.messages, next.document.messages)) return true
  if (hasNonPrefixStringChange(current.streamingText, next.streamingText)
    || hasNonPrefixStringChange(current.streamingThinking, next.streamingThinking)) return true

  const pending = hasPendingTextGrowth(current, next)
  // A terminal text snapshot must never wait for the next timer. This also
  // covers “assistant finished, tool is still running” projections.
  if (pending && (!hasActiveTextStream(next) || next.generating === false)) return true
  return false
}

function hasNonPrefixStringChange(current: string, next: string): boolean {
  return current.length > 0 && next !== current && !next.startsWith(current)
}

function hasNonPrefixMessageChange<T extends DisplayMessage>(
  current: readonly T[],
  next: readonly T[],
): boolean {
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
 * stream crosses a semantic boundary. Any other insertion/removal/reorder is
 * a snapshot replacement and should be shown immediately.
 */
function messageShapeRequiresReset<T extends DisplayMessage>(
  current: readonly T[],
  next: readonly T[],
): boolean {
  if (next.length < current.length) return true
  for (let index = 0; index < current.length; index += 1) {
    const previous = current[index]
    const incoming = next[index]
    if (!previous || !incoming || previous.id !== incoming.id || previous.role !== incoming.role) return true
  }
  for (let index = current.length; index < next.length; index += 1) {
    const appended = next[index]
    if (!appended || !isStreamMessage(appended) || appended.running !== true) return true
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
      : { messages: [], pending: false }

  const streamingText = advancePrefix(current.streamingText, target.streamingText, budget).value
  const streamingThinking = advancePrefix(current.streamingThinking, target.streamingThinking, budget).value
  const pending = legacy.pending || documentProgress.pending
    || streamingText !== target.streamingText
    || streamingThinking !== target.streamingThinking

  if (!pending) return { snapshot: target, pending: false }

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
      streamingText,
      streamingThinking,
      ...(document ? { document } : {}),
    },
    pending: true,
  }
}

function interpolateMessageList<T extends DisplayMessage>(
  current: readonly T[],
  target: readonly T[],
  budget: number,
): MessageProgress<T> {
  const currentById = new Map(current.map(message => [message.id, message]))
  let pending = false
  const messages = target.map(message => {
    if (!isStreamMessage(message)) return message
    const previous = currentById.get(message.id)
    const previousText = previous?.role === message.role ? previous.content : ''
    if (!message.content.startsWith(previousText) || message.content.length <= previousText.length) return message
    const advanced = advancePrefix(previousText, message.content, budget)
    if (advanced.value === message.content) return message
    pending = true
    const parts = partialTextParts(message.parts, advanced.value)
    return {
      ...message,
      content: advanced.value,
      ...(parts !== undefined ? { parts } : {}),
    } as T
  })
  return { messages, pending }
}

function partialTextParts(
  parts: readonly ContentPart[] | undefined,
  visibleText: string,
): readonly ContentPart[] | undefined {
  if (parts === undefined) return undefined
  if (visibleText.length === 0) return []

  // A stream can contain rich parts, but exposing the target parts while only
  // part of `content` is visible would leak the not-yet-rendered tail through
  // a semantic Slot. During the short partial window use one safe Markdown
  // text part; the terminal tick restores the canonical parts object.
  const preferred = parts.find(part => (
    part.kind === 'markdown' || part.kind === 'text' || part.kind === 'reasoning' || part.kind === 'thinking'
  ))
  const kind = preferred?.kind === 'text' ? 'text' : 'markdown'
  return [{ kind, text: visibleText }]
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
