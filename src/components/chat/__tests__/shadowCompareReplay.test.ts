// @vitest-environment jsdom
/**
 * EVT-05 验收（§5.10 迁移原则 4/7）：shadow compare 新旧投影。
 * 新投影 = canonical 事件投影（normalizeRawEvent → ToolProjection）；
 * 旧投影 = 既有 UI 工具消息（迁移源）。
 * 驱动真实 controller（replay / live），断言 canonical 投影无损复现 UI 消息
 * （零 mismatch / 零 orphanOld），并验证迁移 marker 推进。
 */
import { describe, expect, it, vi } from 'vitest'

const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, payload => handler({ payload }))
    return Promise.resolve(() => listeners.delete(event))
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve({})) }))

import { attachChatEventController, type ChatEventControllerRefs } from '../chatEventController'
import { useIdentityStore, type Session } from '../../../identityStore'
import { useRuntimeStore } from '../../../runtimeStore'
import { normalizeRawEvent } from '../../../domains/events/canonicalNormalizer'
import { createMigrationMarker, recordMigrationResult, shadowCompareToolProjections } from '../../../domains/events/shadowCompare'
import type { CanonicalConversationEvent, CanonicalEventOwner } from '../../../domains/events/eventSchema'
import type { Message } from '../messageTypes'

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
    id: 'session-shadow', agentId: 'peri', source, name: 'shadow', profileId: 'profile',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

async function waitListeners(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

const source = 'local:shadow-compare'
const owner: CanonicalEventOwner = { profileId: 'profile', agentId: 'peri', localSessionId: source }
const GENERATION = 7

const toolCallWire: Record<string, unknown> = {
  sessionUpdate: 'tool_call',
  toolCallId: 'tc-shadow',
  title: 'Read',
  kind: 'read_file',
  rawInput: { path: 'a.txt', mode: 'r' },
  content: [{ type: 'text', text: 'preview' }],
}
const toolUpdateWire: Record<string, unknown> = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'tc-shadow',
  rawOutput: { ok: true },
  status: 'completed',
}

const replayRaw = (update: Record<string, unknown>): unknown =>
  ({ sessionId: 'peri-session', update: { ...update, _meta: { periReplay: true } } })
const liveRaw = (update: Record<string, unknown>): unknown => ({ source, update })

function canonicalEvents(raws: readonly unknown[]): CanonicalConversationEvent[] {
  return raws.map((raw, index) => normalizeRawEvent(raw, {
    owner, clientGeneration: GENERATION, sequence: index + 1, receivedAt: '2026-08-14T00:00:00.000Z',
  }).event)
}

function toolMessages(handle: { getMessages: (s: string) => Message[] }): Message[] {
  return handle.getMessages(source).filter(message => message.role === 'tool')
}

describe('shadow compare 新旧投影（§5.10 迁移原则 4/7）', () => {
  it('replay 路径：canonical 投影无损复现 UI 工具消息（零 mismatch / 零 orphan）', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, GENERATION)
    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [replayRaw(toolCallWire), replayRaw(toolUpdateWire)])
    handle.finishLoadLock(source, gen)

    const report = shadowCompareToolProjections(
      canonicalEvents([replayRaw(toolCallWire), replayRaw(toolUpdateWire)]),
      toolMessages(handle),
      { owner, clientGeneration: GENERATION },
    )
    // 生命周期（started+completed）合并后与 UI 终态 1:1 一致
    expect(report.matched).toBe(1)
    expect(report.mismatched).toEqual([])
    expect(report.orphanNew).toEqual([])
    expect(report.orphanOld).toEqual([])

    // 迁移 marker：零 critical → shadow-verified
    const marker = recordMigrationResult(createMigrationMarker(), report)
    expect(marker.status).toBe('shadow-verified')
    handle.dispose()
  })

  it('live 路径：canonical 投影与 UI 工具消息一致', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, GENERATION)
    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    handle.handleStreamFrame({ event: 'pylon:update', payload: liveRaw(toolCallWire) })
    handle.handleStreamFrame({ event: 'pylon:update', payload: liveRaw(toolUpdateWire) })

    const report = shadowCompareToolProjections(
      canonicalEvents([liveRaw(toolCallWire), liveRaw(toolUpdateWire)]),
      toolMessages(handle),
      { owner, clientGeneration: GENERATION },
    )
    expect(report.matched).toBe(1)
    expect(report.mismatched).toEqual([])
    expect(report.orphanNew).toEqual([])
    expect(report.orphanOld).toEqual([])
    handle.dispose()
  })

  it('对照非空跑：UI 消息被篡改（旧投影 status 不一致）→ 报告 mismatch 且 marker failed', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, GENERATION)
    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [replayRaw(toolCallWire), replayRaw(toolUpdateWire)])
    handle.finishLoadLock(source, gen)

    // 模拟旧投影与 canonical 不一致：UI 消息 status 被改（拷贝，不改 runtime）
    const staleMessages = toolMessages(handle).map(message => ({ ...message, toolStatus: 'failed' }))
    const report = shadowCompareToolProjections(
      canonicalEvents([replayRaw(toolCallWire), replayRaw(toolUpdateWire)]),
      staleMessages,
      { owner, clientGeneration: GENERATION },
    )
    expect(report.matched).toBe(0)
    expect(report.mismatched).toHaveLength(1)
    expect(report.mismatched[0]?.diffs.some(diff => diff.field === 'status')).toBe(true)
    const marker = recordMigrationResult(createMigrationMarker(), report)
    expect(marker.status).toBe('failed')
    expect(marker.retries).toBe(1)
    handle.dispose()
  })
})
