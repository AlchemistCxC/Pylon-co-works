// @vitest-environment jsdom
/**
 * A1-c P2：chatEventController canonical 双写回归。
 * 锁定：live user/chunk/thought/tool/done/error 进入 sink；replay 与
 * commitReplaySnapshot 不写；乐观 user 按 clientMsgId 去重；终态 force；
 * prune 丢弃孤儿 owner；flushCanonicalEvents 暴露给关闭路径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn((..._args: unknown[]) => Promise.resolve({})) }))
const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }))
    return Promise.resolve(() => { listeners.delete(event) })
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  // B1：chatEventController 顶部 import Channel（类型+运行时占位）；测试环境 IS_TAURI=false
  // 时 streamChannel.openStreamChannel 直接返回 undefined，不会实例化。
  Channel: class { id = 0; onmessage = () => {} },
}))

import {
  attachChatEventController,
  setCanonicalEventSinkFactoryForTests,
  type ChatEventControllerRefs,
} from '../chatEventController'
import type { CanonicalEventSink } from '../../../infrastructure/events/canonicalEventSink'
import { useIdentityStore, type Session } from '../../../identityStore'

async function waitListeners(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 100)) }

function makeRefs(): ChatEventControllerRefs {
  return {
    sessionRef: { current: null },
    messageOwnerRef: { current: null },
    setMessages: () => {},
    setStreamingText: () => {},
    setStreamingThinking: () => {},
    setGenerating: () => {},
    setGenerationPhase: () => {},
    setSummary: () => {},
    setLastTokenAt: () => {},
  }
}

function makeSession(id: string, source: string): Session {
  return {
    id, agentId: 'peri', source, name: 's', profileId: 'p1', createdAt: 1,
    lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function replayUpdate(update: Record<string, unknown>): unknown {
  return { sessionId: 'peri-test', update: { ...update, _meta: { periReplay: true } } }
}

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

beforeEach(() => {
  listeners.clear()
  useIdentityStore.setState({ sessions: [], sessionsHydrated: true })
  sink.offers.length = 0
  sink.discarded.length = 0
  invokeMock.mockReset()
  invokeMock.mockResolvedValue({})
  setCanonicalEventSinkFactoryForTests(() => sink)
})

afterEach(() => {
  setCanonicalEventSinkFactoryForTests(null)
})

let currentHandle: ReturnType<typeof attachChatEventController> | null = null

describe('canonical 双写（A1-c P2）', () => {
  const fire = (event: string, payload: unknown) => {
    // B1：四事件全部走 Channel 帧入口（与生产注册会话路径一致——后端 user echo
    // 已 send_update_frame 单轨化）；广播 listen 仅兜底，由 fireBroadcast 覆盖。
    if (event === 'pylon:update' || event === 'pylon:done' || event === 'pylon:error' || event === 'pylon:user') {
      const handle = currentHandle ?? (() => { throw new Error('controller 未挂载') })()
      void handle.handleStreamFrame({ event: event as 'pylon:update'|'pylon:done'|'pylon:error'|'pylon:user', payload })
      return
    }
    const handler = listeners.get(event)
    if (!handler) throw new Error(`listener ${event} 未注册`)
    handler(payload)
  }

  it('user + assistant chunk + done 依序进入 sink，done force 强刷', async () => {
    const source = 'local:dw-basic'
    useIdentityStore.setState({ sessions: [makeSession('s1', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    fire('pylon:user', { source, content: '问题' })
    fire('pylon:update', { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } } })
    fire('pylon:done', { source })

    expect(sink.offers.map(offer => offer.force)).toEqual([false, false, true])
    const userRaw = sink.offers[0].raw as { update?: { sessionUpdate?: string; content?: { text?: string } } }
    expect(userRaw.update?.sessionUpdate).toBe('user_message_chunk')
    expect(userRaw.update?.content?.text).toBe('问题')
    const chunkRaw = sink.offers[1].raw as { update?: { sessionUpdate?: string } }
    expect(chunkRaw.update?.sessionUpdate).toBe('agent_message_chunk')
    const doneRaw = sink.offers[2].raw as { update?: { sessionUpdate?: string } }
    expect(doneRaw.update?.sessionUpdate).toBe('done')
    handle.dispose()
  })

  it('tool_call/tool_call_update 双写原始 wire payload', async () => {
    const source = 'local:dw-tool'
    useIdentityStore.setState({ sessions: [makeSession('s2', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    const toolCall = { source, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' } } }
    const toolUpdate = { source, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', rawOutput: 'ok', status: 'completed' } }
    fire('pylon:update', toolCall)
    fire('pylon:update', toolUpdate)

    expect(sink.offers).toHaveLength(2)
    expect(sink.offers[0].raw).toBe(toolCall)
    expect(sink.offers[1].raw).toBe(toolUpdate)
    handle.dispose()
  })

  it('Kernel committed user/update/done/error 只做 projection，不再由 WebView 二次落盘', async () => {
    const source = 'local:kernel-committed'
    useIdentityStore.setState({ sessions: [makeSession('s-kernel', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    const canonicalEvent = (sequence: number, eventType: string, rawPayload: unknown) => ({
      eventId: `["p1","peri","local:kernel-committed"]#${sequence}`,
      profileId: 'p1',
      agentId: 'peri',
      localSessionId: source,
      remoteSessionId: 'remote-1',
      clientGeneration: 2,
      sequence,
      occurredAt: '2026-08-20T00:00:00.000Z',
      receivedAt: '2026-08-20T00:00:00.000Z',
      eventType,
      payloadVersion: 1,
      rawPayload,
      createdAt: 1,
    })
    const userRaw = { source, update: { sessionUpdate: 'user_message_chunk', content: { text: 'question' } } }
    fire('pylon:user', { source, content: 'question', canonicalEvent: canonicalEvent(1, 'user.message', userRaw) })

    const raw = { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'durable' } } }
    fire('pylon:update', {
      ...raw,
      canonicalEvent: {
        ...canonicalEvent(2, 'assistant.text.delta', raw),
        typedPayload: { text: 'durable' },
      },
    })
    const doneRaw = { source, update: { sessionUpdate: 'done' } }
    fire('pylon:done', { source, canonicalEvent: canonicalEvent(3, 'turn.completed', doneRaw) })
    const errorRaw = { source, update: { sessionUpdate: 'error', errorCode: 'protocol_error', error: 'boom' } }
    fire('pylon:error', {
      source,
      error: 'boom',
      code: 'protocol_error',
      canonicalEvent: canonicalEvent(4, 'turn.failed', errorRaw),
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sink.offers).toHaveLength(0)
    handle.dispose()
  })

  it('Kernel committed sequence 出现缺口时从同一 journal 补读后再处理当前事件', async () => {
    const source = 'local:kernel-gap'
    useIdentityStore.setState({ sessions: [makeSession('s-gap', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])
    const canonicalEvent = (sequence: number, eventType: string, rawPayload: unknown, typedPayload?: unknown) => ({
      eventId: `["p1","peri","${source}"]#${sequence}`,
      profileId: 'p1',
      agentId: 'peri',
      localSessionId: source,
      remoteSessionId: 'remote-gap',
      clientGeneration: 1,
      sequence,
      occurredAt: '2026-08-20T00:00:00.000Z',
      receivedAt: '2026-08-20T00:00:00.000Z',
      eventType,
      payloadVersion: 1,
      typedPayload,
      rawPayload,
      createdAt: 1,
    })
    const userRaw = { source, update: { sessionUpdate: 'user_message_chunk', content: { text: 'question' } } }
    const chunkRaw = { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'recovered' } } }
    const doneRaw = { source, update: { sessionUpdate: 'done' } }
    const missing = canonicalEvent(2, 'assistant.text.delta', chunkRaw, { text: 'recovered' })
    const current = canonicalEvent(3, 'turn.completed', doneRaw)
    invokeMock.mockResolvedValueOnce({ events: [missing, current], nextBeforeSequence: 2 })

    fire('pylon:user', { source, content: 'question', canonicalEvent: canonicalEvent(1, 'user.message', userRaw, { text: 'question' }) })
    fire('pylon:done', { source, canonicalEvent: current })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(invokeMock).toHaveBeenCalledWith('evt_list', { ownerKey: `["p1","peri","${source}"]`, beforeSequence: 4, limit: 2 })
    expect(handle.getMessages(source).map(message => [message.role, message.content])).toEqual([
      ['user', 'question'],
      ['assistant', 'recovered'],
    ])
    expect(sink.offers).toHaveLength(0)
    handle.dispose()
  })

  it('load 期间该 source 的 user/chunk/done 不写 canonical；load 结束后恢复双写', async () => {
    const source = 'local:dw-loading'
    useIdentityStore.setState({ sessions: [makeSession('s-loading', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    const gen = handle.beginLoadLock(source)
    fire('pylon:user', { source, content: '历史问题' })
    fire('pylon:update', { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: '历史回复' } } })
    fire('pylon:done', { source })
    // load transaction 存续期间，这些事件可能是 replay 广播（未标 periReplay），
    // 绝不能双写进 canonical_events，否则重启后首屏投影整段重复。
    expect(sink.offers).toHaveLength(0)
    handle.finishLoadLock(source, gen)

    fire('pylon:update', { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: '新回复' } } })
    expect(sink.offers).toHaveLength(1)
    handle.dispose()
  })

  it('replay 标记与 commitReplaySnapshot 都不写 canonical', async () => {
    const source = 'local:dw-replay'
    useIdentityStore.setState({ sessions: [makeSession('s3', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    fire('pylon:update', { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'r' }, _meta: { periReplay: true } } })
    expect(sink.offers).toHaveLength(0)

    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '历史' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
    ])
    handle.finishLoadLock(source, gen)
    expect(sink.offers).toHaveLength(0)
    handle.dispose()
  })

  it('乐观 user 双写并按 clientMsgId 去重', async () => {
    const source = 'local:dw-optimistic'
    useIdentityStore.setState({ sessions: [makeSession('s4', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    handle.sendOptimisticUser(source, '乐观', 'cid-1')
    handle.sendOptimisticUser(source, '乐观', 'cid-1')
    expect(sink.offers).toHaveLength(1)
    expect((sink.offers[0].raw as { update?: { sessionUpdate?: string } }).update?.sessionUpdate).toBe('user_message_chunk')
    expect((sink.offers[0].raw as { update?: { _meta?: { pylonOptimisticUser?: boolean; requestId?: string } } }).update?._meta)
      .toEqual({ pylonOptimisticUser: true, requestId: 'cid-1' })
    handle.dispose()
  })

  it('兼容 facade 的隐式 durable 默认发出 C0-OPT 迁移诊断', async () => {
    const source = 'local:dw-implicit-diagnostic'
    useIdentityStore.setState({ sessions: [makeSession('s4-diagnostic', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      handle.sendOptimisticUser(source, '兼容调用', 'cid-diagnostic')
      expect(warning).toHaveBeenCalledWith(
        '[C0-OPT] sendOptimisticUser requires explicit persistCanonical policy',
        { source, clientMsgId: 'cid-diagnostic' },
      )
    } finally {
      warning.mockRestore()
      handle.dispose()
    }
  })

  it('显式 runtime-local optimistic policy 不写 canonical sink', async () => {
    const source = 'local:dw-optimistic-local'
    useIdentityStore.setState({ sessions: [makeSession('s4-local', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    handle.sendOptimisticUser(source, '本地回显', 'cid-local', { persistCanonical: false })
    expect(sink.offers).toHaveLength(0)
    expect(handle.getMessages(source).find(message => message.clientMsgId === 'cid-local')).toMatchObject({
      role: 'user', content: '本地回显', clientMsgId: 'cid-local',
    })
    handle.dispose()
  })

  it('runtime-local optimistic user 收到后端 echo 后确认且不重复追加', async () => {
    const source = 'local:dw-optimistic-echo'
    useIdentityStore.setState({ sessions: [makeSession('s4-echo', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    handle.sendOptimisticUser(source, '后端确认', 'cid-echo', { persistCanonical: false })
    fire('pylon:user', { source, content: '后端确认' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sink.offers).toHaveLength(0)
    expect(handle.getMessages(source).filter(message => message.role === 'user')).toEqual([
      expect.objectContaining({ role: 'user', content: '后端确认' }),
    ])
    expect(handle.getMessages(source).find(message => message.role === 'user')?.clientMsgId).toBeUndefined()
    handle.dispose()
  })

  it('error 终态 force 强刷', async () => {
    const source = 'local:dw-error'
    useIdentityStore.setState({ sessions: [makeSession('s5', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    fire('pylon:error', { source, error: 'boom', cancelled: true })
    expect(sink.offers).toHaveLength(1)
    expect(sink.offers[0].force).toBe(true)
    const raw = sink.offers[0].raw as { update?: { sessionUpdate?: string; error?: string; cancelled?: boolean } }
    expect(raw.update).toMatchObject({ sessionUpdate: 'error', error: 'boom', cancelled: true })
    handle.dispose()
  })

  it('error 展示使用 failure 摘要但 canonical raw 保留 provider 诊断', async () => {
    const source = 'local:dw-provider-error'
    useIdentityStore.setState({ sessions: [makeSession('s-provider-error', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(source, [])

    const failure = {
      source: 'provider', configuredTimeoutSecs: 180, actualElapsedMs: 24_000,
      providerMessage: 'ACP protocol: timed out after 180s (provider error)',
    } as const
    await handle.handleStreamFrame({
      event: 'pylon:error',
      payload: { source, error: failure.providerMessage, failure },
    })

    expect(handle.getMessages(source).at(-1)?.content).toBe('Provider 返回错误')
    expect(sink.offers[0]?.raw).toMatchObject({
      source,
      update: {
        sessionUpdate: 'error', error: failure.providerMessage, failure,
      },
    })
    handle.dispose()
  })

  it('pruneSources 丢弃被移除 source 的 canonical owner', async () => {
    const A = 'local:dw-a', B = 'local:dw-b'
    useIdentityStore.setState({ sessions: [makeSession('sA', A), makeSession('sB', B)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    handle.initSource(A, [])
    handle.initSource(B, [])

    fire('pylon:user', { source: A, content: 'a' })
    fire('pylon:user', { source: B, content: 'b' })
    handle.pruneSources([A])
    expect(sink.discarded).toEqual(['["p1","peri","local:dw-b"]'])
    handle.dispose()
  })

  it('flushCanonicalEvents 委托 sink.flushAll', async () => {
    const source = 'local:dw-flush'
    useIdentityStore.setState({ sessions: [makeSession('s6', source)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()
    vi.mocked(sink.flushAll).mockClear()
    expect(sink.flushAll).not.toHaveBeenCalled()
    handle.flushCanonicalEvents()
    expect(sink.flushAll).toHaveBeenCalledTimes(1)
    handle.dispose()
  })
})
