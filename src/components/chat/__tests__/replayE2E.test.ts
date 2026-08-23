// @vitest-environment jsdom
/**
 * 回放去重端到端（验证 agent 对抗场景复刻）：
 * load 期间 live 到达的 user 消息（乐观渲染）+ Hermes 回放权威历史含同一条。
 * 共享 seq 导致两个副本 id 不同（user-3 vs user-7），必须按内容签名去重。
 */
import { describe, expect, it, vi } from 'vitest'

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
import type { ChatEventControllerRefs } from '../chatEventController'
import type { Message } from '../messageTypes'
import type { Session } from '../../../identityStore'

async function waitListeners(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100))
}

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

function makeSession(source: string): Session {
  return {
    id: `sess-${source}`, agentId: 'peri', source, name: 'session-x', profileId: 'p1', createdAt: 1,
    lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function replayUpdate(update: Record<string, unknown>): unknown {
  return { sessionId: 'peri-test', update: { ...update, _meta: { periReplay: true } } }
}

describe('回放去重端到端（验证 agent 对抗场景）', () => {
  it('live tool 消息（不同 toolCallId）不被 replay 权威误删', async () => {
    const source = 'local:e2e-tool'
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    // cached 历史含旧 tool 调用
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: source, content: 'q', time: 't' },
      { id: 'tool-tc-42', role: 'tool', sender: 'tool:read', content: '', time: 't' },
    ]
    handle.initSource(source, cached)

    // load 期间 agent 新 tool 调用（live,tc-99）
    handle.handleStreamFrame({ event: 'pylon:update', payload: {
      source,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tc-99', title: 'write', kind: 'write_file', rawInput: '{"path":"x"}' },
    } })
    // replay 权威回放历史（含旧 tool tc-42）
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: 'q' } }),
      replayUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-42', title: 'read', kind: 'read_file', rawInput: '{}' }),
    ])
    handle.finishLoadLock(source, gen)

    const toolIds = handle.getMessages(source).filter(m => m.role === 'tool').map(m => m.id)
    // tc-99(live) 与 tc-42(replay) 都必须保留——不得按签名坍缩误删
    expect(toolIds).toContain('tool-tc-99')
    expect(toolIds).toContain('tool-tc-42')
    handle.dispose()
  })

  it('live 乐观 user 消息 + replay 权威含同内容 → 无 identity 时保留两条', async () => {
    const source = 'local:e2e-a'
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    // cached 历史（进入会话前的持久化）
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: source, content: 'old-q', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: 'old-a', time: 't' },
    ]
    handle.initSource(source, cached)

    // load 期间用户乐观渲染 A（方案 B）
    handle.sendOptimisticUser(source, 'A', 'cid-A')
    // 乐观渲染后 live 有: [old-q, old-a, user-3:A(optimistic)]

    // Hermes 回放权威历史由 command snapshot 原子提交。
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: 'old-q' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'old-a' } }),
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: 'A' } }),
    ])
    handle.finishLoadLock(source, gen)

    const messages = handle.getMessages(source)
    const contents = messages.map(m => m.content)
    // 无稳定 identity 时不能按正文猜测合并，replay 与 live 两条都保留
    expect(contents.filter(c => c === 'A').length).toBe(2)
    expect(contents.filter(c => c === 'old-q').length).toBe(1)
    expect(contents.filter(c => c === 'old-a').length).toBe(1)
    expect(messages[0]?.content).toBe('old-q')
    expect(messages[1]?.content).toBe('old-a')
    expect(messages[2]?.content).toBe('A')
    expect(messages[3]?.content).toBe('A')
    handle.dispose()
  })

  it('snapshot 提交必须整体替换旧 runtime，不能把上轮残留重新合并', async () => {
    const source = 'local:replace-authority'
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    const polluted: Message[] = [
      { id: 'user-1', role: 'user', sender: source, content: '权威问题', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '权威回答', time: 't' },
      { id: 'msg-3', role: 'assistant', sender: 'peri', content: '上轮错误残留', time: 't' },
    ]
    handle.initSource(source, polluted)
    const gen = handle.beginLoadLock(source)
    const resolved = handle.commitReplaySnapshot(source, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '权威问题' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '权威回答' } }),
    ])
    handle.finishLoadLock(source, gen)

    expect(resolved.map(message => message.content)).toEqual(['权威问题', '权威回答'])
    expect(handle.getMessages(source).some(message => message.content === '上轮错误残留')).toBe(false)
    handle.dispose()
  })

  it('空 replay snapshot 清空旧缓存，不能保留另一个会话的显示', async () => {
    const source = 'local:empty-authority'
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()
    const cached: Message[] = [
      { id: 'msg-1', role: 'assistant', sender: 'peri', content: '错误旧缓存', time: 't' },
    ]
    handle.initSource(source, cached)
    const gen = handle.beginLoadLock(source)

    expect(handle.commitReplaySnapshot(source, gen, [])).toEqual([])
    handle.finishLoadLock(source, gen)
    expect(handle.getMessages(source)).toEqual([])
    handle.dispose()
  })

  it('重入已有缓存会话（D3）：replay user 与缓存末条同内容 → 不丢消息、不累积', async () => {
    const source = 'local:e2e-d3'
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    const handle = attachChatEventController(makeRefs())
    await waitListeners()

    // 缓存：上一轮完成的对话 [你好, 回复]（后端已剥离 persona 前缀）
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: source, content: '你好', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '回复', time: 't' },
    ]
    handle.initSource(source, cached)

    // Hermes load 重放完整历史（由 command snapshot 原子返回）。
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '你好' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
    ])
    handle.finishLoadLock(source, gen)

    const messages = handle.getMessages(source)
    const contents = messages.map(m => m.content)
    // 用户消息"你好"必须保留（不得被 lastUser 去重跳过 → replaying 不含它 → 权威替换丢失）
    expect(contents.filter(c => c === '你好').length).toBe(1)
    // 回复保留,不累积
    expect(contents.filter(c => c === '回复').length).toBe(1)
    expect(messages.length).toBe(2)
    handle.dispose()
  })
})
