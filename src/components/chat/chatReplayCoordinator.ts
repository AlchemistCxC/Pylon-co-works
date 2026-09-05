import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import type { PersistedSessionLoadResult, ReplayMetadata } from '../../infrastructure/acp/sessionClient.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal, type CanonicalTurnDuration } from '../../domains/events/canonicalTurnDuration.ts'
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
  /** Durable turn timing used when the process-local generation clock is gone. */
  readonly canonicalDuration?: CanonicalTurnDuration
  /** A terminal row may exist even when its timestamps are malformed. */
  readonly hasCanonicalTurnTerminal?: boolean
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
      const canonicalDuration = deriveCanonicalTurnDuration(projectionRows.length > 0 ? projectionRows : canonicalRows)
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
        ...(canonicalDuration ? { canonicalDuration } : {}),
        hasCanonicalTurnTerminal: hasCanonicalTurnTerminal(projectionRows.length > 0 ? projectionRows : canonicalRows),
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
