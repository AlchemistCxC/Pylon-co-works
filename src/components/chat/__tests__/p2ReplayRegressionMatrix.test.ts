// @vitest-environment jsdom
/**
 * EVT-06：P2 replay 回归矩阵（方案书任务表 EVT-06，§8.1 测试验收——fixture compare）。
 *
 * 依赖 EVT-01~05（canonical schema → normalizer → ToolProjection → shadow compare）。
 * P2 问题（§1.3）：live / replay commit / 旧 replayNormalizer（已收敛删除）对 tool identity
 * 与字段解析不统一，
 * 工具消息字段在回放中损坏。本卡以数据驱动矩阵固化"同一组 ACP wire 经 live / replay / restart
 * 三条路径最终 ToolProjection 9 字段深等"的不变量（§5.11 验收 + EVT-04 三路径深等），
 * 并覆盖 P2 边角：identity 别名/嵌套/_meta、生命周期合并、update-first 占位、空串规整、
 * unknown/malformed 穿插不破坏后续工具事件（§5.10 原则 5：raw 保留不静默丢弃）、
 * 同会话多工具独立投影。
 *
 * 每例断言：
 *   live 投影 == replay 投影 == restart 投影（三路径逐字段深等，非 vacuous：与显式 expected 字面量一致）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    id: 'session-p2-matrix', agentId: 'peri', source, name: 'p2-matrix', profileId: 'profile',
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

/** replay/restart wire：`{ sessionId, update }`（periReplay meta 与 update 自带 _meta 合并，不覆盖——_meta 同时是 identity 回退层）。 */
function replayPayload(update: Record<string, unknown>): unknown {
  const existingMeta = (typeof update._meta === 'object' && update._meta !== null) ? update._meta as Record<string, unknown> : {}
  return { sessionId: 'peri-session', update: { ...update, _meta: { ...existingMeta, periReplay: true } } }
}

const source = 'local:p2-matrix'
const owner = { profileId: 'profile', agentId: 'peri', localSessionId: source }
const CLIENT_GENERATION = 7

function toolMessages(handle: { getMessages: (s: string) => Message[] }): Message[] {
  return handle.getMessages(source).filter(message => message.role === 'tool')
}

function toolMessage(handle: { getMessages: (s: string) => Message[] }): Message {
  const message = toolMessages(handle)[0]
  expect(message).toBeDefined()
  return message!
}

function projectAllTools(handle: { getMessages: (s: string) => Message[] }): ToolProjection[] {
  return toolMessages(handle).map(message => projectToolFromMessage(message, owner, CLIENT_GENERATION)).filter((projection): projection is ToolProjection => projection !== undefined)
}

/** 三路径矩阵核心：同一组 SessionUpdate 经 live/replay/restart → 各投影 ToolProjection（含 Message 级 generation 落位断言）。 */
async function matrixProjections(wire: Array<Record<string, unknown>>): Promise<{ live: ToolProjection; replay: ToolProjection; restart: ToolProjection }> {
  // live
  const liveHandle = attachChatEventController(refs())
  await waitListeners()
  liveHandle.initSource(source, [])
  const liveUpdate = listeners.get('pylon:update')
  expect(liveUpdate).toBeDefined()
  for (const update of wire) liveUpdate!(livePayload(update))
  const liveProj = projectToolFromMessage(toolMessage(liveHandle), owner, CLIENT_GENERATION)!
  liveHandle.dispose()

  // replay
  const replayHandle = attachChatEventController(refs())
  await waitListeners()
  replayHandle.initSource(source, [])
  const replayGen = replayHandle.beginLoadLock(source)
  replayHandle.commitReplaySnapshot(source, replayGen, wire.map(replayPayload))
  replayHandle.finishLoadLock(source, replayGen)
  const replayProj = projectToolFromMessage(toolMessage(replayHandle), owner, CLIENT_GENERATION)!
  replayHandle.dispose()

  // restart：dispose 后全新 controller（模拟应用重启自 canonical_events 投影）
  const restartHandle = attachChatEventController(refs())
  await waitListeners()
  restartHandle.initSource(source, [])
  const restartGen = restartHandle.beginLoadLock(source)
  restartHandle.commitReplaySnapshot(source, restartGen, wire.map(replayPayload))
  restartHandle.finishLoadLock(source, restartGen)
  const restartProj = projectToolFromMessage(toolMessage(restartHandle), owner, CLIENT_GENERATION)!
  restartHandle.dispose()

  return { live: liveProj, replay: replayProj, restart: restartProj }
}

