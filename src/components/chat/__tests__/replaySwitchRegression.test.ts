// @vitest-environment jsdom
/**
 * 会话重放修复回归（任务书 Bug 1）。
 * 锁定两处行为：
 * 1. initSource 不再用「长度启发式」丢弃 completed 消息；
 * 2. commitReplaySnapshot 正式路径（lock generation）按 loadBaseMessageIds 合并
 *    load 开始后的新 live 消息（含 completed），而不是只保留 running。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import { useRuntimeStore } from '../../../runtimeStore'
import { toAgentContextKey } from '../../../agentContext'
import { parseMessageSnapshot, messageStorageKey } from '../messagePersistence'
import { normalizeRawEvent } from '../../../domains/events/canonicalNormalizer'
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

describe('会话重放修复回归', () => {
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

  it('initSource：缓存为空（stale）时切回不丢 completed 消息', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '问题' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } } })
    fire('pylon:done', { source: A })
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['问题', '回复'])

    // 切回（Tauri 下 live 只写 canonical_events，localStorage 快照仍为空）
    const returned = handle.initSource(A, readCached('sa'), false).map(m => m.content)
    expect(returned).toEqual(['问题', '回复'])
    handle.dispose()
  })

  it('initSource：缓存非空但缺新回合时切回不丢 completed', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '旧问题', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '旧回复', time: 't' },
    ]
    handle.initSource(A, cached)
    fire('pylon:user', { source: A, content: '新问题' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '新回复' } } })
    fire('pylon:done', { source: A })
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['旧问题', '旧回复', '新问题', '新回复'])

    // 切回，缓存仍只有旧回合
    const returned = handle.initSource(A, cached, false).map(m => m.content)
    expect(returned).toEqual(['旧问题', '旧回复', '新问题', '新回复'])
    handle.dispose()
  })

  it('initSource：缓存与内存消息 id 错位时不重复追加同内容消息', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '问题' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } } })
    fire('pylon:done', { source: A })
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['问题', '回复'])

    // canonical 占位比 replay 多一条 thought，导致后续消息 id 错位：
    // 占位 user-1 / thought-2 / msg-3；内存 user-1 / msg-2。
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '问题', time: 't' },
      { id: 'thought-2', role: 'reasoning', sender: 'peri', content: '思考一', time: 't' },
      { id: 'msg-3', role: 'assistant', sender: 'peri', content: '回复', time: 't' },
    ]
    const returned = handle.initSource(A, cached, false)
    expect(returned.filter(m => m.content === '回复')).toHaveLength(1)
    expect(returned.some(m => m.content === '思考一')).toBe(true)
    handle.dispose()
  })

  it('canonical 占位非空时 replay 不覆盖用户消息与思考块', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: '问题' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_thought_chunk', content: { text: '思考' } } })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } } })
    fire('pylon:done', { source: A })

    // canonical 占位含 user/thought/assistant（loadBaseFromCache=true）
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '问题', time: 't' },
      { id: 'thought-2', role: 'reasoning', sender: 'peri', content: '思考', time: 't' },
      { id: 'msg-3', role: 'assistant', sender: 'peri', content: '回复', time: 't' },
    ]
    handle.initSource(A, cached, false, true)

    // agent replay 只有 assistant（缺 user/thought）——不应覆盖 base
    const gen = handle.beginLoadLock(A)
    const resolved = handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
    ])
    expect(resolved.map(m => m.content)).toEqual(['问题', '思考', '回复'])
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('commitReplaySnapshot 正式路径：replay 缺失的新 live completed 消息被保留', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '旧问题', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '旧回复', time: 't' },
    ]
    handle.initSource(A, cached)
    // load 开始前已完成的新 live 消息（不在 loadBaseMessageIds，且 running=false）
    fire('pylon:user', { source: A, content: '新问题' })
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['旧问题', '旧回复', '新问题'])

    const gen = handle.beginLoadLock(A)
    // 后端 snapshot 只含旧历史（尚未包含新回合）
    const resolved = handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '旧问题' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '旧回复' } }),
    ])
    expect(resolved.map(m => m.content)).toEqual(['旧问题', '旧回复', '新问题'])
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('commitReplaySnapshot 恢复 available_commands_update 到 sessionLiveStats', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    const gen = handle.beginLoadLock(A)
    const commands = [{ cmd: '/compact', description: 'compact' }]
    handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'available_commands_update', commands }),
    ])
    const key = toAgentContextKey({ agentId: 'peri', source: A })
    expect(useRuntimeStore.getState().sessionLiveStats[key]?.commands).toEqual(commands)
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('空 replay 不覆盖内存态（in-flight 工具回合切回）', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    fire('pylon:user', { source: A, content: 'sleep 30 && echo done' })
    fire('pylon:update', { source: A, update: { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'terminal: sleep 30', kind: 'execute' } })

    const gen = handle.beginLoadLock(A)
    const resolved = handle.commitReplaySnapshot(A, gen, [])
    expect(resolved).toHaveLength(2)
    expect(resolved[0].role).toBe('user')
    expect(resolved[1].role).toBe('tool')
    expect(resolved[1].toolName).toBe('terminal: sleep 30')
    expect(resolved[1].running).toBe(true)
    expect(handle.getMessages(A)).toHaveLength(2)
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('canonical 权威路径：load 期间 queued live 事件不追加（重放广播不造成复读）', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    // 非空 canonical 占位 = 权威
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '问题', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '回复', time: 't' },
    ]
    handle.initSource(A, cached, false, true)

    const gen = handle.beginLoadLock(A)
    // load 期间到达的全局事件（未标 periReplay 的 replay 广播）被 buffer；
    // canonical 权威下 commit 后必须丢弃，不得追加为“新回复”。
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '新回复', messageId: 'new-m' } } })
    const resolved = handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '问题' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '回复' } }),
    ])
    expect(resolved.map(m => m.content)).toEqual(['问题', '回复'])
    handle.finishLoadLock(A, gen)
    expect(handle.getMessages(A).map(m => m.content)).toEqual(['问题', '回复'])
    handle.dispose()
  })

  it('Bug3：A 生成中切到 B 再切回，load 期间到达的 canonical 增量不能丢失', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const refs = makeRefs()
    refs.sessionRef.current = A
    refs.messageOwnerRef.current = 'sa'
    const handle = attachChatEventController(refs)
    currentHandle = handle
    await waitListeners()

    const owner = { profileId: 'p1', agentId: 'peri', localSessionId: A }
    const canonical = (sequence: number, update: Record<string, unknown>) => normalizeRawEvent(
      { source: A, update },
      { owner, clientGeneration: 7, sequence, receivedAt: '2026-08-21T00:00:00.000Z' },
    ).event
    const fireCommitted = (event: unknown, payload: Record<string, unknown>) => {
      fire(payload.eventName as string, { ...payload, canonicalEvent: event })
    }

    handle.initSource(A, [])
    fireCommitted(canonical(1, { sessionUpdate: 'user_message_chunk', content: { text: '问题' } }), { eventName: 'pylon:user', source: A, content: '问题' })
    fireCommitted(canonical(2, { sessionUpdate: 'agent_message_chunk', content: { text: '已完成部分' } }), { eventName: 'pylon:update', source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '已完成部分' } } })
    await waitListeners()

    // 切到 B；A 仍在生成，之后的 chunk 在 A 的新 load transaction 中到达。
    refs.sessionRef.current = B
    refs.messageOwnerRef.current = 'sb'
    handle.initSource(B, [])
    refs.sessionRef.current = A
    refs.messageOwnerRef.current = 'sa'
    const canonicalBase: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '问题', time: 't' },
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '已完成部分', time: 't', running: false },
    ]
    handle.initSource(A, canonicalBase, false, true)
    const generation = handle.beginLoadLock(A)

    fireCommitted(canonical(3, { sessionUpdate: 'agent_message_chunk', content: { text: '仍在生成' } }), { eventName: 'pylon:update', source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '仍在生成' } } })
    await waitListeners()
    const resolved = handle.commitCanonicalProjection(A, generation, canonicalBase, 2)
    handle.finishLoadLock(A, generation)

    expect(resolved.map(message => message.content)).toEqual(['问题', '已完成部分'])
    expect(handle.getStreamingState(A).text).toBe('仍在生成')
    handle.dispose()
  })

  it('关闭/切换竞态：canonical 首屏暂缺用户行时保留 pending optimistic user', async () => {
    const A = 'local:session-a', B = 'local:session-b'
    useIdentityStore.setState({ sessions: [makeSession('sa', A), makeSession('sb', B)] })
    const refs = makeRefs()
    refs.sessionRef.current = A
    refs.messageOwnerRef.current = 'sa'
    const handle = attachChatEventController(refs)
    await waitListeners()

    handle.initSource(A, [])
    handle.sendOptimisticUser(A, '尚未提交的问题', 'client-msg-1')

    // 模拟切到 B 再切回 A：canonical 首屏已经有 Agent 行，但 user 行尚未完成 kernel ingest。
    refs.sessionRef.current = B
    refs.messageOwnerRef.current = 'sb'
    handle.initSource(B, [])
    refs.sessionRef.current = A
    refs.messageOwnerRef.current = 'sa'
    const canonicalBase: Message[] = [
      { id: 'msg-2', role: 'assistant', sender: 'peri', content: '回复', time: 't', running: false },
    ]
    handle.initSource(A, canonicalBase, false, true)
    const generation = handle.beginLoadLock(A)
    const resolved = handle.commitCanonicalProjection(A, generation, canonicalBase, 1)
    handle.finishLoadLock(A, generation)

    expect(resolved.map(message => message.content)).toEqual(['尚未提交的问题', '回复'])
    handle.dispose()
  })

  it('canonical 读取为空时 loadBaseFromCanonical 不生效，replay 仍为权威', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    // 空 canonical 占位（读取失败降级 / 空会话）——不能把 replay 历史丢弃
    handle.initSource(A, [], false, true)
    const gen = handle.beginLoadLock(A)
    const resolved = handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '历史问题' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '历史回复' } }),
    ])
    expect(resolved.map(m => m.content)).toEqual(['历史问题', '历史回复'])
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('replay 缺失工具事件时保留 base 中的工具卡（canonical 占位已含工具）', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    // 模拟 canonical 首屏占位：用户消息 + 已完成的工具卡都在 base 中
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '读文件', time: 't' },
      {
        id: 'tool-tc-1', role: 'tool', sender: 'tool:read', content: '', time: 't',
        toolName: 'read', toolKind: 'read_file', rawInput: { path: 'a.txt' },
        toolOutput: 'ok', toolStatus: 'completed', rawOutput: 'ok', running: false,
        externalIdentity: { toolCallId: 'tc-1' },
      },
      { id: 'thought-2', role: 'reasoning', sender: 'peri', content: '检查结果', time: 't' },
      { id: 'msg-3', role: 'assistant', sender: 'peri', content: '读完', time: 't' },
    ]
    handle.initSource(A, cached)
    expect(handle.getMessages(A)).toHaveLength(4)

    // 后端 replay 只回放 user/assistant，缺少 tool_call/tool_call_update 事件
    const gen = handle.beginLoadLock(A)
    const resolved = handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '读文件' } }),
      replayUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: '检查结果' } }),
      replayUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '读完' } }),
    ])
    const toolCards = resolved.filter(m => m.role === 'tool')
    expect(toolCards).toHaveLength(1)
    expect(toolCards[0].externalIdentity?.toolCallId).toBe('tc-1')
    expect(toolCards[0].toolName).toBe('read')
    expect(toolCards[0].rawInput).toEqual({ path: 'a.txt' })
    expect(resolved.map(message => message.role)).toEqual(['user', 'tool', 'reasoning', 'assistant'])
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('replay 只有 tool_call_update 时把 base 完整工具卡字段补进占位卡', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    // base（canonical 占位/内存态）持有完整工具卡：title/kind/rawInput 齐全
    const cached: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '读文件', time: 't' },
      {
        id: 'tool-tc-1', role: 'tool', sender: 'tool:read', content: '', time: 't',
        toolName: 'read', toolKind: 'read_file', toolInput: 'a.txt', rawInput: { path: 'a.txt' },
        toolOutput: 'ok', toolStatus: 'completed', rawOutput: 'ok', running: false,
        externalIdentity: { toolCallId: 'tc-1' },
      },
    ]
    handle.initSource(A, cached)

    // replay 只回放 user + tool_call_update（缺 tool_call started）
    const gen = handle.beginLoadLock(A)
    const resolved = handle.commitReplaySnapshot(A, gen, [
      replayUpdate({ sessionUpdate: 'user_message_chunk', content: { text: '读文件' } }),
      replayUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', rawOutput: 'ok', status: 'completed' }),
    ])
    const toolCards = resolved.filter(m => m.role === 'tool')
    expect(toolCards).toHaveLength(1)
    expect(toolCards[0].externalIdentity?.toolCallId).toBe('tc-1')
    expect(toolCards[0].toolName).toBe('read')
    expect(toolCards[0].rawInput).toEqual({ path: 'a.txt' })
    expect(toolCards[0].rawOutput).toBe('ok')
    expect(toolCards[0].toolStatus).toBe('completed')
    handle.finishLoadLock(A, gen)
    handle.dispose()
  })

  it('canonical 占位重建既有 source 时保持回合顺序并清除陈旧 running 状态', async () => {
    const A = 'local:session-a'
    useIdentityStore.setState({ sessions: [makeSession('sa', A)] })
    const handle = attachChatEventController(makeRefs())
    currentHandle = handle
    await waitListeners()

    handle.initSource(A, [])
    // 切走前只留下未收敛 assistant。旧 mergeBase 会把它放到 canonical
    // user/reasoning 之前，并继续保留 running=true。
    fire('pylon:update', { source: A, update: { sessionUpdate: 'agent_message_chunk', content: { text: '回复' } } })
    expect(handle.getMessages(A)[0]).toMatchObject({ role: 'assistant', running: true })

    const canonical: Message[] = [
      { id: 'user-1', role: 'user', sender: A, content: '问题', time: 't' },
      { id: 'thought-2', role: 'reasoning', sender: 'peri', content: '思考', time: 't', running: true },
      { id: 'msg-3', role: 'assistant', sender: 'peri', content: '回复', time: 't', running: true },
    ]
    const returned = handle.initSource(A, canonical, false, true)

    expect(returned.map(message => message.role)).toEqual(['user', 'reasoning', 'assistant'])
    expect(returned.every(message => message.running === false)).toBe(true)
    handle.dispose()
  })
})
