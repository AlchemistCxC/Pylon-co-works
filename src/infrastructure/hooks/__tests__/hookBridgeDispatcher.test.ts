// @vitest-environment jsdom
/**
 * P55-D1：kernel hook bridge dispatcher 单元契约。
 * 锁定：fail-closed（会话不存在 / hooks 空 / 未知锚点 → 不进 HookRuntime、
 * 回 continue 原样放行）；opt-in 会话进 HookRuntime 并回程 transform 产物；
 * cancel → abort 联动；安装时 registry sync + ready 握手。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }))
    return Promise.resolve(() => { listeners.delete(event) })
  }),
}))
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn((..._args: unknown[]) => Promise.resolve({})) }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class { id = 0; onmessage = () => {} },
}))
vi.mock('../../tauri/env.ts', () => ({ IS_TAURI: true }))

const { hookRuntimeMock } = vi.hoisted(() => {
  const handlerLog: Array<{ hookName: string; event: unknown }> = []
  return { hookRuntimeMock: { handlerLog } }
})
vi.mock('../../../plugin-runtime/runtimeServices.ts', () => ({
  getHookRuntime: () => ({
    registry: {
      getSnapshot: () => ({ entries: [{ value: { hookName: 'message.user.beforeSend' } }] }),
      subscribe: () => () => undefined,
    },
    invoke: vi.fn(async (hookName: string, event: unknown, _enabled: readonly string[], _signal: AbortSignal) => {
      hookRuntimeMock.handlerLog.push({ hookName, event })
      return { action: 'continue', event: { ...(event as Record<string, unknown>), transformed: true }, executed: 1, skipped: 0 }
    }),
  }),
}))

import { useIdentityStore, type Session } from '../../../identityStore.ts'
import { installPylonHookBridge } from '../hookBridgeDispatcher.ts'

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    agentId: 'agent-a',
    name: 's',
    source: 'local:session-1',
    profileId: 'profile-1',
    createdAt: 1,
    lastActiveAt: 1,
    platform: 'local',
    workdir: '.',
    sessionPrompt: '',
    skills: [],
    hooks: [],
    autoName: '',
    ...overrides,
  } as Session
}

function hookRequest(overrides: Partial<{ requestId: string; hook: string; sessionId: string }> = {}) {
  return {
    requestId: 'hook-1-1',
    hook: 'message.user.beforeSend',
    sessionId: 'session-1',
    payload: { source: 'local:session-1', content: 'x', blocks: [] },
    timeoutMs: 3000,
    ...overrides,
  }
}

function respondCalls(): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter(args => args[0] === 'pylon_hook_respond')
    .map(args => args[1] as Record<string, unknown>)
}

let dispose: (() => void) | undefined

beforeEach(() => {
  listeners.clear()
  invokeMock.mockReset()
  invokeMock.mockResolvedValue({})
  hookRuntimeMock.handlerLog.length = 0
})

afterEach(async () => {
  dispose?.()
  dispose = undefined
})

describe('hookBridgeDispatcher（P55-D1）', () => {
  it('安装即 registry sync + ready 握手', async () => {
    dispose = await installPylonHookBridge()
    const commands = invokeMock.mock.calls.map(args => args[0])
    expect(commands).toContain('hook_registry_sync')
    expect(commands).toContain('pylon_hook_ready')
  })

  it('fail-closed：会话不存在 → 不进 HookRuntime，回 continue 原样放行', async () => {
    useIdentityStore.setState({ sessions: [] })
    dispose = await installPylonHookBridge()
    const request = hookRequest({ sessionId: 'missing-session' })
    listeners.get('pylon:hook-request')?.(request)
    await vi.waitFor(() => expect(respondCalls()).toHaveLength(1))
    expect(hookRuntimeMock.handlerLog).toHaveLength(0)
    expect(respondCalls()[0]).toMatchObject({
      requestId: 'hook-1-1',
      result: { action: 'continue', event: request.payload, executed: 0, skipped: 0 },
    })
  })

  it('fail-closed：session.hooks 为空 → 不进 HookRuntime（kernel 域显式 opt-in）', async () => {
    useIdentityStore.setState({ sessions: [makeSession({ hooks: [] })] })
    dispose = await installPylonHookBridge()
    listeners.get('pylon:hook-request')?.(hookRequest())
    await vi.waitFor(() => expect(respondCalls()).toHaveLength(1))
    expect(hookRuntimeMock.handlerLog).toHaveLength(0)
    expect(respondCalls()[0]).toMatchObject({
      result: { action: 'continue', executed: 0, skipped: 0 },
    })
  })

  it('fail-closed：锚点名不在词表 → 不进 HookRuntime', async () => {
    useIdentityStore.setState({ sessions: [makeSession({ hooks: ['p.kernel'] })] })
    dispose = await installPylonHookBridge()
    listeners.get('pylon:hook-request')?.(hookRequest({ hook: 'agent.chunk' }))
    await vi.waitFor(() => expect(respondCalls()).toHaveLength(1))
    expect(hookRuntimeMock.handlerLog).toHaveLength(0)
    expect(respondCalls()[0]).toMatchObject({ result: { action: 'continue' } })
  })

  it('opt-in 会话：进 HookRuntime，transform 产物随应答回程', async () => {
    useIdentityStore.setState({ sessions: [makeSession({ hooks: ['p.kernel'] })] })
    dispose = await installPylonHookBridge()
    listeners.get('pylon:hook-request')?.(hookRequest())
    await vi.waitFor(() => expect(respondCalls()).toHaveLength(1))
    expect(hookRuntimeMock.handlerLog).toHaveLength(1)
    expect(hookRuntimeMock.handlerLog[0]?.hookName).toBe('message.user.beforeSend')
    expect(respondCalls()[0]).toMatchObject({
      requestId: 'hook-1-1',
      result: { action: 'continue', event: { transformed: true }, executed: 1, skipped: 0 },
    })
  })

  it('会话按 source 命中（平台入站 sessionId 是 source 形态）', async () => {
    useIdentityStore.setState({ sessions: [makeSession({ hooks: ['p.kernel'] })] })
    dispose = await installPylonHookBridge()
    listeners.get('pylon:hook-request')?.(hookRequest({ hook: 'message.received', sessionId: 'local:session-1' }))
    await vi.waitFor(() => expect(respondCalls()).toHaveLength(1))
    expect(hookRuntimeMock.handlerLog).toHaveLength(1)
    expect(hookRuntimeMock.handlerLog[0]?.hookName).toBe('message.received')
  })
})
