// @vitest-environment jsdom
/**
 * 行为化承接 scripts/test-chat-clear-sink.mts：
 * peri:clear 事件 → controller.handleClear 按当前渲染 source/owner 匹配会话 →
 * clearMessageStorage（持久层删除）+ dispatch clear（内存清空）+ 渲染同步。
 * 原守卫断言源码 token（handleClear 匹配、clearMessageStorage 调用、setMessages 同步），
 * 这里直接发事件验证真实行为。
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
import { persistMessageSnapshot, messageStorageKey } from '../messagePersistence'
import type { ChatEventControllerRefs } from '../chatEventController'
import type { Message } from '../messageTypes'
import type { Session } from '../../../identityStore'

async function waitListeners(): Promise<void> { await new Promise(r => setTimeout(r, 100)) }
function makeSession(id: string, source: string): Session {
  return { id, agentId: 'peri', source, name: 's', profileId: 'p1', createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
}

function fireClear(): void {
  window.dispatchEvent(new Event('peri:clear'))
}

beforeEach(() => { listeners.clear(); useIdentityStore.setState({ sessions: [], sessionsHydrated: true }); localStorage.clear() })

describe('peri:clear 事件（clear-sink 契约）', () => {
  it('发 clear 事件后 localStorage 消息被删、内存消息清空、渲染同步收到', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const setMessages = vi.fn()
    const refs: ChatEventControllerRefs = {
      sessionRef: { current: A },
      messageOwnerRef: { current: 'sa' },
      setMessages,
      setStreamingText: () => {}, setStreamingThinking: () => {}, setGenerating: () => {}, setGenerationPhase: () => {}, setSummary: () => {}, setLastTokenAt: () => {},
    }
    const handle = attachChatEventController(refs)
    await waitListeners()

    const msgs: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '你好', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '回复', time: 't' },
    ]
    persistMessageSnapshot('sa', msgs, localStorage)
    expect(localStorage.getItem(messageStorageKey('sa'))).not.toBeNull()
    handle.initSource(A, msgs)
    expect(handle.getMessages(A).length).toBe(2)

    fireClear()

    // 持久层删除
    expect(localStorage.getItem(messageStorageKey('sa'))).toBeNull()
    // 内存清空
    expect(handle.getMessages(A)).toEqual([])
    // 渲染同步（clear dispatch 后 setMessages 被调且收到空数组）
    expect(setMessages).toHaveBeenCalled()
    handle.dispose()
  })

  it('无当前渲染 source/owner 时 clear 不产生副作用（保守）', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const refs: ChatEventControllerRefs = {
      sessionRef: { current: null },
      messageOwnerRef: { current: null },
      setMessages: vi.fn(), setStreamingText: () => {}, setStreamingThinking: () => {}, setGenerating: () => {}, setGenerationPhase: () => {}, setSummary: () => {}, setLastTokenAt: () => {},
    }
    const handle = attachChatEventController(refs)
    await waitListeners()
    const msgs: Message[] = [{ id: 'user-1', role: 'user', sender: A, content: '你好', time: 't' }]
    persistMessageSnapshot('sa', msgs, localStorage)
    handle.initSource(A, msgs)

    fireClear()

    // 渲染层未匹配 → 不应清内存（localStorage 也不应删：handleClear 因无 source 提前 return）
    expect(handle.getMessages(A).length).toBe(1)
    expect(localStorage.getItem(messageStorageKey('sa'))).not.toBeNull()
    handle.dispose()
  })
})
