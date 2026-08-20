// @vitest-environment jsdom
/** 会话切换回归(重放重新设计):模拟 load 期间发消息 + 多次切换。 */
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

describe('会话切换(重放重新设计)', () => {
  it('多次切换 A/B 不叠加、不串', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    const initA: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '你好', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '回复', time: 't' },
    ]
    persistMessageSnapshot('sa', initA, localStorage)

    // 3 轮 A↔B 切换
    for (let i = 0; i < 3; i++) {
      handle.initSource(A, readCached('sa'))
      const gen = handle.beginLoadLock(A)
      handle.commitReplaySnapshot(A, gen, [
        replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '你好' } }),
        replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
      ])
      handle.finishLoadLock(A, gen)
      persistMessageSnapshot('sa', handle.getMessages(A), localStorage)
      expect(handle.getMessages(A).map(m => m.content)).toEqual(['你好', '回复'])

      handle.initSource(B, [])
      expect(handle.getMessages(B)).toEqual([])
    }
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['你好', '回复'])
    expect(handle.getMessages(B)).toEqual([])
    handle.dispose()
  })

  it('load 期间发新消息 → 权威 + live 增量正确合并', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    const initA: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '你好', time: 't' },
    ]
    persistMessageSnapshot('sa', initA, localStorage)
    handle.initSource(A, readCached('sa'))

    // load 期间用户发新消息 u2(乐观)
    handle.sendOptimisticUser(A, '第二问', 'cid-2')

    // load 完成:重放权威 [你好] + live 增量 [第二问]
    const gen = handle.beginLoadLock(A)
    handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '你好' } }),
    ])
    handle.finishLoadLock(A, gen)
    const msgs = handle.getMessages(A)
    const contents = msgs.map(m => m.content)
    expect(contents).toContain('你好')
    expect(contents).toContain('第二问')
    expect(contents.filter(c => c === '你好').length).toBe(1)
    expect(contents.filter(c => c === '第二问').length).toBe(1)
    handle.dispose()
  })
})

describe('pruneSources（chat-regression-entry 契约）', () => {
  it('清理非活跃 source 的孤儿状态，保留活跃 source', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    // 两个 source 都有消息状态（initSource 注入缓存消息）
    const aMsgs: Message[] = [{ id: 'user-a', role: 'user', sender: A, content: 'a', time: 't' }]
    const bMsgs: Message[] = [{ id: 'user-b', role: 'user', sender: B, content: 'b', time: 't' }]
    handle.initSource(A, aMsgs)
    handle.initSource(B, bMsgs)
    expect(handle.getMessages(A).length).toBe(1)
    expect(handle.getMessages(B).length).toBe(1)

    // 会话集合变化：只保留 A，B 被 prune
    handle.pruneSources([A])
    expect(handle.getMessages(A).length).toBe(1)
    expect(handle.getMessages(B)).toEqual([])
    handle.dispose()
  })
})

describe('会话切换对抗(load 未完成残留)', () => {
  it('切走时 load 未完成 → 切回新 load 不重复 replaying', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    const cachedA: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '你好', time: 't' },
    ]
    persistMessageSnapshot('sa', cachedA, localStorage)

    // 第一次进入 A：initSource 开启 load
    handle.initSource(A, readCached('sa'))
    // load 未完成就切走：旧 snapshot 尚未提交

    // 切回 A：新 load 开始（initSource 清 replaying）
    handle.initSource(A, readCached('sa'))
    // 新 load 完整重放
    const gen = handle.beginLoadLock(A)
    handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '你好' } }),
    ])
    handle.finishLoadLock(A, gen)

    const msgs = handle.getMessages(A)
    expect(msgs.map(m => m.content)).toEqual(['你好'])
    expect(msgs.filter(m => m.content === '你好').length).toBe(1)
    handle.dispose()
  })
})
