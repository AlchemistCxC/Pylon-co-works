// @vitest-environment jsdom
/**
 * A1-c P3 parity：同一组 live wire 经 normalizeRawEvent 投影的 Message[]，
 * 与 commitReplaySnapshot 重放产物逐字段一致（时间戳归一）。
 */
import { describe, expect, it, vi } from 'vitest'

const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, payload => handler({ payload }))
    return Promise.resolve(() => listeners.delete(event))
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }))

import { attachChatEventController, type ChatEventControllerRefs } from '../chatEventController'
import { useIdentityStore, type Session } from '../../../identityStore'
import { useRuntimeStore } from '../../../runtimeStore'
import { normalizeRawEvent } from '../../../domains/events/canonicalNormalizer'
import { projectMessagesFromCanonical } from '../../../domains/events/messageProjection'
import type { CanonicalEventOwner } from '../../../domains/events/eventSchema'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema'
import type { Message } from '../messageTypes'

async function waitListeners(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 100)) }

function refs(): ChatEventControllerRefs {
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
    id: 'session-projection-parity', agentId: 'peri', source, name: 'parity', profileId: 'p1',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function replayUpdate(update: Record<string, unknown>): unknown {
  return { sessionId: 'peri-session', update: { ...update, _meta: { periReplay: true } } }
}

function stripTransient(message: Message): Record<string, unknown> {
  // 时间戳字段（time/thoughtStartedAt/thoughtDurationMs）随路径取当前时间或事件时间，
  // parity 关注的是内容/顺序/身份/工具字段；undefined 键也归一（replay 显式写
  // `externalIdentity: undefined`，projection 条件展开省略该键）。
  const { time: _time, thoughtStartedAt: _thoughtStartedAt, thoughtDurationMs: _thoughtDurationMs, ...rest } = message as Message & Record<string, unknown>
  const normalized: Record<string, unknown> = { ...rest, time: '' }
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) delete normalized[key]
  }
  return normalized
}

const source = 'local:projection-parity'
const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: source }
const CLIENT_GENERATION = 7

describe('canonical 投影与 replay 产物 parity（A1-c P3）', () => {
  it('同一组 wire：projectMessagesFromCanonical == commitReplaySnapshot 产物', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)

    const wire: Array<Record<string, unknown>> = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '问题', messageId: 'u1' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回', messageId: 'a1' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '复', messageId: 'a1' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tc-p', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'preview' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-p', rawOutput: { ok: true }, status: 'completed' },
      { sessionUpdate: 'done' },
    ]

    const canonicalEvents = wire.map((update, index) => normalizeRawEvent(
      { source, update },
      { owner, clientGeneration: CLIENT_GENERATION, sequence: index + 1, receivedAt: '2026-08-14T00:00:00.000Z' },
    ).event)

    const projected = projectMessagesFromCanonical(canonicalEvents).map(stripTransient)

    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, wire.map(replayUpdate))
    handle.finishLoadLock(source, gen)
    const replayed = handle.getMessages(source).map(stripTransient)
    handle.dispose()

    expect(projected).toEqual(replayed)
    expect(projected.filter(message => message.role !== 'tool').map(message => message.content)).toEqual(['问题', '回复'])
    expect(projected.some(message => message.role === 'tool' && message.toolName === 'Read')).toBe(true)
  })

  it('无 identity 相邻 chunk：投影与 replay 都聚合为一条（修复助手消息一字一行）', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)

    const wire: Array<Record<string, unknown>> = [
      { sessionUpdate: 'user_message_chunk', content: { text: '问题' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '思' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '考' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '回' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '复' } },
      { sessionUpdate: 'done' },
    ]

    const canonicalEvents = wire.map((update, index) => normalizeRawEvent(
      { source, update },
      { owner, clientGeneration: CLIENT_GENERATION, sequence: index + 1, receivedAt: '2026-08-14T00:00:00.000Z' },
    ).event)

    const projected = projectMessagesFromCanonical(canonicalEvents).map(stripTransient)

    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, wire.map(replayUpdate))
    handle.finishLoadLock(source, gen)
    const replayed = handle.getMessages(source).map(stripTransient)
    handle.dispose()

    expect(projected).toEqual(replayed)
    expect(projected.filter(message => message.role !== 'tool').map(message => message.content)).toEqual(['问题', '思考', '回复'])
  })

  it('混合 identity 相邻 chunk：投影与 replay 都聚合成一条并采用后到 identity', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)

    const wire: Array<Record<string, unknown>> = [
      { sessionUpdate: 'user_message_chunk', content: { text: '问题' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '思', turnId: 't1' } },
      { sessionUpdate: 'agent_thought_chunk', content: { text: '考' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '回' } },
      { sessionUpdate: 'agent_message_chunk', content: { text: '复', messageId: 'm1' } },
      { sessionUpdate: 'done' },
    ]

    const canonicalEvents = wire.map((update, index) => normalizeRawEvent(
      { source, update },
      { owner, clientGeneration: CLIENT_GENERATION, sequence: index + 1, receivedAt: '2026-08-14T00:00:00.000Z' },
    ).event)

    const projected = projectMessagesFromCanonical(canonicalEvents).map(stripTransient)

    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, wire.map(replayUpdate))
    handle.finishLoadLock(source, gen)
    const replayed = handle.getMessages(source).map(stripTransient)
    handle.dispose()

    expect(projected).toEqual(replayed)
    expect(projected.filter(message => message.role !== 'tool').map(message => message.content)).toEqual(['问题', '思考', '回复'])
    expect(projected[1].externalIdentity).toEqual({ turnId: 't1' })
    expect(projected[2].externalIdentity).toEqual({ messageId: 'm1' })
  })

  it('canonical projection commit applies committed rows that raced after the repository read', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)
    const base = normalizeRawEvent(
      { source, update: { sessionUpdate: 'user_message_chunk', content: { text: 'question' } } },
      { owner, clientGeneration: CLIENT_GENERATION, sequence: 1, receivedAt: '2026-08-14T00:00:00.000Z' },
    ).event
    const late = normalizeRawEvent(
      { source, update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late' } } },
      { owner, clientGeneration: CLIENT_GENERATION, sequence: 2, receivedAt: '2026-08-14T00:00:01.000Z' },
    ).event

    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, projectMessagesFromCanonical([base]), false, true)
    handle.seedCanonicalCursor(toCanonicalOwnerKey(owner), 1)
    const generation = handle.beginLoadLock(source)
    listeners.get('pylon:update')?.({
      source,
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'late' } },
      canonicalEvent: late,
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    const committed = handle.commitCanonicalProjection(
      source,
      generation,
      projectMessagesFromCanonical([base]),
      1,
    )
    handle.finishLoadLock(source, generation)
    handle.dispose()

    expect(committed.map(message => message.content)).toEqual(['question', 'late'])
  })
})
