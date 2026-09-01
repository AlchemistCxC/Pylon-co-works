import { describe, expect, it } from 'vitest'
import type { PersistedSessionLoadResult } from '../../../infrastructure/acp/sessionClient.ts'
import type { CanonicalEventRow } from '../../../infrastructure/events/canonicalEventRepository.ts'
import type { Message } from '../messageTypes.ts'
import {
  ReplayLoadCoordinator,
  ReplayLoadInProgressError,
  type ReplayLoadControllerAdapter,
} from '../chatReplayCoordinator.ts'

const metadata = (complete: boolean, droppedCount = 0): PersistedSessionLoadResult['replayMetadata'] => ({
  complete,
  truncated: !complete && droppedCount > 0,
  droppedCount,
  boundary: {
    kind: 'session-load-response',
    observedCount: droppedCount,
    retainedStartOrdinal: droppedCount > 0 ? droppedCount + 1 : null,
    retainedEndOrdinal: droppedCount > 0 ? droppedCount : null,
  },
})

function result(overrides: Partial<PersistedSessionLoadResult> = {}): PersistedSessionLoadResult {
  return {
    response: { loaded: true },
    replay: [],
    replayMetadata: metadata(true),
    canonicalRevision: 0,
    replayJournalStatus: 'metadata-unavailable',
    authority: 'empty',
    journalCoverage: 'empty',
    collection: { complete: true, truncated: false, droppedCount: 0 },
    diagnostics: [],
    ...overrides,
  }
}

function row(sequence: number, provenance?: CanonicalEventRow['provenance']): CanonicalEventRow {
  return {
    eventId: `owner#${sequence}`,
    owner: { profileId: 'profile', agentId: 'agent', localSessionId: 'source' },
    clientGeneration: 1,
    sequence,
    occurredAt: '2026-09-02T00:00:00.000Z',
    receivedAt: '2026-09-02T00:00:00.000Z',
    eventType: 'user.message',
    payloadVersion: 1,
    typedPayload: { text: `message-${sequence}` },
    rawPayload: {},
    ...(provenance ? { provenance } : {}),
  }
}

function adapter(): ReplayLoadControllerAdapter & {
  calls: string[]
  committed: Message[]
} {
  const calls: string[] = []
  const committed: Message[] = []
  return {
    calls,
    committed,
    beginLoadLock: () => { calls.push('begin'); return calls.filter(call => call === 'begin').length },
    finishLoadLock: () => { calls.push('finish') },
    abortSessionLoad: () => { calls.push('abort') },
    commitReplaySnapshot: () => { calls.push('replay'); return committed },
    commitCanonicalProjection: (_source, _generation, messages) => { calls.push('canonical'); committed.push(...messages); return messages },
    commitPreservedRuntime: () => { calls.push('preserved'); return committed },
    seedCanonicalCursor: () => { calls.push('seed') },
  }
}

const request = (
  loadResult: PersistedSessionLoadResult,
  options: { rows?: CanonicalEventRow[]; current?: () => boolean; cached?: Message[] } = {},
) => ({
  source: 'source',
  ownerKey: '["profile","agent","source"]',
  cached: options.cached,
  load: async () => loadResult,
  loadCanonical: async () => options.rows ?? [],
  projectCanonical: (rows: readonly CanonicalEventRow[]) => rows.map(item => ({
    id: `user-${item.sequence}`, role: 'user', sender: 'source', content: String((item.typedPayload as { text?: unknown }).text), time: '', running: false,
  } as Message)),
  isCurrent: options.current,
})

describe('ReplayLoadCoordinator', () => {
  it('local authoritative rows win over replay and expose canonical outcome', async () => {
    const controller = adapter()
    const coordinator = new ReplayLoadCoordinator(controller)
    const outcome = await coordinator.load(request(result({
      authority: 'local-journal',
      replay: [{ update: 'stale' }],
      replayMetadata: metadata(true),
    }), {
      rows: [row(4, { origin: 'local-observed', trust: 'authoritative' })],
    }))

    expect(outcome).toMatchObject({ authority: 'local-journal', canonicalRevision: 4, commit: 'canonical-projection' })
    expect(controller.calls).toEqual(['begin', 'seed', 'canonical', 'finish'])
  })

  it('uses replay only when metadata is complete and no local journal rows exist', async () => {
    const controller = adapter()
    const coordinator = new ReplayLoadCoordinator(controller)
    const outcome = await coordinator.load(request(result({
      replay: [{ update: 'complete' }],
      replayMetadata: metadata(true),
      authority: 'empty',
    })))

    expect(outcome?.commit).toBe('replay-snapshot')
    expect(outcome?.authority).toBe('remote-fallback')
    expect(controller.calls).toEqual(['begin', 'seed', 'replay', 'finish'])
  })

  it('preserves runtime for truncated replay instead of dropping buffered events', async () => {
    const controller = adapter()
    const coordinator = new ReplayLoadCoordinator(controller)
    const cached: Message[] = [{ id: 'cached', role: 'user', sender: 'source', content: 'keep', time: '' }]
    const outcome = await coordinator.load(request(result({
      replay: [{ update: 'partial' }],
      replayMetadata: metadata(false, 1),
      authority: 'empty',
    }), { cached }))

    expect(outcome).toMatchObject({ authority: 'none', commit: 'preserved-runtime' })
    expect(controller.calls).toEqual(['begin', 'seed', 'preserved', 'finish'])
  })

  it('rejects same-source concurrent loads with a stable machine-readable code', async () => {
    const controller = adapter()
    const coordinator = new ReplayLoadCoordinator(controller)
    let resolveLoad!: (value: PersistedSessionLoadResult) => void
    const first = coordinator.load({
      ...request(result()),
      load: () => new Promise(resolve => { resolveLoad = resolve }),
    })
    await expect(coordinator.load(request(result()))).rejects.toMatchObject({
      code: 'replay_load_in_progress',
    } satisfies Partial<ReplayLoadInProgressError>)
    resolveLoad(result())
    await first
  })

  it('drops stale result without committing it', async () => {
    const controller = adapter()
    const coordinator = new ReplayLoadCoordinator(controller)
    const outcome = await coordinator.load(request(result(), { current: () => false }))
    expect(outcome).toBeNull()
    expect(controller.calls).toEqual(['begin', 'finish'])
    expect(controller.calls).not.toContain('replay')
  })
})
