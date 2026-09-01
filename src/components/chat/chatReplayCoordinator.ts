import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import type { PersistedSessionLoadResult, ReplayMetadata } from '../../infrastructure/acp/sessionClient.ts'
import { reconcileIngressMessages, type ChatIdentityCapabilities } from './messageIdentity'
import type { ChatEvent } from './sessionRuntimeStore.ts'
import type { Message } from './messageTypes.ts'

export type ReplayLoadAuthority = 'local-journal' | 'recovery-import' | 'remote-fallback' | 'none'
export type ReplayLoadCommit = 'canonical-projection' | 'replay-snapshot' | 'preserved-runtime' | 'empty'

/**
 * The narrow load seam consumed by useSessionLifecycle.  The controller remains a
 * compatibility adapter, but all load policy (generation, authority precedence and
 * commit selection) lives here and is intentionally free of UI/store dependencies.
 */
export interface ReplayLoadOutcome {
  readonly authority: ReplayLoadAuthority
  readonly canonicalRevision: number
  readonly replayMetadata: ReplayMetadata
  readonly messages: Message[]
  readonly commit: ReplayLoadCommit
  readonly response: unknown
  readonly replayCount: number
  readonly replayJournalStatus: PersistedSessionLoadResult['replayJournalStatus']
  readonly generation: number
}

export interface ReplayLoadControllerAdapter {
  beginLoadLock(source: string): number
  finishLoadLock(source: string, generation: number): void
  abortSessionLoad(source: string, generation: number): void
  commitReplaySnapshot(source: string, generation: number, replay: unknown[]): Message[]
  commitCanonicalProjection(source: string, generation: number, messages: Message[], canonicalRevision: number): Message[]
  /** Preserve runtime and drain buffered live events when no complete snapshot exists. */
  commitPreservedRuntime?: (source: string, generation: number) => Message[]
  seedCanonicalCursor?: (ownerKey: string, sequence: number) => void
}

export interface ReplayLoadRequest {
  readonly source: string
  readonly ownerKey: string
  readonly cached?: Message[]
  readonly load: () => Promise<PersistedSessionLoadResult>
  readonly loadCanonical: () => Promise<CanonicalEventRow[]>
  readonly projectCanonical: (rows: readonly CanonicalEventRow[]) => Message[]
  /** Session switch/reload guard owned by the caller's binding. */
  readonly isCurrent?: () => boolean
}

export interface ReplayCanonicalPlaceholder {
  readonly rows: CanonicalEventRow[]
  readonly messages: Message[]
  readonly revision: number
}

export class ReplayLoadInProgressError extends Error {
  readonly code = 'replay_load_in_progress' as const

  constructor(source: string) {
    super(`Replay load already in progress for ${source}`)
    this.name = 'ReplayLoadInProgressError'
  }
}

/**
 * Owns one source-scoped replay load transaction.  A load either commits one
 * authoritative projection/snapshot or explicitly preserves the current runtime;
 * it never silently drops events buffered while the response was in flight.
 */
export class ReplayLoadCoordinator {
  private sequence = 0
  private readonly current = new Map<string, number>()
  private readonly inFlight = new Set<string>()

  constructor(private readonly controller: ReplayLoadControllerAdapter) {}

  currentGeneration(source: string): number | undefined {
    return this.current.get(source)
  }

  async readCanonicalPlaceholder(request: {
    readonly ownerKey: string
    readonly loadCanonical: () => Promise<CanonicalEventRow[]>
    readonly projectCanonical: (rows: readonly CanonicalEventRow[]) => Message[]
  }): Promise<ReplayCanonicalPlaceholder> {
    const rows = await request.loadCanonical()
    const revision = rows.reduce((max, row) => Math.max(max, row.sequence), 0)
    this.controller.seedCanonicalCursor?.(request.ownerKey, revision)
    return { rows, messages: request.projectCanonical(rows), revision }
  }