interface MatrixScenario {
  name: string
  /** SessionUpdate 形状，按到达顺序（tool_call / tool_call_update）。 */
  wire: Array<Record<string, unknown>>
  /** 显式 expected 字面量（非 vacuous fixture compare）。 */
  expected: ToolProjection
}

const matrixScenarios: MatrixScenario[] = [
  {
    name: '经典 root toolCallId + contentBlocks 数组（started → completed）',
    wire: [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: { path: 'a.txt' }, content: [{ type: 'text', text: 'preview' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', rawOutput: { ok: true }, status: 'completed' },
    ],
    expected: {
      toolCallId: 'tc-1',
      toolName: 'Read',
      kind: 'read_file',
      rawInput: { path: 'a.txt' },
      rawOutput: { ok: true },
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'preview' }],
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: '嵌套 content.tool_use_id 别名（Peri 嵌套 wire）',
    wire: [
      { sessionUpdate: 'tool_call', content: { tool_use_id: 'tc-n' }, title: 'Write', kind: 'write_file', rawInput: '{"path":"b"}' },
      { sessionUpdate: 'tool_call_update', content: { tool_use_id: 'tc-n' }, rawOutput: 'done', status: 'completed' },
    ],
    expected: {
      toolCallId: 'tc-n',
      toolName: 'Write',
      kind: 'write_file',
      rawInput: '{"path":"b"}',
      rawOutput: 'done',
      status: 'completed',
      contentBlocks: { tool_use_id: 'tc-n' },
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: 'root snake_case 别名（tool_call_id / tool_use_id）',
    wire: [
      { sessionUpdate: 'tool_call', tool_call_id: 'tc-s', title: 'Run', kind: 'bash', rawInput: 'ls' },
      { sessionUpdate: 'tool_call_update', tool_use_id: 'tc-s', rawOutput: 'out', status: 'completed' },
    ],
    expected: {
      toolCallId: 'tc-s',
      toolName: 'Run',
      kind: 'bash',
      rawInput: 'ls',
      rawOutput: 'out',
      status: 'completed',
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: '_meta 回退层 toolUseId',
    wire: [
      { sessionUpdate: 'tool_call', _meta: { toolUseId: 'tc-m' }, title: 'Meta', kind: 'm', rawInput: {} },
      { sessionUpdate: 'tool_call_update', _meta: { tool_use_id: 'tc-m' }, rawOutput: 'r', status: 'completed' },
    ],
    expected: {
      toolCallId: 'tc-m',
      toolName: 'Meta',
      kind: 'm',
      rawInput: {},
      rawOutput: 'r',
      status: 'completed',
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: '空串 title/kind 规整（UI 回退 ?，三路径一致）',
    wire: [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-e', title: '', kind: '', rawInput: {} },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-e', rawOutput: 'r', status: 'completed' },
    ],
    expected: {
      toolCallId: 'tc-e',
      toolName: '?',
      kind: undefined,
      rawInput: {},
      rawOutput: 'r',
      status: 'completed',
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: 'update-first 占位（update 先到 → call 补全同一张卡）',
    wire: [
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-u', rawOutput: 'early', status: 'completed' },
      { sessionUpdate: 'tool_call', toolCallId: 'tc-u', title: 'Late', kind: 'read', rawInput: { x: 1 } },
    ],
    expected: {
      toolCallId: 'tc-u',
      toolName: 'Late',
      kind: 'read',
      rawInput: { x: 1 },
      rawOutput: 'early',
      status: 'completed',
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: '三阶段生命周期（started → running → completed，后到覆盖）',
    wire: [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-3', title: 'Multi', kind: 'multi', rawInput: { a: 1 }, content: [{ type: 'text', text: 'x' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', status: 'running', rawOutput: 'partial' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-3', rawOutput: 'final', status: 'completed' },
    ],
    expected: {
      toolCallId: 'tc-3',
      toolName: 'Multi',
      kind: 'multi',
      rawInput: { a: 1 },
      rawOutput: 'final',
      status: 'completed',
      contentBlocks: [{ type: 'text', text: 'x' }],
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
  {
    name: 'failed 终态',
    wire: [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-f', title: 'Fail', kind: 'f', rawInput: {} },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-f', rawOutput: 'err', status: 'failed' },
    ],
    expected: {
      toolCallId: 'tc-f',
      toolName: 'Fail',
      kind: 'f',
      rawInput: {},
      rawOutput: 'err',
      status: 'failed',
      owner,
      clientGeneration: CLIENT_GENERATION,
    },
  },
]

describe('P2 replay 回归矩阵（§8.1 fixture compare：live/replay/restart 三路径 ToolProjection 深等）', () => {
  beforeEach(() => {
    useIdentityStore.setState({ sessions: [makeSession(source)] })
    useRuntimeStore.getState().setBindingGeneration({ agentId: 'peri', source }, CLIENT_GENERATION)
  })

  it.each(matrixScenarios)('$name', async scenario => {
    const { live, replay, restart } = await matrixProjections(scenario.wire)
    // 三路径逐字段深等
    expect(live).toEqual(replay)
    expect(replay).toEqual(restart)
    // 非 vacuous：与显式 expected 字面量一致
    expect(live).toEqual(scenario.expected)
  })

  it('unknown 事件穿插不破坏三路径工具投影；replay/restart raw 保留（§5.10 原则 5）', async () => {
    const toolCall = { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: {} }
    const unknown = { sessionUpdate: 'future_update', value: 1 }
    const toolUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', rawOutput: 'r', status: 'completed' }
    const { live, replay, restart } = await matrixProjections([toolCall, unknown, toolUpdate])
    expect(live).toEqual(replay)
    expect(replay).toEqual(restart)
    expect(live.toolCallId).toBe('tc-1')
    expect(live.rawOutput).toBe('r')

    // replay/restart 路径：unknown 条目进入 malformedReplayEvents（raw 保留，不静默丢弃）
    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [replayPayload(toolCall), replayPayload(unknown), replayPayload(toolUpdate)])
    handle.finishLoadLock(source, gen)
    const malformed = handle.getReplayMalformedEvents()
    expect(malformed.some(entry => (entry.raw as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate === 'future_update')).toBe(true)
    handle.dispose()
  })

  it('malformed 条目穿插不破坏工具投影；raw 原样保留（§5.10 原则 5）', async () => {
    const toolCall = { sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Read', kind: 'read_file', rawInput: {} }
    const toolUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', rawOutput: 'r', status: 'completed' }

    const handle = attachChatEventController(refs())
    await waitListeners()
    handle.initSource(source, [])
    // 中间穿插一条非对象 malformed 原始条目
    const gen = handle.beginLoadLock(source)
    handle.commitReplaySnapshot(source, gen, [replayPayload(toolCall), 'garbage-not-an-object', replayPayload(toolUpdate)])
    handle.finishLoadLock(source, gen)
    const tools = toolMessages(handle)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ id: 'tool-tc-1', toolStatus: 'completed', toolOutput: 'r' })
    const malformed = handle.getReplayMalformedEvents()
    expect(malformed.some(entry => entry.raw === 'garbage-not-an-object')).toBe(true)
    handle.dispose()
  })

  it('同会话多个工具调用各自独立投影（不串卡）', async () => {
    const wire = [
      { sessionUpdate: 'tool_call', toolCallId: 'tc-a', title: 'A', kind: 'a', rawInput: { i: 1 } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-a', rawOutput: 'oa', status: 'completed' },
      { sessionUpdate: 'tool_call', toolCallId: 'tc-b', title: 'B', kind: 'b', rawInput: { i: 2 } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc-b', rawOutput: 'ob', status: 'completed' },
    ]

    // live
    const liveHandle = attachChatEventController(refs())
    await waitListeners()
    liveHandle.initSource(source, [])
    const liveUpdate = listeners.get('pylon:update')
    expect(liveUpdate).toBeDefined()
    for (const update of wire) liveUpdate!(livePayload(update))
    const liveProjs = projectAllTools(liveHandle)
    liveHandle.dispose()

    // replay
    const replayHandle = attachChatEventController(refs())
    await waitListeners()
    replayHandle.initSource(source, [])
    const replayGen = replayHandle.beginLoadLock(source)
    replayHandle.commitReplaySnapshot(source, replayGen, wire.map(replayPayload))
    replayHandle.finishLoadLock(source, replayGen)
    const replayProjs = projectAllTools(replayHandle)
    replayHandle.dispose()

    expect(liveProjs).toHaveLength(2)
    expect(liveProjs).toEqual(replayProjs)
    expect(liveProjs.map(projection => projection.toolCallId)).toEqual(['tc-a', 'tc-b'])
    expect(liveProjs[0]).toMatchObject({ toolCallId: 'tc-a', toolName: 'A', rawOutput: 'oa', status: 'completed', owner, clientGeneration: CLIENT_GENERATION })
    expect(liveProjs[1]).toMatchObject({ toolCallId: 'tc-b', toolName: 'B', rawOutput: 'ob', status: 'completed', owner, clientGeneration: CLIENT_GENERATION })
  })
})
