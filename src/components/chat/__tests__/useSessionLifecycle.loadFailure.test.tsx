// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  let lockGeneration = 0
  const controller = {
    initSource: vi.fn((_source: string, cached: unknown[]) => cached),
    getStreamingState: vi.fn(() => ({ text: '', thinking: '' })),
    getSummary: vi.fn(() => null),
    getGenerationPhase: vi.fn(() => undefined),
    getLastActivityAt: vi.fn(() => undefined),
    beginLoadLock: vi.fn(() => ++lockGeneration),
    finishLoadLock: vi.fn(),
    abortSessionLoad: vi.fn(),
    commitReplaySnapshot: vi.fn(() => []),
    commitCanonicalProjection: vi.fn((_source: string, _generation: number, messages: unknown[]) => messages),
    clearReplay: vi.fn(),
    pruneSources: vi.fn(),
  }
  return {
    controller,
    invoke: vi.fn(),
    reportRuntimeError: vi.fn(),
    resetGeneration: () => { lockGeneration = 0 },
  }
})

vi.mock('../../../infrastructure/tauri/env', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../../infrastructure/events/canonicalEventRepository', () => ({
  tauriCanonicalEventRepository: () => ({ loadAll: vi.fn(async () => []) }),
}))
vi.mock('../chatEventController', () => ({
  attachChatEventController: () => mocks.controller,
  bindChatControllerRefs: vi.fn(),
  getChatController: () => null,
  registerChatController: vi.fn(),
}))
vi.mock('../hookRuntime', () => ({ runSessionBoundaryHook: vi.fn(async () => {}) }))
vi.mock('../../../plugin-runtime/runtimeServices.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../plugin-runtime/runtimeServices.ts')>(),
  getHookRuntime: () => ({ invoke: vi.fn(async () => {}) }),
}))
vi.mock('../../../plugins/core/sessionCreation/sessionPreflight.ts', () => ({
  runSessionPreflight: vi.fn(async () => ({ effects: [], diagnostics: [], mcpServers: [] })),
}))
vi.mock('../../../plugins/core/sessionCreation/builtinSessionCreation.ts', () => ({
  collectProfilePersona: () => '',
}))
vi.mock('../../../runtimeError', () => ({ reportRuntimeError: mocks.reportRuntimeError }))

import { useSessionLifecycle, type ChatSessionSetters } from '../useSessionLifecycle'
import { useIdentityStore, type Session } from '../../../identityStore'
import { useRuntimeStore } from '../../../runtimeStore'

const SESSION: Session = {
  id: 'local-record-1',
  profileId: 'profile-a',
  agentId: 'peri',
  source: 'local:session-1',
  periId: 'remote-original',
  name: 'session',
  createdAt: 1,
  lastActiveAt: 1,
  platform: 'local',
  workdir: '.',
  sessionPrompt: '',
  skills: [],
  hooks: [],
  autoName: '',
}

function setters(): ChatSessionSetters {
  return {
    setMessages: vi.fn(),
    setStreamingText: vi.fn(),
    setStreamingThinking: vi.fn(),
    setGenerating: vi.fn(),
    setGenerationPhase: vi.fn(),
    setSummary: vi.fn(),
    setLastTokenAt: vi.fn(),
  }
}

describe('session/load failure policy (D5)', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.controller.abortSessionLoad.mockClear()
    mocks.controller.finishLoadLock.mockClear()
    mocks.controller.beginLoadLock.mockClear()
    mocks.reportRuntimeError.mockClear()
    mocks.resetGeneration()
    useRuntimeStore.setState({ sessionReloadTokens: {}, bindingGenerations: {} })
    useIdentityStore.setState({
      sessions: [{ ...SESSION }],
      profiles: [{ id: 'profile-a', name: 'P', persona: '', model: '' }],
      sessionsHydrated: true,
      sessionHydration: { kind: 'ready' },
    })
  })

  it('失败不自动 new_session；retry 与 fork 必须由用户分别触发', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_persisted_session') throw new Error('remote context missing')
      if (command === 'new_session') return { sessionId: 'remote-fork' }
      return null
    })
    const selectSession = vi.fn()
    const view = renderHook(
      ({ sessionId, sessions }: { sessionId: string; sessions: Session[] }) => useSessionLifecycle(sessionId, sessions, setters(), selectSession),
      { initialProps: { sessionId: SESSION.id, sessions: [SESSION] } },
    )
    const { result } = view

    await waitFor(() => expect(result.current.recoveryFailure?.message).toBe('remote context missing'))
    expect(mocks.invoke.mock.calls.filter(call => call[0] === 'new_session')).toHaveLength(0)
    expect(useIdentityStore.getState().sessions[0]?.periId).toBe('remote-original')
    expect(mocks.controller.abortSessionLoad).toHaveBeenCalledTimes(1)

    act(() => result.current.retryRecovery())
    await waitFor(() => {
      expect(mocks.invoke.mock.calls.filter(call => call[0] === 'load_persisted_session')).toHaveLength(2)
    })
    expect(mocks.invoke.mock.calls.filter(call => call[0] === 'new_session')).toHaveLength(0)

    await waitFor(() => expect(result.current.recoveryFailure).not.toBeNull())
    act(() => result.current.createFork())
    const fork = useIdentityStore.getState().sessions.find(session => session.id !== SESSION.id)!
    expect(fork).toBeDefined()
    expect(fork.source).not.toBe(SESSION.source)
    expect(fork.periId).toBeUndefined()
    expect(useIdentityStore.getState().sessions.find(session => session.id === SESSION.id)?.periId).toBe('remote-original')
    expect(selectSession).toHaveBeenCalledWith(fork.id)

    view.rerender({ sessionId: fork.id, sessions: useIdentityStore.getState().sessions })
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(call => call[0] === 'new_session')).toHaveLength(1))
    await waitFor(() => expect(useIdentityStore.getState().sessions.find(session => session.id === fork.id)?.periId).toBe('remote-fork'))
    expect(useIdentityStore.getState().sessions.find(session => session.id === SESSION.id)?.periId).toBe('remote-original')
  })

  it('截断 replay 的完整性 metadata 穿透到 UI state', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'load_persisted_session') return {
        response: { loaded: true },
        replay: [{ update: 2 }, { update: 3 }],
        replayMetadata: {
          complete: false,
          truncated: true,
          droppedCount: 1,
          boundary: {
            kind: 'session-load-response',
            observedCount: 3,
            retainedStartOrdinal: 2,
            retainedEndOrdinal: 3,
          },
        },
      }
      return null
    })

    const { result } = renderHook(() => useSessionLifecycle(SESSION.id, [SESSION], setters(), vi.fn()))

    await waitFor(() => expect(result.current.replayIntegrity?.metadata).toMatchObject({
      complete: false,
      truncated: true,
      droppedCount: 1,
      boundary: { observedCount: 3, retainedStartOrdinal: 2, retainedEndOrdinal: 3 },
    }))
    expect(mocks.controller.commitReplaySnapshot).not.toHaveBeenCalled()
    expect(result.current.recoveryFailure).toBeNull()
    expect(result.current.canonicalRefresh).toMatchObject({ sessionId: SESSION.id })
  })
})