  async load(request: ReplayLoadRequest): Promise<ReplayLoadOutcome | null> {
    if (this.inFlight.has(request.source)) throw new ReplayLoadInProgressError(request.source)
    this.inFlight.add(request.source)
    const generation = ++this.sequence
    this.current.set(request.source, generation)
    let lockGeneration: number | undefined
    try {
      lockGeneration = this.controller.beginLoadLock(request.source)
      const result = await request.load()
      if (!this.isCurrent(request, generation)) {
        this.controller.finishLoadLock(request.source, lockGeneration)
        return null
      }

      const canonicalRows = await request.loadCanonical()
      if (!this.isCurrent(request, generation)) {
        this.controller.finishLoadLock(request.source, lockGeneration)
        return null
      }

      const observedCanonicalRevision = canonicalRows.reduce((max, row) => Math.max(max, row.sequence), 0)
      this.controller.seedCanonicalCursor?.(request.ownerKey, observedCanonicalRevision)

      const projectionRows = result.authority === 'local-journal'
        ? canonicalRows.filter(row => row.provenance?.origin === 'local-observed' && row.provenance.trust === 'authoritative')
        : canonicalRows
      const replayFallbackAllowed = result.replayMetadata.complete && result.authority !== 'local-journal'

      let messages: Message[]
      let commit: ReplayLoadCommit
      if (projectionRows.length > 0) {
        messages = this.controller.commitCanonicalProjection(
          request.source,
          lockGeneration,
          request.projectCanonical(projectionRows),
          observedCanonicalRevision,
        )
        commit = 'canonical-projection'
      } else if (replayFallbackAllowed) {
        messages = this.controller.commitReplaySnapshot(request.source, lockGeneration, result.replay)
        commit = 'replay-snapshot'
      } else if (this.controller.commitPreservedRuntime) {
        messages = this.controller.commitPreservedRuntime(request.source, lockGeneration)
        commit = 'preserved-runtime'
      } else {
        // Compatibility adapters predating the preserve seam still get a safe
        // explicit outcome; their finish call is idempotent after this branch.
        messages = request.cached ? [...request.cached] : []
        commit = messages.length > 0 ? 'preserved-runtime' : 'empty'
      }
      this.controller.finishLoadLock(request.source, lockGeneration)

      return {
        authority: resolveOutcomeAuthority(result, canonicalRows, replayFallbackAllowed),
        canonicalRevision: observedCanonicalRevision,
        replayMetadata: result.replayMetadata,
        messages,
        commit,
        response: result.response,
        replayCount: result.replay.length,
        replayJournalStatus: result.replayJournalStatus,
        generation,
      }
    } catch (error) {
      if (lockGeneration !== undefined) this.controller.abortSessionLoad(request.source, lockGeneration)
      throw error
    } finally {
      this.inFlight.delete(request.source)
    }
  }

  private isCurrent(request: ReplayLoadRequest, generation: number): boolean {
    return this.current.get(request.source) === generation && (request.isCurrent?.() ?? true)
  }
}

function resolveOutcomeAuthority(
  result: PersistedSessionLoadResult,
  canonicalRows: readonly CanonicalEventRow[],
  replayFallbackAllowed: boolean,
): ReplayLoadAuthority {
  if (result.authority === 'local-journal') return 'local-journal'
  if (result.authority === 'recovery-import') return 'recovery-import'
  if (canonicalRows.length > 0) return 'recovery-import'
  if (replayFallbackAllowed) return 'remote-fallback'
  return 'none'
}

/**
 * Replay 权威历史与 load 期间 live 增量的合并 seam。
 * 只按外部 identity 去重；无 identity 的 live 增量保守保留。
 */
export function mergeReplayMessages<T extends {
  id: string
  role?: string
  sender?: string
  content?: string
  externalIdentity?: { messageId?: string; eventId?: string; turnId?: string; toolCallId?: string }
}>(
  resolved: T[],
  liveAdditions: T[],
  capabilities: ChatIdentityCapabilities = {},
): T[] {
  return reconcileIngressMessages(resolved, liveAdditions, capabilities)
}

/** 收敛并行 listener 注册结果，保留成功项并暴露失败项供重试。 */
export function settleListeners<T>(
  listeners: Array<Promise<T>>,
  onRejected: (reason: unknown, index: number) => void,
): Promise<{ fns: T[]; failures: Array<{ index: number; reason: unknown }> }> {
  return Promise.allSettled(listeners).then(results => {
    const fns: T[] = []
    const failures: Array<{ index: number; reason: unknown }> = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        fns.push(result.value)
      } else {
        failures.push({ index, reason: result.reason })
        onRejected(result.reason, index)
      }
    })
    return { fns, failures }
  })
}

export function stripReplayPersonaPrefix(content: string): string {
  const separator = '\n\n---\n\n'
  const index = content.indexOf(separator)
  if (index < 0) return content
  const stripped = content.slice(index + separator.length)
  return stripped || content
}

