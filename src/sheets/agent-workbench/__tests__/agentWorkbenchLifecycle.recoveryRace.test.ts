// @vitest-environment jsdom
/**
 * #110 F1：冷启动恢复竞态——恢复请求必须等 owner runtime 就绪。
 *
 * 现场（2026-09-16/17 三次冷启动 3/3 命中）：`恢复会话失败` 比 hermes ACP
 * `connected` 早 ~2.4s，恢复必然失败并留下错误条；叠加 F4 即 #56 的完整现场。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../../../identityStore.ts'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state: {
    agentStatuses: Record<string, unknown>
    setBindingGeneration: ReturnType<typeof vi.fn>
    bumpSessionReload: ReturnType<typeof vi.fn>
  } = {
    agentStatuses: {},
    setBindingGeneration: vi.fn(),
    bumpSessionReload: vi.fn(),
  }
  return {
    state,
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    listenerCount: () => listeners.size,
    setStatus(agentId: string, status: unknown) {
      state.agentStatuses = { ...state.agentStatuses, [agentId]: status }
      for (const listener of [...listeners]) listener()
    },
    reset() {
      state.agentStatuses = {}
      listeners.clear()
    },
  }
})

const mocks = vi.hoisted(() => ({
  reportError: vi.fn(),
  reportDiagnostic: vi.fn(),
  resolveErrors: vi.fn(),
  applyResponse: vi.fn(),
  hookInvoke: vi.fn(),
  boundary: vi.fn(),
  setSessionPeriId: vi.fn(),
}))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeRef.current!(cmd, args),
}))
vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, isBrowserMockRuntime: () => false }))
vi.mock('../../../runtimeStore.ts', () => ({
  useRuntimeStore: { getState: store.getState, subscribe: store.subscribe },
}))
vi.mock('../../../runtimeError.ts', () => ({
  reportRuntimeError: mocks.reportError,
  reportRuntimeDiagnostic: mocks.reportDiagnostic,
  resolveRuntimeErrors: mocks.resolveErrors,
}))
vi.mock('../../../domains/sessionState/sessionStateSync.ts', () => ({
  applySessionStateResponse: mocks.applyResponse,
}))
vi.mock('../../../plugin-runtime/runtimeServices.ts', () => ({
  getHookRuntime: () => ({ invoke: mocks.hookInvoke }),
  getPluginServiceRegistry: () => ({
    list: () => [],
    register: vi.fn(),
    unregister: vi.fn(),
  }),
}))
vi.mock('../../../infrastructure/events/canonicalEventFeed.ts', () => ({
  getCanonicalEventFeed: () => ({ seed: vi.fn(), discard: vi.fn() }),
}))
vi.mock('../../../application/transactions/sessionHookTransactions.ts', () => ({
  runSessionBoundaryHook: mocks.boundary,
}))
vi.mock('../../../components/chat/chatReplayTrace.ts', () => ({
  CHAT_REPLAY_TRACE_CONTRACT: 'contract',
  recordChatReplayTrace: vi.fn(),
  replayErrorCode: () => 'replay-error',
  safeContentEvidence: () => ({}),
}))
vi.mock('../../../identityStore.ts', () => ({
  useIdentityStore: {
    getState: () => ({
      profiles: [{ id: 'profile', name: 'profile', persona: 'persona', model: 'profile-model' }],
      sessions: [session],
      setSessionPeriId: mocks.setSessionPeriId,
    }),
  },
}))

const session: Session = {
  id: 'local-id', agentId: 'owner', profileId: 'profile', source: 'local:source',
  name: 'title', createdAt: 1, lastActiveAt: 1, platform: 'local',
  workdir: '', workspaceId: '', sessionPrompt: '', skills: [], hooks: [], autoName: '',
  periId: 'peri-1',
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

let calls: string[]
let loadResults: Array<() => Promise<unknown>>

function makeInvoke(): Invoke {
  return async (cmd) => {
    calls.push(cmd)
    if (cmd === 'evt_load_compact') return []
    if (cmd === 'evt_revision') return 0
    if (cmd === 'load_persisted_session') {
      const next = loadResults.shift()
      if (!next) throw new Error('unexpected load_persisted_session')
      return next()
    }
    return undefined
  }
}

const validLoadResult = () => Promise.resolve({
  response: { sessionId: 'peri-1', configOptions: [] },
  replay: [],
  replayMetadata: {
    complete: true,
    truncated: false,
    droppedCount: 0,
    boundary: { kind: 'session-load-response', observedCount: 0, retainedStartOrdinal: null, retainedEndOrdinal: null },
  },
  canonicalRevision: 0,
  replayJournalStatus: 'local-authoritative',
  authority: 'local-journal',
  journalCoverage: 'local-observed',
  collection: { complete: true, truncated: false, droppedCount: 0 },
  diagnostics: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  store.reset()
  calls = []
  loadResults = []
  invokeRef.current = makeInvoke()
  mocks.hookInvoke.mockResolvedValue({ action: 'continue', event: {} })
})

async function importLifecycle() {
  const module = await import('../agentWorkbenchLifecycle.ts')
  return module
}

/** 让已排程的微任务/宏任务跑完（不依赖 fake timers）。 */
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }

