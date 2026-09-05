import { describe, expect, it, vi } from 'vitest'
import { createPreviewWorkbenchRuntime, mergeWorkbenchRuntimeSnapshot, type WorkbenchRuntimeSnapshot } from '../workbenchRuntime.ts'
import { createWorkbenchDocument, projectWorkbench } from '../workbenchProjector.ts'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import type { Message } from '../../../components/chat/messageTypes.ts'

function initial() {
  return {
    sessionId: 'session-a',
    status: 'ready' as const,
    messages: [],
    streamingText: '',
    streamingThinking: '',
    generating: false,
    generationStart: 0,
    tokenCount: 0,
    summary: null,
    tasks: [],
    availableModels: [],
    activeModel: '',
    availableModes: [],
    activeMode: 'default',
    canAttach: false,
    promptImage: false,
    error: null,
  }
}

describe('createPreviewWorkbenchRuntime', () => {
  it('原子合并终态时强制收敛 generation invariant 并封存 fence', () => {
    const runtime = createPreviewWorkbenchRuntime({ ...initial(), ownerKey: 'owner-a', generation: 1, turnEpoch: 4, generating: true, generationStart: 10 })
    const terminal = { ...createWorkbenchDocument('session-a'), revision: 9, session: { ...createWorkbenchDocument('session-a').session, status: 'completed' } }
    runtime.applyDocument(terminal, { ownerKey: 'owner-a', generation: 1, preserveGeneration: true })
    expect(runtime.getSnapshot()).toMatchObject({ generating: false, summary: null, turnEpoch: 4, terminalFence: { turnEpoch: 4 } })
    expect(runtime.getSnapshot().generationStart).toBe(0)
  })

  it('canonical terminal document cannot be revived by a stale controller patch', () => {
    const runtime = createPreviewWorkbenchRuntime({
      ...initial(), ownerKey: 'owner-a', generation: 1, turnEpoch: 4,
      generating: true, generationStart: 10,
    })
    const terminal = {
      ...createWorkbenchDocument('session-a'),
      revision: 9,
      session: { ...createWorkbenchDocument('session-a').session, status: 'completed' as const },
    }
    runtime.applyDocument(terminal, {
      ownerKey: 'owner-a', generation: 1,
      generationPatch: { generating: true, generationStart: 999, summary: null },
    })
    expect(runtime.getSnapshot()).toMatchObject({ generating: false, terminalFence: { turnEpoch: 4 } })
    expect(runtime.getSnapshot().generationStart).toBe(0)
  })

  it('keeps a terminal document closed even when the binding has no turn epoch', () => {
    const runtime = createPreviewWorkbenchRuntime({
      ...initial(), ownerKey: 'owner-a', generation: 1,
      generating: true, generationStart: 10,
    })
    const terminal = {
      ...createWorkbenchDocument('session-a'),
      revision: 9,
      session: { ...createWorkbenchDocument('session-a').session, status: 'completed' as const },
    }
    runtime.applyDocument(terminal, { ownerKey: 'owner-a', generation: 1 })
    runtime.applyDocument(terminal, {
      ownerKey: 'owner-a', generation: 1,
      generationPatch: { generating: true, generationStart: 999 },
    })
    expect(runtime.getSnapshot().generating).toBe(false)
    expect(runtime.getSnapshot().terminalFence).toBeUndefined()
  })

  it('does not infer a terminal fence from a completed text row before a delayed tool start', () => {
    const make = (sequence: number, event: 'message.delta' | 'message.completed' | 'tool.started') => createWorkbenchEnvelope({
      sessionId: 'session-a', sequence, recordedAt: `2026-08-22T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: 'source-a' }, identity: { messageId: 'message-a', toolCallId: event === 'tool.started' ? 'tool-a' : undefined },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: event === 'tool.started'
        ? { type: event, tool: { toolCallId: 'tool-a', name: 'Read' } }
        : { type: event, role: 'assistant', parts: event === 'message.delta' ? [{ kind: 'text', text: 'answer' }] : [] },
    })
    const textDone = projectWorkbench([make(1, 'message.delta'), make(2, 'message.completed')]).document
    const runtime = createPreviewWorkbenchRuntime({
      ...initial(), ownerKey: 'owner-a', generation: 1, turnEpoch: 4,
      generating: true, generationStart: 10,
    })
    runtime.applyDocument(textDone, { ownerKey: 'owner-a', generation: 1, preserveGeneration: true })
    expect(runtime.getSnapshot()).toMatchObject({ generating: true })
    expect(runtime.getSnapshot().terminalFence).toBeUndefined()
    const withTool = projectWorkbench([make(1, 'message.delta'), make(2, 'message.completed'), make(3, 'tool.started')]).document
    runtime.applyDocument(withTool, { ownerKey: 'owner-a', generation: 1, preserveGeneration: true })
    expect(runtime.getSnapshot()).toMatchObject({ generating: true })
  })

  it('新 turnEpoch 清除旧 summary/fence，late active patch 不能复活旧回合', () => {
    const base = { ...initial(), revision: 0, ownerKey: 'owner-a', generation: 1, turnEpoch: 2, generating: false, summary: { elapsedMs: 1, tokenCount: 1, completedFrame: '', reason: 'done' as const }, terminalFence: { turnEpoch: 2 } }
    const next = mergeWorkbenchRuntimeSnapshot(base, { turnEpoch: 3, generationPatch: { generating: true, generationStart: 100 } })
    expect(next).toMatchObject({ turnEpoch: 3, generating: true, summary: null })
    expect(next.terminalFence).toBeUndefined()
  })

  it('旧 turnEpoch patch 不能回退当前回合或清除 terminal fence', () => {
    const base = {
      ...initial(), revision: 0, ownerKey: 'owner-a', generation: 1, turnEpoch: 5,
      generating: false, summary: { elapsedMs: 9, tokenCount: 2, completedFrame: '', reason: 'done' as const },
      terminalFence: { ownerKey: 'owner-a', turnEpoch: 5, sequence: 12 },
    }
    const next = mergeWorkbenchRuntimeSnapshot(base, {
      turnEpoch: 4,
      terminalFence: null,
      generationPatch: { generating: true, generationStart: 100 },
    })
    expect(next.turnEpoch).toBe(5)
    expect(next.terminalFence).toMatchObject({ turnEpoch: 5, sequence: 12 })
    expect(next.summary).toMatchObject({ reason: 'done' })
    expect(next.generating).toBe(false)
  })
  it('暴露只读 document view，并按 slice 局部通知', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const messages = vi.fn()
    const usage = vi.fn()
    runtime.subscribeSlice('messages', messages)
    runtime.subscribeSlice('usage', usage)

    expect(runtime.getSnapshot().document).toBeDefined()
    expect(Object.isFrozen(runtime.getSnapshot().document)).toBe(true)
    runtime.update({ tokenCount: 1 })
    expect(messages).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
    runtime.update({ messages: [{ id: 'm1', role: 'assistant', sender: 'peri', content: 'hello', time: '10:00' }] })
    expect(messages).toHaveBeenCalledTimes(1)
    expect(usage).not.toHaveBeenCalled()
  })

  it('输出冻结 snapshot，只在内容变化时 bump revision', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const listener = vi.fn()
    runtime.subscribe(listener)
    const first = runtime.getSnapshot()

    runtime.update({ tokenCount: 0 })
    expect(runtime.getSnapshot()).toBe(first)
    expect(listener).not.toHaveBeenCalled()

    runtime.update({ tokenCount: 4, generating: true })
    expect(runtime.getSnapshot()).toMatchObject({ revision: 1, tokenCount: 4, generating: true })
    expect(Object.isFrozen(runtime.getSnapshot())).toBe(true)
    expect(Object.isFrozen(runtime.getSnapshot().messages)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('deep-freezes renderer-facing canonical message payloads', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const document = projectWorkbench([createWorkbenchEnvelope({
      sessionId: 'session-a', sequence: 1, recordedAt: '2026-08-25T00:00:00.000Z',
      source: { provider: 'peri', sourceId: 'deep-freeze' }, identity: { messageId: 'm-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'immutable' }] },
    })]).document

    runtime.replaceDocument(document, { ownerKey: 'owner-a', generation: 1 })
    const message = runtime.getSnapshot().document!.messages[0]!
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.parts)).toBe(true)
    expect(Object.isFrozen(message.parts[0])).toBe(true)
    expect(Object.isFrozen(message.identity)).toBe(true)
    expect(Object.isFrozen(message.source)).toBe(true)
  })

  it('destroy 幂等并停止后续通知', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const listener = vi.fn()
    runtime.subscribe(listener)
    runtime.destroy()
    runtime.destroy()
    runtime.update({ tokenCount: 10 })

    expect(listener).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().tokenCount).toBe(0)
  })

  it('Bug4：流式高频更新不再全量序列化整个快照，大历史下 streamingText 更新照常广播', () => {
    // 旧实现每次 update 都对整包 JSON.stringify（含全部历史消息）判重，消息越多越慢。
    // 修复后改逐字段引用比较：messages 引用未变时不序列化，streamingText/tokenCount 高频更新
    // 仍是 O(1)，且语义不变（变化才 bump revision、才通知）。
    const big: WorkbenchRuntimeSnapshot = {
      ...initial(),
      revision: 0,
      messages: Array.from({ length: 1000 }, (_, i): Message => ({
        id: `m-${i}`, role: (i % 2 ? 'assistant' : 'user') as Message['role'],
        content: '一段较长的历史回复内容'.repeat(5), running: false, time: '12:00:00', sender: 'peri',
      })),
      tasks: Array.from({ length: 200 }, (_, i) => ({
        id: `t-${i}`, status: 'completed', content: '任务内容'.repeat(10), title: 'tool',
      })),
    }

    // 打桩：记录 JSON.stringify 是否被以"含非空 messages 的整包"调用（即是否又回退全量序列化）。
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    const serializedWholeSnapshot = () => stringifySpy.mock.calls.some(([value]) => {
      const obj = value as Record<string, unknown> | null
      return !!obj && Array.isArray(obj.messages) && obj.messages.length > 0
    })

    const runtime = createPreviewWorkbenchRuntime(big)
    const listener = vi.fn()
    runtime.subscribe(listener)

    // 多次模拟流式 tick：只改 tokenCount（P52 D5 后 canonical 行更新走 applyDocument）。
    for (let t = 1; t <= 50; t++) {
      runtime.update({ tokenCount: t })
    }

    expect(listener).toHaveBeenCalledTimes(50)
    expect(runtime.getSnapshot().revision).toBe(50)
    // 全程不得对含 1000 条消息的整包做 JSON.stringify（避免 O(n) 拖慢流式）。
    expect(serializedWholeSnapshot()).toBe(false)
    stringifySpy.mockRestore()
  })

  it('live/replay 共用 apply/replace，并拒绝旧 owner generation 的迟到 document', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const oldDocument = { ...createWorkbenchDocument('session-a'), revision: 1 }
    const currentDocument = { ...createWorkbenchDocument('session-b'), revision: 2 }
    runtime.replaceDocument(currentDocument, { ownerKey: 'owner-b', generation: 3, sessionId: 'session-b' })
    const revision = runtime.getSnapshot().revision
    runtime.applyDocument(oldDocument, { ownerKey: 'owner-b', generation: 2 })
    expect(runtime.getSnapshot().sessionId).toBe('session-b')
    expect(runtime.getSnapshot().document?.sessionId).toBe('session-b')
    expect(runtime.getSnapshot().revision).toBe(revision)
    runtime.applyDocument({ ...currentDocument, revision: 4 }, { ownerKey: 'owner-b', generation: 3 })
    expect(runtime.getSnapshot().document?.revision).toBe(4)
    runtime.replaceDocument(oldDocument, { ownerKey: 'owner-a', generation: 1, sessionId: 'session-a' })
    expect(runtime.getSnapshot().ownerKey).toBe('owner-a')
    expect(runtime.getSnapshot().generation).toBe(1)
  })

  it('替换到空闲文档时清理上一会话遗留的生成活动轴', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    runtime.update({
      generating: true,
      generationActivity: {
        kind: 'tooling',
        activeTools: [{ id: 'read-1', name: 'Read' }],
      },
    })

    runtime.replaceDocument(createWorkbenchDocument('session-b'), {
      ownerKey: 'owner-b', generation: 2, sessionId: 'session-b',
    })

    expect(runtime.getSnapshot()).toMatchObject({
      sessionId: 'session-b', generating: false,
      generationActivity: undefined,
    })
  })

  it('活动文档缺少时间戳时不把经过时间重置为当前时刻', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const start = 1_700_000_000_000
    const now = start + 47_000
    runtime.update({
      generating: true,
      generationStart: start,
      lastTokenAt: start + 12_000,
      generationPhase: { kind: 'thinking' },
    })

    vi.spyOn(Date, 'now').mockReturnValue(now)
    const base = createWorkbenchDocument('session-a')
    runtime.applyDocument({
      ...base,
      session: { ...base.session, status: 'running' },
    }, { ownerKey: undefined, generation: undefined, preserveGeneration: true })

    expect(runtime.getSnapshot()).toMatchObject({
      generating: true,
      generationStart: start,
      lastTokenAt: start + 12_000,
    })
  })

  it('session switch 保留新会话 pending interaction，且拒绝旧 owner/generation 串入', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const sessionA = { ...createWorkbenchDocument('session-a'), revision: 4, interactions: [{
      id: 'approval-a', status: 'requested' as const, request: { prompt: 'A?' }, sequence: 4,
    }] }
    const sessionB = { ...createWorkbenchDocument('session-b'), revision: 7, interactions: [{
      id: 'approval-b', status: 'requested' as const, request: { prompt: 'B?' }, sequence: 7,
    }] }

    runtime.replaceDocument(sessionA, { ownerKey: 'owner-a', generation: 4 })
    runtime.replaceDocument(sessionB, { ownerKey: 'owner-b', generation: 7 })
    runtime.applyDocument({ ...sessionA, revision: 8 }, { ownerKey: 'owner-a', generation: 4 })

    expect(runtime.getSlice('interactions')).toEqual([expect.objectContaining({ id: 'approval-b', status: 'requested' })])
    expect(runtime.getSnapshot()).toMatchObject({ ownerKey: 'owner-b', generation: 7, sessionId: 'session-b' })
  })

  it('document selector 对 timeline/activity/interaction/session/diagnostics 保持局部通知', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const initialDocument = { ...createWorkbenchDocument('session-a'), session: { ...createWorkbenchDocument('session-a').session, status: 'ready' } }
    runtime.replaceDocument(initialDocument, { ownerKey: 'owner-a', generation: 1 })
    const listeners = {
      timeline: vi.fn(), activities: vi.fn(), interactions: vi.fn(), session: vi.fn(), diagnostics: vi.fn(),
    }
    for (const [slice, listener] of Object.entries(listeners)) runtime.subscribeSlice(slice as 'timeline', listener)
    const current = runtime.getSnapshot().document!
    runtime.applyDocument({ ...current, timeline: [...current.timeline, { id: 'evt-1', sequence: 1, eventId: 'evt-1', kind: 'assist' }] }, { ownerKey: 'owner-a', generation: 1 })
    expect(listeners.timeline).toHaveBeenCalledTimes(1)
    expect(listeners.activities).not.toHaveBeenCalled()
    expect(listeners.interactions).not.toHaveBeenCalled()
    expect(listeners.session).not.toHaveBeenCalled()
    expect(listeners.diagnostics).not.toHaveBeenCalled()
  })

  it('暴露 plan、goal、assist 语义 slice，并只通知受影响的 slice', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const plan = vi.fn()
    const goal = vi.fn()
    const assist = vi.fn()
    runtime.subscribeSlice('plan', plan)
    runtime.subscribeSlice('goal', goal)
    runtime.subscribeSlice('assist', assist)
    const document = createWorkbenchDocument('session-a')
    runtime.replaceDocument({
      ...document,
      plan: { ...document.plan, entries: [{ id: 'p1', content: 'ship', status: 'in_progress' }] },
      goal: { current: { goalId: 'g1', objective: 'ship', status: 'active' } },
      assist: { prediction: { placeholder: 'hint', actions: [] }, files: [] },
    }, { ownerKey: 'owner-a', generation: 1 })
    expect(runtime.getSlice('plan')).toMatchObject({ entries: [{ id: 'p1' }] })
    expect(runtime.getSlice('goal')).toMatchObject({ goalId: 'g1' })
    expect(runtime.getSlice('assist')).toMatchObject({ prediction: { placeholder: 'hint' }, files: [] })
    expect(plan).toHaveBeenCalledTimes(1)
    expect(goal).toHaveBeenCalledTimes(1)
    expect(assist).toHaveBeenCalledTimes(1)
  })

  it('freezes every nested C14 session and assist value exposed through the runtime', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const document = createWorkbenchDocument('session-a')
    runtime.replaceDocument({
      ...document,
      session: {
        ...document.session,
        usage: { inputTokens: 1, budget: { used: 1, limit: 2 }, raw: { future: { value: 1 } } },
        commands: [{ id: 'review', name: '/review', raw: { future: { value: 1 } } }],
        options: [{ id: 'model', label: 'Model', value: { id: 'gpt-5' }, schema: { options: ['gpt-5'] }, raw: { future: { value: 1 } } }],
      },
      assist: { prediction: { placeholder: 'hint', actions: [{ id: 'accept' }] }, files: ['src/a.ts'] },
    }, { ownerKey: 'owner-a', generation: 1 })

    const snapshot = runtime.getSnapshot().document!
    expect(Object.isFrozen(snapshot.session.usage)).toBe(true)
    expect(Object.isFrozen(snapshot.session.usage?.budget)).toBe(true)
    expect(Object.isFrozen(snapshot.session.usage?.raw?.future)).toBe(true)
    expect(Object.isFrozen(snapshot.session.commands[0])).toBe(true)
    expect(Object.isFrozen(snapshot.session.commands[0]?.raw?.future)).toBe(true)
    expect(Object.isFrozen(snapshot.session.options[0])).toBe(true)
    expect(Object.isFrozen(snapshot.session.options[0]?.value)).toBe(true)
    expect(Object.isFrozen(snapshot.session.options[0]?.schema)).toBe(true)
    expect(Object.isFrozen(snapshot.assist.prediction)).toBe(true)
    expect(Object.isFrozen(snapshot.assist.prediction?.actions)).toBe(true)
    expect(Object.isFrozen(snapshot.assist.prediction?.actions[0])).toBe(true)
  })

  it('以同一 document 暴露 commands/config selector，并保持 session switch 后旧 generation 隔离', () => {
    const runtime = createPreviewWorkbenchRuntime(initial())
    const commands = vi.fn()
    const config = vi.fn()
    runtime.subscribeSlice('commands', commands)
    runtime.subscribeSlice('config', config)
    const document = createWorkbenchDocument('session-a')
    runtime.replaceDocument({
      ...document,
      session: {
        ...document.session,
        commands: [{ id: 'compact', name: '/compact', description: 'Compact' }],
        options: [{ id: 'mode', label: 'Mode', value: 'fast', editable: true }],
      },
    }, { ownerKey: 'owner-a', generation: 4 })
    expect(runtime.getSlice('commands')).toEqual([{ id: 'compact', name: '/compact', description: 'Compact' }])
    expect(runtime.getSlice('config')).toEqual([{ id: 'mode', label: 'Mode', value: 'fast', editable: true }])
    expect(commands).toHaveBeenCalledTimes(1)
    expect(config).toHaveBeenCalledTimes(1)

    const sessionB = createWorkbenchDocument('session-b')
    runtime.replaceDocument(sessionB, { ownerKey: 'owner-b', generation: 5 })
    const revision = runtime.getSnapshot().revision
    runtime.applyDocument({ ...document, revision: 99 }, { ownerKey: 'owner-a', generation: 4 })
    expect(runtime.getSnapshot().sessionId).toBe('session-b')
    expect(runtime.getSnapshot().revision).toBe(revision)
  })
})
