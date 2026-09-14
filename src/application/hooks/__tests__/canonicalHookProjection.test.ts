/**
 * canonicalHookProjection 测试（API 1.3）：canonical 事件 → 观察锚点映射表、
 * stopReason=cancelled 细分、未 opt-in 会话零派发、会话按 source/id 命中、
 * install 幂等（重复安装只订阅一次 bus）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn(async () => ({ action: 'continue', event: {}, executed: 0, skipped: 0 })))
const subscribeSpy = vi.hoisted(() => vi.fn(() => () => undefined))
const sessionsRef = vi.hoisted(() => ({ current: [] as Array<{ id: string; agentId: string; source: string; hooks: string[] }> }))

vi.mock('../../../identityStore.ts', () => ({
  useIdentityStore: { getState: () => ({ sessions: sessionsRef.current }) },
}))
vi.mock('../../../plugin-runtime/runtimeServices.ts', () => ({
  getHookRuntime: () => ({ invoke: invokeMock }),
  getPluginEventBus: () => ({
    subscribe: subscribeSpy,
  }),
}))
vi.mock('../../../infrastructure/events/pluginEventBus.ts', () => ({
  subscribePluginEvents: (...args: unknown[]) => subscribeSpy(...(args as [])),
  publishPluginEvent: vi.fn(),
}))

import type { CanonicalConversationEvent } from '../../../domains/events/eventSchema'
import { canonicalAnchorFor, installCanonicalHookProjection, projectCanonicalEventToHooks, resetCanonicalHookProjectionForTests } from '../canonicalHookProjection'

function canonicalEvent(eventType: CanonicalConversationEvent['eventType'], typedPayload?: unknown, identity?: { toolCallId?: string }): CanonicalConversationEvent {
  return {
    eventId: '["p","peri","local:a"]#1',
    owner: { profileId: 'p', agentId: 'peri', localSessionId: 'local:a' },
    clientGeneration: 1,
    sequence: 1,
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    eventType,
    payloadVersion: 1,
    ...(identity ? { identity } : {}),
    ...(typedPayload !== undefined ? { typedPayload } : {}),
    rawPayload: {},
  } as CanonicalConversationEvent
}

beforeEach(() => {
  invokeMock.mockClear()
  subscribeSpy.mockClear()
  sessionsRef.current = []
  resetCanonicalHookProjectionForTests()
})

describe('canonicalAnchorFor 映射表', () => {
  it('tool.call.* 与 turn.completed 映射到对应锚点', () => {
    expect(canonicalAnchorFor(canonicalEvent('tool.call.started'))).toBe('tool.started')
    expect(canonicalAnchorFor(canonicalEvent('tool.call.completed'))).toBe('tool.afterCall')
    expect(canonicalAnchorFor(canonicalEvent('tool.call.failed'))).toBe('tool.failed')
    expect(canonicalAnchorFor(canonicalEvent('turn.completed'))).toBe('turn.completed')
  })

  it('turn.failed 默认映射 turn.failed，stopReason=cancelled 细分为 turn.cancelled', () => {
    expect(canonicalAnchorFor(canonicalEvent('turn.failed'))).toBe('turn.failed')
    expect(canonicalAnchorFor(canonicalEvent('turn.failed', { stopReason: 'cancelled' }))).toBe('turn.cancelled')
  })

  it('非投影事件返回 undefined', () => {
    expect(canonicalAnchorFor(canonicalEvent('assistant.text.delta'))).toBeUndefined()
    expect(canonicalAnchorFor(canonicalEvent('user.message'))).toBeUndefined()
  })
})

describe('projectCanonicalEventToHooks 派发', () => {
  it('opt-in 会话按 owner.localSessionId 命中 source 并派发投影事件', () => {
    sessionsRef.current = [{ id: 'a', agentId: 'peri', source: 'local:a', hooks: ['test.hook'] }]
    projectCanonicalEventToHooks(canonicalEvent('tool.call.started', { tool: { name: 'Read' } }, { toolCallId: 'tc-1' }))
    expect(invokeMock).toHaveBeenCalledOnce()
    const [anchor, event, enabled] = invokeMock.mock.calls[0] as unknown as [string, Record<string, unknown>, string[]]
    expect(anchor).toBe('tool.started')
    expect(event).toMatchObject({
      owner: { agentId: 'peri', localSessionId: 'local:a' },
      event: { eventType: 'tool.call.started', toolCallId: 'tc-1', toolTitle: 'Read' },
    })
    expect(enabled).toEqual(['test.hook'])
  })

  it('会话未 opt-in（hooks 空）或不存在时零派发', () => {
    sessionsRef.current = [{ id: 'a', agentId: 'peri', source: 'local:a', hooks: [] }]
    projectCanonicalEventToHooks(canonicalEvent('turn.completed'))
    expect(invokeMock).not.toHaveBeenCalled()

    sessionsRef.current = []
    projectCanonicalEventToHooks(canonicalEvent('turn.completed'))
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('install 幂等：重复安装只订阅一次 bus，重置后可重装', () => {
    sessionsRef.current = [{ id: 'a', agentId: 'peri', source: 'local:a', hooks: ['test.hook'] }]
    const unsubscribe1 = installCanonicalHookProjection()
    const unsubscribe2 = installCanonicalHookProjection()
    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    projectCanonicalEventToHooks(canonicalEvent('turn.completed'))
    expect(invokeMock).toHaveBeenCalledOnce()
    unsubscribe1()
    unsubscribe2()
    // 解订后须显式 reset 才重装（installation 引用同一 disposable）。
    resetCanonicalHookProjectionForTests()
    installCanonicalHookProjection()
    expect(subscribeSpy).toHaveBeenCalledTimes(2)
  })
})
