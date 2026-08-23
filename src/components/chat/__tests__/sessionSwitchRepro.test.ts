// @vitest-environment jsdom
/**
 * 用户复现（2026-08-12 验收发行版）：新建会话-发送消息-新建会话-来回切换 → 复读。
 * 模拟：进入 A → 发消息（乐观 user + 流式 chunk + done）→ 持久化 → 新建 B → 来回切换
 * （切回 A 走 replay 权威）。验证不复读（ISSUE-06 目标行为 #3）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, (payload) => handler({ payload }))
    return Promise.resolve(() => { listeners.delete(event) })
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }))
import { attachChatEventController } from '../chatEventController'
import { useIdentityStore } from '../../../identityStore'
import { persistMessageSnapshot, parseMessageSnapshot, messageStorageKey } from '../messagePersistence'
import type { ChatEventControllerRefs } from '../chatEventController'
import type { Message } from '../messageTypes'
import type { Session } from '../../../identityStore'

async function waitListeners(): Promise<void> { await new Promise(r => setTimeout(r, 100)) }
function makeRefs(): ChatEventControllerRefs {
  return { sessionRef: { current: null }, messageOwnerRef: { current: null }, setMessages: () => {}, setStreamingText: () => {}, setStreamingThinking: () => {}, setGenerating: () => {}, setGenerationPhase: () => {}, setSummary: () => {}, setLastTokenAt: () => {} }
}
function makeSession(id: string, source: string): Session {
  return { id, agentId: 'peri', source, name: 's', profileId: 'p1', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
}
function readCached(sessionId: string): Message[] {
  const raw = localStorage.getItem(messageStorageKey(sessionId))
  return raw ? (parseMessageSnapshot<Message>(raw) ?? []) : []
}
function replayUpdate(update: Record<string, unknown>): unknown {
  return { sessionId: 'peri-test', update: { ...update, _meta: { periReplay: true } } }
}

beforeEach(() => { listeners.clear(); useIdentityStore.setState({ sessions: [], sessionsHydrated: true }); localStorage.clear() })

describe('用户复现：新建→发消息→新建→来回切换不复读', () => {
  let currentHandle: ReturnType<typeof attachChatEventController> | null = null
  const fire = (event: string, payload: unknown) => {
    // C2：pylon:update/done/error 广播旧轨已拆，改走 Channel 帧入口；user 等保留广播。
    if (event === 'pylon:update' || event === 'pylon:done' || event === 'pylon:error') {
      const handle = currentHandle
      if (!handle) throw new Error('controller 未挂载')
      return handle.handleStreamFrame({ event: event as 'pylon:update'|'pylon:done'|'pylon:error', payload }).then(() => {})
    }
    const handler = listeners.get(event)
    if (!handler) throw new Error(`listener ${event} 未注册`)
    handler(payload)
  }

  it('A 发消息完成后切 B 再切回 A（replay 权威）3 轮不叠加', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    // 进入 A（新建无缓存）→ 发消息：user + 流式回复 + done
    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '你好' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回' } } })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '复' } } })
    fire('pylon:done', { source: A })
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['你好', '回复'])
    // 持久化（模拟 messagePersistScheduler 落盘）
    persistMessageSnapshot('sa', handle.getMessages(A), localStorage)

    // 新建 B → 切到 B
    handle.initSource(B, [])

    // 来回切换 3 轮（切回 A 走 replay 权威）
    for (let i = 0; i < 3; i++) {
      handle.initSource(A, readCached('sa'))
      const gen = handle.beginLoadLock(A)
      handle.commitReplaySnapshot(A, gen, [
        replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '你好' } }),
        replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
      ])
      handle.finishLoadLock(A, gen)
      handle.initSource(B, [])
    }
    const final = handle.getMessages(A).map(m => m.content)
    expect(final.filter(c => c === '你好').length).toBe(1)
    expect(final.filter(c => c === '回复').length).toBe(1)
    expect(final).toEqual(['你好', '回复'])
    handle.dispose()
  })

  it('切走时 A 未 done（流式残留）→ 切回 replay 完整 → 不残留半条', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '你好' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回' } } })
    // 未 done 就切走（流式残留 streamingText）
    handle.initSource(B, [])

    // 切回 A：replay 完整 [你好, 回复]
    handle.initSource(A, [])
    const gen = handle.beginLoadLock(A)
    handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '你好' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
    ])
    handle.finishLoadLock(A, gen)
    const final = handle.getMessages(A).map(m => m.content)
    expect(final.filter(c => c === '你好').length).toBe(1)
    expect(final.filter(c => c === '回复').length).toBe(1)
    handle.dispose()
  })

  it('sheet 切回重挂载（preserveRuntime）保留 completed 消息', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '问题' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } } })
    fire('pylon:done', { source: A })
    const completed = handle.getMessages(A).map(m => m.content)

    // 模拟切走 sheet 再切回：cached 为空（异步落盘未完成），preserveRuntime=true
    const remounted = handle.initSource(A, [], true).map(m => m.content)
    expect(remounted).toEqual(completed)
    handle.dispose()
  })

  it('切回时进行中的工具调用不因缓存缺失而消失', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '做点事' })
    // 先只把用户消息落盘；随后到达的工具调用尚未持久化
    persistMessageSnapshot('sa', handle.getMessages(A), localStorage)
    fire('pylon:update', { source: A, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' } } })
    expect(handle.getMessages(A).some(m => m.role === 'tool' && m.running === true)).toBe(true)

    // 切到 B 再切回 A：cached 只有用户消息，进行中的工具卡必须保留
    handle.initSource(B, [])
    handle.initSource(A, readCached('sa'))

    const tools = handle.getMessages(A).filter(m => m.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: 'tool-tc-1', toolName: 'Read', running: true })
    handle.dispose()
  })

  it('重放 reasoning 与 live/canonical 同语义：相邻无 identity 思考块聚合为一条', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    const gen = handle.beginLoadLock(A)
    handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '问题' } }),
      replayUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: '思考一' } }),
      replayUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: '思考二' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
    ])
    handle.finishLoadLock(A, gen)

    expect(handle.getMessages(A).map(m => m.content)).toEqual(['问题', '思考一思考二', '回复'])
    handle.dispose()
  })

  it('切回时进行中的思考块不因缓存缺失而消失', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '想一下' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_thought_chunk', content: { text: '思考中' } } })
    expect(handle.getMessages(A).some(m => m.role === 'reasoning' && m.running === true)).toBe(true)

    // 切走再切回：缓存里没有未落盘的思考块
    handle.initSource(B, [])
    const cachedA = readCached('sa')
    handle.initSource(A, cachedA)

    expect(handle.getMessages(A).some(m => m.role === 'reasoning' && m.running === true)).toBe(true)
    handle.dispose()
  })
})
