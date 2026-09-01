import { beforeEach, describe, expect, it } from 'vitest'
import type { PersistedSessionLoadResult } from '../../../infrastructure/acp/sessionClient.ts'
import {
  CHAT_REPLAY_TRACE_CONTRACT,
  CHAT_REPLAY_TRACE_FLAG,
  CHAT_REPLAY_TRACE_KEY,
  readChatReplayTrace,
  recordChatReplayTrace,
  replayErrorCode,
} from '../chatReplayTrace.ts'
import {
  ReplayLoadCoordinator,
  ReplayLoadInProgressError,
  type ReplayLoadControllerAdapter,
} from '../chatReplayCoordinator.ts'

function metadata(complete: boolean, droppedCount = 0): PersistedSessionLoadResult['replayMetadata'] {
  const observedCount = droppedCount + (complete ? 2 : 1)
  return {
    complete,
    truncated: !complete,
    droppedCount,
    boundary: {
      kind: 'session-load-response',
      observedCount,
      retainedStartOrdinal: observedCount === 0 ? null : droppedCount + 1,
      retainedEndOrdinal: observedCount === 0 ? null : observedCount,
    },
  }
}

function loadResult(replayMetadata: PersistedSessionLoadResult['replayMetadata']): PersistedSessionLoadResult {
  return {
    response: { loaded: true },
    replay: replayMetadata.complete ? [{ update: 'one' }, { update: 'two' }] : [{ update: 'partial' }],
    replayMetadata,
    canonicalRevision: 0,
    replayJournalStatus: 'incomplete-not-imported',
    authority: 'empty',
    journalCoverage: 'empty',
    collection: { complete: replayMetadata.complete, truncated: replayMetadata.truncated, droppedCount: replayMetadata.droppedCount },
    diagnostics: [],
  }
}

function adapter(): ReplayLoadControllerAdapter {
  return {
    beginLoadLock: () => 1,
    finishLoadLock: () => {},
    abortSessionLoad: () => {},
    commitCanonicalProjection: (_source, _generation, messages) => messages,
    commitReplaySnapshot: (_source, _generation, replay) => replay.map((_, index) => ({ id: `m-${index}`, role: 'assistant', sender: 'agent', content: 'replay', time: '' })),
    commitPreservedRuntime: () => [],
  }
}

describe('A/B replay metadata and commit contract', () => {
  beforeEach(() => localStorage.clear())

  it('uses the backend field names to pair transport and projection traces', () => {
    localStorage.setItem(CHAT_REPLAY_TRACE_FLAG, '1')
    recordChatReplayTrace({
      kind: 'load-commit',
      contract: CHAT_REPLAY_TRACE_CONTRACT,
      owner: '["profile","agent","local-session"]',
      loadGeneration: 7,
      captureLp: 'active-replay-registry',
      responseBoundary: 'session-load-response',
      observedCount: 2,
      retainedCount: 2,
      droppedCount: 0,
      authority: 'remote-fallback',
      canonicalRevision: 0,
      commitOutcome: 'replay-snapshot',
    })

    expect(readChatReplayTrace()).toEqual([
      expect.objectContaining({
        contract: 'C0-v1.0-20260902',
        owner: '["profile","agent","local-session"]',
        loadGeneration: 7,
        captureLp: 'active-replay-registry',
        responseBoundary: 'session-load-response',
        observedCount: 2,
        retainedCount: 2,
        droppedCount: 0,
        authority: 'remote-fallback',
        canonicalRevision: 0,
        commitOutcome: 'replay-snapshot',
      }),
    ])
  })

  it('keeps a complete response boundary distinct from truncated preservation', async () => {
    const complete = await new ReplayLoadCoordinator(adapter()).load({
      source: 'local:session', ownerKey: '["profile","agent","local-session"]',
      load: async () => loadResult(metadata(true)), loadCanonical: async () => [], projectCanonical: () => [],
    })
    expect(complete?.replayMetadata).toMatchObject({ complete: true, truncated: false, boundary: { kind: 'session-load-response' } })
    expect(complete?.commit).toBe('replay-snapshot')

    const partial = await new ReplayLoadCoordinator(adapter()).load({
      source: 'local:partial', ownerKey: '["profile","agent","local-partial"]',
      load: async () => loadResult(metadata(false, 2)), loadCanonical: async () => [], projectCanonical: () => [],
    })
    expect(partial?.replayMetadata).toMatchObject({ complete: false, truncated: true, droppedCount: 2 })
    expect(partial?.commit).toBe('preserved-runtime')
  })

  it('keeps stable machine codes across coordinator and trace failures', () => {
    expect(new ReplayLoadInProgressError('local:session').code).toBe('replay_load_in_progress')
    expect(replayErrorCode({ code: 'rpc_error', message: 'provider text' })).toBe('rpc_error')
    expect(replayErrorCode({ message: 'provider text' })).toBe('replay_load_failed')
    expect(localStorage.getItem(CHAT_REPLAY_TRACE_KEY)).toBeNull()
  })
})
