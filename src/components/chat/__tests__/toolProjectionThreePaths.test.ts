// @vitest-environment jsdom
/**
 * EVT-04 验收（§5.11）：同一个 ACP tool event 经 live、replay、restart 三条路径
 * 落为 tool Message 后，最终 ToolProjection 的 9 字段深等：
 *   toolCallId / toolName(title) / kind / rawInput / rawOutput / status / contentBlocks /
 *   owner / clientGeneration。
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
import { projectToolFromMessage, type ToolProjection } from '../../../domains/events/toolProjection'
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
    id: 'session-three-path', agentId: 'peri', source, name: 'three-path', profileId: 'profile',
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '.', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

async function waitListeners(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 20))
}

/** live wire：`{ source, update }`（无 periReplay meta——走全局 pylon:update）。 */
function livePayload(update: Record<string, unknown>): unknown {
  return { source, update }
}

/** replay/restart wire：`{ sessionId, update }`（periReplay meta）。 */
function replayPayload(update: Record<string, unknown>): unknown {
  return { sessionId: 'peri-session', update: { ...update, _meta: { periReplay: true } } }
}

const source = 'local:three-paths'
const owner = { profileId: 'profile', agentId: 'peri', localSessionId: source }
const CLIENT_GENERATION = 7

function toolMessage(handle: { getMessages: (s: string) => Message[] }): Message {
  const message = handle.getMessages(source).find(m => m.role === 'tool')
  expect(message).toBeDefined()
  return message!
}

/** 经 live 路径驱动同一组 ACP tool events，投影为 ToolProjection。 */
async function projectViaLive(toolCallWire: Record<string, unknown>, toolUpdateWire: Record<string, unknown>): Promise<ToolProjection | undefined> {
  const handle = attachChatEventController(refs())
  await waitListeners()
  handle.initSource(source, [])
  handle.handleStreamFrame({ event: 'pylon:update', payload: livePayload(toolCallWire) })
  handle.handleStreamFrame({ event: 'pylon:update', payload: livePayload(toolUpdateWire) })
  expect(toolMessage(handle).clientGeneration).toBe(CLIENT_GENERATION)
  const projection = projectToolFromMessage(toolMessage(handle), owner, CLIENT_GENERATION)
  handle.dispose()
  return projection
}

/** 经 replay 路径驱动同一组 ACP tool events，投影为 ToolProjection。 */
async function projectViaReplay(toolCallWire: Record<string, unknown>, toolUpdateWire: Record<string, unknown>): Promise<ToolProjection | undefined> {
  const handle = attachChatEventController(refs())
  await waitListeners()
  handle.initSource(source, [])
  const gen = handle.beginLoadLock(source)
  handle.commitReplaySnapshot(source, gen, [replayPayload(toolCallWire), replayPayload(toolUpdateWire)])
  handle.finishLoadLock(source, gen)
  expect(toolMessage(handle).clientGeneration).toBe(CLIENT_GENERATION)
  const projection = projectToolFromMessage(toolMessage(handle), owner, CLIENT_GENERATION)
  handle.dispose()
  return projection
}

describe('三路径 ToolProjection 深等（§5.11 验收：live/replay/restart 字段不丢）', () => {
  it('同一 tool_call + tool_call_update → 9 字段深等（root toolCallId + contentBlocks 数组）', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)

    const toolCallWire = {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-paths',
      title: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt', mode: 'r' },
      content: [{ type: 'text', text: 'preview' }],
    }
    const toolUpdateWire = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-paths',
      rawOutput: { ok: true, lines: 3 },
      status: 'completed',
    }

    const liveProj = await projectViaLive(toolCallWire, toolUpdateWire)
    const replayProj = await projectViaReplay(toolCallWire, toolUpdateWire)

    // restart：dispose 后全新 controller（模拟应用重启自 canonical_events 投影）。
    const restartHandle = attachChatEventController(refs())
    await waitListeners()
    restartHandle.initSource(source, [])
    const restartGen = restartHandle.beginLoadLock(source)
    restartHandle.commitReplaySnapshot(source, restartGen, [replayPayload(toolCallWire), replayPayload(toolUpdateWire)])
    restartHandle.finishLoadLock(source, restartGen)
    expect(toolMessage(restartHandle).clientGeneration).toBe(CLIENT_GENERATION)
    const restartProj = projectToolFromMessage(toolMessage(restartHandle), owner, CLIENT_GENERATION)
    restartHandle.dispose()

    // 深等：三路径投影逐字段一致
    expect(liveProj).toEqual(replayProj)
    expect(replayProj).toEqual(restartProj)
    // 非 vacuous：投影确实携带全部 9 字段且值正确
    expect(liveProj).toEqual({
      toolCallId: 'tc-paths',
      toolName: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt', mode: 'r' },
      rawOutput: { ok: true, lines: 3 },
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'preview' }],
      owner,
      clientGeneration: CLIENT_GENERATION,
    })
  })

  it('嵌套 content alias（tool_use_id）同样三路径深等', async () => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)

    const toolCallWire = {
      sessionUpdate: 'tool_call',
      content: { tool_use_id: 'tc-nested' },
      title: 'Write',
      kind: 'write_file',
      rawInput: { path: 'b.txt' },
    }
    const toolUpdateWire = {
      sessionUpdate: 'tool_call_update',
      content: { tool_use_id: 'tc-nested' },
      rawOutput: 'done',
      status: 'completed',
    }

    const liveProj = await projectViaLive(toolCallWire, toolUpdateWire)
    const replayProj = await projectViaReplay(toolCallWire, toolUpdateWire)
    expect(liveProj).toEqual(replayProj)
    expect(liveProj).toMatchObject({
      toolCallId: 'tc-nested',
      toolName: 'Write',
      kind: 'write_file',
      rawInput: { path: 'b.txt' },
      rawOutput: 'done',
      status: 'completed',
      owner,
      clientGeneration: CLIENT_GENERATION,
    })
  })
})
