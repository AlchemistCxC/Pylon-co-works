// @vitest-environment jsdom
/**
 * A1-c P2 canonical 双写（P52 D4 改造）：kernel-committed 帧不二次落盘与
 * gap 回填契约的 controller 消亡后宿主。
 *
 * 历史形态（controller 驱动的 WebView 自写轨：live user/chunk/tool/done 进
 * sink、乐观去重、prune discard、flush 委托）随 chatEventController 退役：
 * 自写轨已无生产 caller（后端 user echo/update 均 kernel-committed-first），
 * 其 sink 面契约由 canonicalEventFeed.test 承载。此处保留两项核心行为：
 * ①kernel-committed 帧经 feed 只投影不 offer（B7 双轨互斥）；
 * ②sequence 缺口经 evt_list 回填后当前行照常投影。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn((..._args: unknown[]) => Promise.resolve({})) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class { id = 0; onmessage = () => {} },
}))

import { setCanonicalEventSinkFactoryForTests, getCanonicalEventFeed } from '../../../infrastructure/events/canonicalEventFeed.ts'
import type { CanonicalEventSink } from '../../../infrastructure/events/canonicalEventSink'
import { subscribePluginEvents, clearPluginEventListenersForTests } from '../../../infrastructure/events/pluginEventBus.ts'

interface FakeSink extends CanonicalEventSink {
  offers: Array<{ raw: unknown; force: boolean }>
  discarded: string[]
}

function makeFakeSink(): FakeSink {
  const offers: Array<{ raw: unknown; force: boolean }> = []
  const discarded: string[] = []
  return {
    offers,
    discarded,
    offer(_context, raw, force = false) { offers.push({ raw, force }) },
    flushAll: vi.fn(),
    flushAllAsync: async () => {},
    discard(ownerKey) { discarded.push(ownerKey) },
    dispose: vi.fn(),
  }
}

const sink = makeFakeSink()
const SOURCE = 'local:kernel-committed'

function canonicalEvent(sequence: number, eventType: string, rawPayload: unknown) {
  return {
    eventId: `["p1","peri","${SOURCE}"]#${sequence}`,
    profileId: 'p1',
    agentId: 'peri',
    localSessionId: SOURCE,
    remoteSessionId: 'remote-1',
    clientGeneration: 2,
    sequence,
    occurredAt: '2026-08-20T00:00:00.000Z',
    receivedAt: '2026-08-20T00:00:00.000Z',
    eventType,
    payloadVersion: 1,
    rawPayload,
    createdAt: 1,
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue({})
  sink.offers.length = 0
  sink.discarded.length = 0
  clearPluginEventListenersForTests()
  setCanonicalEventSinkFactoryForTests(() => sink)
})

afterEach(() => {
  setCanonicalEventSinkFactoryForTests(null)
  clearPluginEventListenersForTests()
})

describe('canonical 双写（A1-c P2，P52 D4 feed 宿主）', () => {
  it('Kernel committed user/update/done/error 只投影发布，不再由 WebView 二次落盘', async () => {
    const feed = getCanonicalEventFeed()
    const published: string[] = []
    subscribePluginEvents(event => { published.push((event as { eventType: string }).eventType) })

    const userRaw = { source: SOURCE, update: { sessionUpdate: 'user_message_chunk', content: { text: 'question' } } }
    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'question', canonicalEvent: canonicalEvent(1, 'user.message', userRaw) } })
    const raw = { source: SOURCE, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'durable' } } }
    await feed.acceptFrame({ event: 'pylon:update', payload: {
      ...raw,
      canonicalEvent: { ...canonicalEvent(2, 'assistant.text.delta', raw), typedPayload: { text: 'durable' } },
    } })
    const doneRaw = { source: SOURCE, update: { sessionUpdate: 'done' } }
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: SOURCE, canonicalEvent: canonicalEvent(3, 'turn.completed', doneRaw) } })
    const errorRaw = { source: SOURCE, update: { sessionUpdate: 'error', errorCode: 'protocol_error', error: 'boom' } }
    await feed.acceptFrame({ event: 'pylon:error', payload: { source: SOURCE, error: 'boom', code: 'protocol_error', canonicalEvent: canonicalEvent(4, 'turn.failed', errorRaw) } })

    expect(published).toEqual(['user.message', 'assistant.text.delta', 'turn.completed', 'turn.failed'])
    expect(sink.offers).toHaveLength(0)
  })

  it('Kernel committed sequence 出现缺口时从同一 journal 补读后再处理当前事件', async () => {
    const feed = getCanonicalEventFeed()
    const chunkRaw = { source: SOURCE, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'recovered' } } }
    const missing = canonicalEvent(2, 'assistant.text.delta', chunkRaw)
    const current = canonicalEvent(3, 'turn.completed', { source: SOURCE, update: { sessionUpdate: 'done' } })
    invokeMock.mockResolvedValueOnce({ events: [missing, current], nextBeforeSequence: 2 })

    const userEvent = {
      ...canonicalEvent(1, 'user.message', { source: SOURCE, update: { sessionUpdate: 'user_message_chunk', content: { text: 'question' } } }),
      typedPayload: { text: 'question' },
    }
    await feed.acceptFrame({ event: 'pylon:user', payload: { source: SOURCE, content: 'question', canonicalEvent: userEvent } })
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: SOURCE, canonicalEvent: current } })

    expect(invokeMock).toHaveBeenCalledWith('evt_list', { ownerKey: `["p1","peri","${SOURCE}"]`, beforeSequence: 4, limit: 2 })
    expect(sink.offers).toHaveLength(0)
  })
})