describe('#110 F1 恢复等待 owner runtime 就绪', () => {
  it('runtime 未就绪时恢复排队；就绪后即发出恢复请求（不等固定时长）', async () => {
    store.setStatus('owner', { status: 'disconnected' })
    loadResults.push(validLoadResult)
    const { AgentWorkbenchLifecycle } = await importLifecycle()

    const pending = new AgentWorkbenchLifecycle().activate(session, { isCurrent: () => true })
    await flush()
    expect(calls).not.toContain('load_persisted_session')
    expect(store.listenerCount()).toBe(1)

    store.setStatus('owner', { status: 'connected' })
    await pending
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(1)
    expect(store.listenerCount()).toBe(0)
    expect(mocks.reportError).not.toHaveBeenCalled()
  })

  it('已就绪时立即恢复，不订阅也不等待', async () => {
    store.setStatus('owner', { status: 'connected' })
    loadResults.push(validLoadResult)
    const { AgentWorkbenchLifecycle } = await importLifecycle()

    await new AgentWorkbenchLifecycle().activate(session, { isCurrent: () => true })
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(1)
    expect(store.listenerCount()).toBe(0)
  })

  it('状态未知（无 status 字段）不阻塞——不把「还不知道」当成「未就绪」', async () => {
    store.setStatus('owner', { generation: 7 })
    loadResults.push(validLoadResult)
    const { AgentWorkbenchLifecycle } = await importLifecycle()

    await new AgentWorkbenchLifecycle().activate(session, { isCurrent: () => true })
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(1)
  })

  it('会话切换（isCurrent 转假）时放弃等待，不发恢复请求也不报错', async () => {
    store.setStatus('owner', { status: 'disconnected' })
    const { AgentWorkbenchLifecycle } = await importLifecycle()
    let current = true
    const pending = new AgentWorkbenchLifecycle().activate(session, { isCurrent: () => current })
    await flush()
    expect(calls).not.toContain('load_persisted_session')

    current = false
    store.setStatus('owner', { status: 'disconnected' })
    await expect(pending).resolves.toBeUndefined()
    expect(calls).not.toContain('load_persisted_session')
    expect(mocks.reportError).not.toHaveBeenCalled()
  })

  it('首败保留错误条并单次退避重试；重试成功即清错误，且不再排第三次', async () => {
    vi.useFakeTimers()
    store.setStatus('owner', { status: 'connected' })
    loadResults.push(() => Promise.reject(new Error('restore failed')))
    loadResults.push(validLoadResult)
    const { AgentWorkbenchLifecycle, RECOVERY_RETRY_DELAY_MS } = await importLifecycle()

    await new AgentWorkbenchLifecycle().activate(session, { isCurrent: () => true })
    expect(mocks.reportError).toHaveBeenCalledTimes(1)
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_DELAY_MS)
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(2)
    expect(mocks.resolveErrors).toHaveBeenCalled()

    // 重试额度已耗尽：再推进时间不再有新请求（停为手动重试）。
    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_DELAY_MS * 5)
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(2)
  })

  it('重试失败后不再排新重试（上限 1 次，避免无限重放）', async () => {
    vi.useFakeTimers()
    store.setStatus('owner', { status: 'connected' })
    loadResults.push(() => Promise.reject(new Error('first')))
    loadResults.push(() => Promise.reject(new Error('second')))
    const { AgentWorkbenchLifecycle, RECOVERY_RETRY_DELAY_MS } = await importLifecycle()

    await new AgentWorkbenchLifecycle().activate(session, { isCurrent: () => true })
    expect(mocks.reportError).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_DELAY_MS)
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(2)
    expect(mocks.reportError).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_DELAY_MS * 5)
    expect(calls.filter(cmd => cmd === 'load_persisted_session')).toHaveLength(2)
  })
})
