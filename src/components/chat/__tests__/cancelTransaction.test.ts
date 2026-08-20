// @vitest-environment jsdom
/**
 * 行为化承接 scripts/test-cancel-transaction-wiring.mts：
 * requestCancel → begin-cancel → cancel_prompt invoke → resolve 收敛 cancel-success、
 * reject 收敛 cancel-rejected。原守卫断言源码 token（requestCancel 走 typed client、
 * begin-cancel 去重、cancel-success/rejected 收敛），这里 mock invoke 验证真实事务。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
const listeners = new Map<string, (payload: unknown) => void>()
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }))
    return Promise.resolve(() => { listeners.delete(event) })
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
import { attachChatEventController } from '../chatEventController'
import { useIdentityStore } from '../../../identityStore'
import type { ChatEventControllerRefs } from '../chatEventController'
import type { Session } from '../../../identityStore'

async function waitListeners(): Promise<void> { await new Promise(r => setTimeout(r, 100)) }
function makeRefs(): ChatEventControllerRefs {
  return { sessionRef: { current: null }, messageOwnerRef: { current: null }, setMessages: () => {}, setStreamingText: () => {}, setStreamingThinking: () => {}, setGenerating: () => {}, setGenerationPhase: () => {}, setSummary: () => {}, setLastTokenAt: () => {} }
}
function makeSession(id: string, source: string): Session {
  return { id, agentId: 'peri', source, name: 's', profileId: 'p1', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
}

beforeEach(() => {
  listeners.clear()
  invokeMock.mockReset()
  useIdentityStore.setState({ sessions: [], sessionsHydrated: true })
  localStorage.clear()
})

describe('取消事务（cancel-transaction 契约）', () => {
  it('非生成态 requestCancel 不调用后端（begin-cancel 去重）', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    handle.initSource(A, [])
    handle.requestCancel(A)

    // 无 generating → begin-cancel 不进入 canceling → 不 invoke
    expect(invokeMock).not.toHaveBeenCalled()
    handle.dispose()
  })

  it('生成态 requestCancel → cancel_prompt invoke → resolve 收敛', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    handle.initSource(A, [])
    // 乐观发送 → generating=true（begin-cancel 才可进入 canceling）
    handle.sendOptimisticUser(A, '问', 'cid-1')

    invokeMock.mockResolvedValueOnce({ status: 'ok' })
    handle.requestCancel(A)

    // cancel_prompt 被调用（typed client 命令名）
    const cancelCall = invokeMock.mock.calls.find(call => call[0] === 'cancel_prompt')
    expect(cancelCall).toBeTruthy()
    expect(cancelCall![1]).toEqual({ agentId: 'peri', source: A })

    // resolve 后 cancel-success 收敛（等待 invoke promise 链）
    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalled()
    })
    handle.dispose()
  })

  it('生成态 requestCancel → reject 走 reportRuntimeError 不吞错', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const reportSpy = vi.spyOn(await import('../../../runtimeError'), 'reportRuntimeError').mockImplementation(() => ({} as never))
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    handle.initSource(A, [])
    handle.sendOptimisticUser(A, '问', 'cid-1')

    invokeMock.mockRejectedValueOnce(new Error('cancel denied'))
    handle.requestCancel(A)

    const cancelCall = invokeMock.mock.calls.find(call => call[0] === 'cancel_prompt')
    expect(cancelCall).toBeTruthy()
    await vi.waitFor(() => {
      expect(reportSpy).toHaveBeenCalled()
    })
    reportSpy.mockRestore()
    handle.dispose()
  })
})