function canonicalTypedText(event: CanonicalEventRow): string | undefined {
  const text = (event.typedPayload as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

/** Match a load-buffered UI event to the canonical row that committed it. */
export function canonicalRepresentsChatEvent(row: CanonicalEventRow, event: ChatEvent): boolean {
  if (row.owner.localSessionId !== event.source) return false
  const identity = row.identity
  switch (event.type) {
    case 'user':
      return row.eventType === 'user.message' && canonicalTypedText(row) === event.content
    case 'message-chunk':
      return row.eventType === 'assistant.text.delta'
        && canonicalTypedText(row) === event.text
        && (!event.externalIdentity?.messageId || identity?.messageId === event.externalIdentity.messageId)
    case 'thought-chunk':
      return row.eventType === 'assistant.thinking.delta'
        && canonicalTypedText(row) === event.text
        && (!event.externalIdentity?.turnId || identity?.turnId === event.externalIdentity.turnId)
    case 'tool-call':
      return row.eventType === 'tool.call.started'
        && (!event.toolCallId || identity?.toolCallId === event.toolCallId)
    case 'tool-call-update':
      return ['tool.call.updated', 'tool.call.completed', 'tool.call.failed'].includes(row.eventType)
        && (!event.toolCallId || identity?.toolCallId === event.toolCallId)
    case 'done':
      return row.eventType === 'turn.completed'
    case 'error':
      return row.eventType === 'turn.failed'
    default:
      return false
  }
}

export function isRepresentedByCanonical(
  event: ChatEvent,
  canonicalEvents: readonly CanonicalEventRow[],
  consumed: Set<number>,
): boolean {
  const index = canonicalEvents.findIndex((row, rowIndex) =>
    !consumed.has(rowIndex) && canonicalRepresentsChatEvent(row, event),
  )
  if (index < 0) return false
  consumed.add(index)
  return true
}

export function isRenderedSource(source: string, renderedSource: string | null): boolean {
  return source.length > 0 && renderedSource === source
}

export function messagesRepresentSame(left: Message, right: Message): boolean {
  const leftIdentity = left.externalIdentity
  const rightIdentity = right.externalIdentity
  if (left.role === 'tool' && right.role === 'tool') {
    const leftToolCallId = leftIdentity?.toolCallId
    const rightToolCallId = rightIdentity?.toolCallId
    if (leftToolCallId && rightToolCallId) return leftToolCallId === rightToolCallId
  }
  for (const field of ['messageId', 'eventId', 'turnId'] as const) {
    const leftValue = leftIdentity?.[field]
    const rightValue = rightIdentity?.[field]
    if (leftValue && rightValue && leftValue === rightValue) return true
  }
  if (left.id === right.id) return true
  return left.role === right.role && left.content === right.content
}

export function mergeBase(cached: Message[], live: Message[], preferCanonicalOrder = false): Message[] {
  if (preferCanonicalOrder) {
    const unmatchedLive = [...live]
    const canonical = cached.map(message => {
      const matchedIndex = unmatchedLive.findIndex(candidate => messagesRepresentSame(message, candidate))
      if (matchedIndex >= 0) unmatchedLive.splice(matchedIndex, 1)
      return { ...message, running: false }
    })
    return unmatchedLive.length > 0 ? [...canonical, ...unmatchedLive] : canonical
  }
  const liveIds = new Set(live.map(message => message.id))
  const liveToolKeys = new Set<string>()
  const liveContentKeys = new Set<string>()
  for (const message of live) {
    if (message.role === 'tool') {
      const toolCallId = message.externalIdentity?.toolCallId
      if (toolCallId) liveToolKeys.add(`tool-call:${toolCallId}`)
    } else {
      liveContentKeys.add(`${message.role}:${message.content}`)
    }
  }
  const missing = cached
    .filter(message => {
      if (liveIds.has(message.id)) return false
      if (message.role === 'tool') {
        const toolCallId = message.externalIdentity?.toolCallId
        return toolCallId === undefined || !liveToolKeys.has(`tool-call:${toolCallId}`)
      }
      return !liveContentKeys.has(`${message.role}:${message.content}`)
    })
    .map(message => ({ ...message, running: false }))
  return missing.length > 0 ? [...live, ...missing] : live
}

export function insertMissingMessageAtBasePosition(
  messages: Message[],
  baseMessages: Message[],
  missingMessage: Message,
): Message[] {
  const baseIndex = baseMessages.indexOf(missingMessage)
  if (baseIndex < 0) return [...messages, missingMessage]

  for (let index = baseIndex + 1; index < baseMessages.length; index += 1) {
    const nextAnchor = messages.findIndex(message => messagesRepresentSame(message, baseMessages[index]))
    if (nextAnchor >= 0) {
      const result = [...messages]
      result.splice(nextAnchor, 0, missingMessage)
      return result
    }
  }
  for (let index = baseIndex - 1; index >= 0; index -= 1) {
    const previousAnchor = messages.findIndex(message => messagesRepresentSame(message, baseMessages[index]))
    if (previousAnchor >= 0) {
      const result = [...messages]
      result.splice(previousAnchor + 1, 0, missingMessage)
      return result
    }
  }
  return [...messages, missingMessage]
}
