import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../../domains/workbench/events/workbenchEventSchema.ts'
import type { Session } from '../../../identityStore.ts'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema.ts'
import { useStore } from '../../../store.ts'

function session(id = 'session-a', source = 'local:a'): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function message(sequence: number, role: 'user' | 'assistant', text: string, sessionId = 'local:a'): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId, sequence, recordedAt: `2026-08-22T00:00:0${sequence}.000Z`,
    source: { provider: 'peri', sourceId: `source-${sequence}` },
    identity: { messageId: `message-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'message.delta', role, parts: [{ kind: 'text', text }] },
  })
}

function completedMessage(sequence: number, text: string, sessionId = 'local:a'): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId, sequence, recordedAt: `2026-08-22T00:00:0${sequence}.000Z`,
    source: { provider: 'peri', sourceId: `completed-${sequence}` },
    identity: { messageId: `completed-message-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: { type: 'message.completed', role: 'assistant', parts: [{ kind: 'text', text }] },
  })
}

function canonicalRow(sequence: number, sessionUpdate: string, fields: Record<string, unknown> = {}) {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }
  return {
    schemaVersion: 1,
    eventId: `${toCanonicalOwnerKey(owner)}#${sequence}`,
    owner,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
    clientGeneration: 1,
    sequence,
    occurredAt: `2026-08-22T00:00:0${sequence}.000Z`,
    receivedAt: `2026-08-22T00:00:0${sequence}.000Z`,
    eventType: sessionUpdate === 'user_message_chunk' ? 'user.message'
      : sessionUpdate === 'agent_message_chunk' ? 'assistant.text.delta'
        : sessionUpdate === 'agent_thought_chunk' ? 'assistant.thinking.delta'
          : sessionUpdate === 'done' ? 'turn.completed' : 'unknown',
    payloadVersion: 1,
    rawPayload: { update: { sessionUpdate, ...fields } },
  }
}

describe('Agent Workbench canonical session runtime', () => {
  it('重启后 canonical 已完成消息仍显示完成态摘要', async () => {
    const active = session('session-restored', 'local:restored')
    const controller = {
      subscribe: () => () => {},
      getGenerating: () => false,
      getStartTime: () => 0,
      getLastActivityAt: () => undefined,
      getGenerationPhase: () => undefined,
      getGenerationActivity: () => undefined,
      getThinkingStart: () => undefined,
      getTokenCount: () => 12,
      getSummary: () => undefined,
      rejectOptimisticUser: () => {},
    }
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [completedMessage(1, '已恢复完成', active.source)],
      subscribe: () => () => {},
      chatController: () => controller,
    })

    await service.bind(active)

    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: false,
      summary: { reason: 'done', elapsedMs: 0, tokenCount: 12 },
    })
    service.destroy()
  })

  it('切换会话后从 source-scoped runtime 恢复生成指示器与迟滞时钟', async () => {
    const live = new Map([
      ['local:a', { generating: true, start: 1_000, last: 4_000 }],
      ['local:b', { generating: false, start: 0, last: undefined }],
    ])
    const listeners = new Map<string, Set<() => void>>()
    const controller = {
      subscribe(source: string, listener: () => void) {
        const group = listeners.get(source) ?? new Set()
        group.add(listener); listeners.set(source, group)
        return () => group.delete(listener)
      },
      getGenerating: (source: string) => live.get(source)?.generating ?? false,
      getStartTime: (source: string) => live.get(source)?.start ?? 0,
      getLastActivityAt: (source: string) => live.get(source)?.last,
      getGenerationPhase: (source: string) => source === 'local:a' ? { kind: 'thinking' as const } : undefined,
      getThinkingStart: (source: string) => source === 'local:a' ? 1_500 : undefined,
      getTokenCount: () => 0,
      getSummary: () => undefined,
      rejectOptimisticUser: () => {},
    }
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {}, chatController: () => controller,
    })

    await service.bind(session('session-a', 'local:a'))
    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: true, generationStart: 1_000, lastTokenAt: 4_000,
      generationPhase: { kind: 'thinking' }, thinkingStart: 1_500,
    })
    await service.bind(session('session-b', 'local:b'))
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: false, generationStart: 0 })
    await service.bind(session('session-a', 'local:a'))
    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: true, generationStart: 1_000, lastTokenAt: 4_000,
      generationPhase: { kind: 'thinking' }, thinkingStart: 1_500,
    })
    service.destroy()
  })

  it('canonical 活动态投影缺少运行行时仍保持 controller 的计时起点', async () => {
    const active = session('session-clock', 'local:clock')
    const controller = {
      subscribe: () => () => {},
      getGenerating: () => true,
      getStartTime: () => 1_700_000_000_000,
      getLastActivityAt: () => 1_700_000_012_000,
      getGenerationPhase: () => ({ kind: 'thinking' as const }),
      getGenerationActivity: () => undefined,
      getThinkingStart: () => undefined,
      getTokenCount: () => 0,
      getSummary: () => undefined,
      rejectOptimisticUser: () => {},
    }
    let publish: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: listener => { publish = listener; return () => { publish = undefined } },
      chatController: () => controller,
    })
    await service.bind(active)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_047_000)

    publish?.(createWorkbenchEnvelope({
      sessionId: active.source,
      sequence: 1,
      recordedAt: '2026-08-22T00:00:01.000Z',
      source: { provider: 'peri', sourceId: 'clock-status' },
      identity: {},
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: { type: 'session.status-updated', status: 'running' },
    }))

    expect(service.runtime.getSnapshot()).toMatchObject({
      generating: true,
      generationStart: 1_700_000_000_000,
      lastTokenAt: 1_700_000_012_000,
    })
    service.destroy()
  })

  it('同一绑定身份的 Session 元数据更新不会重建流式文档', async () => {
    let loads = 0
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => { loads += 1; return [] },
      subscribe: listener => { liveEvent = listener; return () => { liveEvent = undefined } },
    })

    await service.bind(active)
    liveEvent?.(message(1, 'assistant', '流式内容'))
    const before = service.runtime.getSnapshot().document

    await service.bind({ ...active, name: '终态更新后的标题', autoName: '自动标题', lastReplyAt: 42, periId: 'remote-1', workspaceId: 'workspace-2', workdir: 'C:/workspace-2' })

    expect(loads).toBe(1)
    expect(service.runtime.getSnapshot().document).toBe(before)
    expect(service.runtime.getSnapshot().document?.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: '流式内容' }),
    ])
    service.destroy()
  })

  it('在 ACP 发送完成前把用户消息乐观投影到当前文档', async () => {
    let finishSend: (() => void) | undefined
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-optimistic-1',
        optimisticUser: () => {},
        sendMessage: () => new Promise<void>(resolve => { finishSend = resolve }),
      },
    })
    await service.bind(active)

    const sending = service.commands.send(active.id, { text: '立刻显示这条消息' })
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: true })
    expect(service.runtime.getSnapshot().document?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: '立刻显示这条消息', optimistic: true }),
    ])

    finishSend?.()
    await sending
    service.destroy()
  })

  it('authoritative user echo confirms the optimistic row without duplication', async () => {
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: listener => { liveEvent = listener; return () => {} },
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-confirm-1',
        optimisticUser: () => {}, sendMessage: async () => {},
      },
    })
    await service.bind(active)
    await service.commands.send(active.id, { text: '只出现一次' })
    liveEvent?.(message(1, 'user', '只出现一次'))

    const messages = service.runtime.getSnapshot().document?.messages ?? []
    expect(messages).toEqual([expect.objectContaining({ role: 'user', content: '只出现一次' })])
    expect(messages[0]?.optimistic).toBeUndefined()
    service.destroy()
  })

  it('相同正文连续发送时按发送顺序确认各自的 authoritative echo', async () => {
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    let clientSequence = 0
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: listener => { liveEvent = listener; return () => {} },
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => `client-repeat-${++clientSequence}`,
        optimisticUser: () => {}, sendMessage: async () => {},
      },
    })
    await service.bind(active)
    await service.commands.send(active.id, { text: '继续' })
    await service.commands.send(active.id, { text: '继续' })

    liveEvent?.(message(1, 'user', '继续'))
    const partiallyConfirmed = service.runtime.getSnapshot().document?.messages ?? []
    expect(partiallyConfirmed).toHaveLength(2)
    expect(partiallyConfirmed.map(item => item.optimistic)).toEqual([undefined, true])

    liveEvent?.(message(2, 'user', '继续'))
    const messages = service.runtime.getSnapshot().document?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages.every(item => item.role === 'user' && item.content === '继续' && item.optimistic === undefined)).toBe(true)
    service.destroy()
  })

  it('load 期间只收到一个同正文 echo 时仍保留第二条 pending optimistic row', async () => {
    let resolveLoad: ((events: readonly unknown[]) => void) | undefined
    let liveEvent: ((event: WorkbenchEventEnvelope) => void) | undefined
    let clientSequence = 0
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: () => new Promise(resolve => { resolveLoad = resolve }),
      subscribe: listener => { liveEvent = listener; return () => {} },
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => `client-buffered-${++clientSequence}`,
        optimisticUser: () => {}, sendMessage: async () => {},
      },
    })
    const binding = service.bind(active)
    await service.commands.send(active.id, { text: '继续' })
    await service.commands.send(active.id, { text: '继续' })
    liveEvent?.(message(1, 'user', '继续'))
    resolveLoad?.([])
    await binding

    const messages = service.runtime.getSnapshot().document?.messages ?? []
    expect(messages).toHaveLength(2)
    expect(messages.filter(item => item.optimistic === true)).toHaveLength(1)
    service.destroy()
  })

  it('发送被拒绝时撤销乐观行与错误生成态', async () => {
    const active = session()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {},
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-reject-1',
        optimisticUser: () => {}, sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    await expect(service.commands.send(active.id, { text: '发送失败' })).resolves.toMatchObject({ status: 'rejected' })
    expect(service.runtime.getSnapshot()).toMatchObject({ generating: false })
    expect(service.runtime.getSnapshot().document?.messages).toEqual([])
    service.destroy()
  })

  it('发送被拒绝后 source runtime 通知不能让生成指示器复活', async () => {
    let controllerGenerating = false
    let sourceListener: (() => void) | undefined
    const active = session()
    const controller = {
      subscribe: (_source: string, listener: () => void) => { sourceListener = listener; return () => {} },
      getGenerating: () => controllerGenerating,
      getStartTime: () => controllerGenerating ? 1_000 : 0,
      getLastActivityAt: () => controllerGenerating ? 1_000 : undefined,
      getGenerationPhase: () => controllerGenerating ? { kind: 'thinking' as const } : undefined,
      getThinkingStart: () => undefined,
      getTokenCount: () => 0,
      getSummary: () => undefined,
      rejectOptimisticUser: () => { controllerGenerating = false },
    }
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {}, chatController: () => controller,
      commands: {
        resolveSession: id => id === active.id ? active : undefined,
        resolvePersona: () => '', nextClientMessageId: () => 'client-reject-runtime',
        optimisticUser: () => { controllerGenerating = true },
        sendMessage: async () => { throw new Error('offline') },
      },
    })
    await service.bind(active)
    await service.commands.send(active.id, { text: '发送失败' })
    sourceListener?.()

    expect(service.runtime.getSnapshot().generating).toBe(false)
    service.destroy()
  })

  it('生产 appearance 命令经 Zustand adapter 写回主题权威', () => {
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    try {
      service.appearance.dispatch({ type: 'set-cc-property', key: 'modelVariant', value: 'minimal' })
      service.appearance.dispatch({ type: 'update-cc-placement', id: 'model', placement: { offsetX: 18 } })

      expect(useStore.getState().modelVariant).toBe('minimal')
      expect(useStore.getState().ccLayout.placements.model.offsetX).toBe(18)
      expect(service.appearance.getSnapshot()).toMatchObject({ modelVariant: 'minimal' })
    } finally {
      service.destroy()
      useStore.setState(useStore.getInitialState(), true)
    }
  })

  it('SQLite load 与 durable live event 归入同一个 WorkbenchDocument', async () => {
    let live: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [message(1, 'user', 'hello')],
      subscribe: listener => { live = listener; return () => { live = undefined } },
    })

    await service.bind(session())
    const loadedDocument = service.runtime.getSnapshot().document
    expect(loadedDocument?.messages.map(item => item.content)).toEqual(['hello'])

    live?.(message(2, 'assistant', 'world'))
    expect(service.runtime.getSnapshot().document).not.toBe(loadedDocument)
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['hello', 'world'])
    service.destroy()
  })

  it('创建响应在 bind 前到达时仍投影模型、模式与选项到 canonical Workbench 文档', async () => {
    const active = session('created-session', 'local:created')
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [], subscribe: () => () => {},
    })
    service.applySessionResponse({
      sessionId: 'remote-created',
      models: {
        currentModelId: 'openrouter:deepseek-v4-flash',
        availableModels: [
          { modelId: 'openrouter:deepseek-v4-flash', name: 'DeepSeek Flash' },
          { modelId: 'openrouter:deepseek-v4-pro', name: 'DeepSeek Pro' },
        ],
      },
      modes: {
        currentModeId: 'accept_edits',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'accept_edits', name: 'Accept Edits' },
        ],
      },
    }, active.id)
    await service.bind(active)
    const document = service.runtime.getSnapshot().document
    expect(document?.session).toMatchObject({
      status: 'ready', model: 'openrouter:deepseek-v4-flash', mode: 'accept_edits',
    })
    expect(document?.session.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model', value: 'openrouter:deepseek-v4-flash' }),
      expect.objectContaining({ id: 'mode', value: 'accept_edits' }),
    ]))
    const modelOption = document?.session.options.find(option => option.id === 'model')
    expect(modelOption?.schema).toEqual(expect.objectContaining({
      options: expect.arrayContaining([expect.objectContaining({ id: 'openrouter:deepseek-v4-pro' })]),
    }))
    service.destroy()
  })

  it('重复投影相同创建响应不会制造重复 session 事件', async () => {
    const active = session('created-idempotent', 'local:created-idempotent')
    const service = createAgentWorkbenchSessionRuntime({ loadAll: async () => [], subscribe: () => () => {} })
    await service.bind(active)
    const response = {
      sessionId: 'remote-created',
      models: { currentModelId: 'm', availableModels: ['m'] },
      modes: { currentModeId: 'default', availableModes: ['default'] },
    }
    service.applySessionResponse(response, active.id)
    service.applySessionResponse(response, active.id)
    expect(service.runtime.getSnapshot().document?.timeline.filter(item => item.kind === 'session')).toHaveLength(1)
    service.destroy()
  })

  it('真实 schemaVersion=1 canonical SQLite 行经 normalizer 投影而非误当 Workbench envelope', async () => {
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [
        canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: 'canonical user' } }),
        canonicalRow(2, 'plan', { entries: [{ id: 'task-1', content: '接通生产计划', status: 'blocked', blockedReason: '等待输入' }] }),
      ],
      subscribe: () => () => {},
    })

    await service.bind(session())

    expect(service.runtime.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['canonical user'])
    expect(service.runtime.getSnapshot().document?.plan.entries).toEqual([
      expect.objectContaining({ id: 'task-1', content: '接通生产计划', status: 'blocked', blockedReason: '等待输入' }),
    ])
    service.destroy()
  })

  it('生产 journal 重建会折叠用户双写、聚合 chunk、settle 终态，重复 bind 不累积', async () => {
    const rows = [
      {
        ...canonicalRow(1, 'user_message_chunk', {
          content: { type: 'text', text: 'one prompt' },
          _meta: { pylonOptimisticUser: true, requestId: 'client-1' },
        }),
        provenance: { origin: 'migration', trust: 'unverified', provider: 'peri' },
      },
      {
        ...canonicalRow(2, 'user_message_chunk', { content: { type: 'text', text: 'one prompt' } }),
        provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
      },
      canonicalRow(3, 'agent_thought_chunk', { content: { type: 'text', text: 'think-' } }),
      canonicalRow(4, 'agent_thought_chunk', { content: { type: 'text', text: 'together' } }),
      canonicalRow(5, 'agent_message_chunk', { content: { type: 'text', text: 'answer-' } }),
      canonicalRow(6, 'agent_message_chunk', { content: { type: 'text', text: 'together' } }),
      canonicalRow(7, 'done'),
    ]
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => rows,
      subscribe: () => () => {},
    })

    for (let index = 0; index < 3; index += 1) {
      await service.bind(session())
      expect(service.runtime.getSnapshot().document?.messages.map(message => ({
        role: message.role, content: message.content, running: message.running,
      }))).toEqual([
        { role: 'user', content: 'one prompt', running: false },
        { role: 'reasoning', content: 'think-together', running: false },
        { role: 'assistant', content: 'answer-together', running: false },
      ])
    }
    service.destroy()
  })

  it('Session 切换后拒绝上一 owner 的迟到 load 结果', async () => {
    const pending = new Map<string, (events: readonly unknown[]) => void>()
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: ownerKey => new Promise(resolve => pending.set(ownerKey, resolve)),
      subscribe: () => () => {},
    })

    const loadingA = service.bind(session('session-a', 'local:a'))
    const loadingB = service.bind(session('session-b', 'local:b'))
    pending.get(toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }))?.([message(1, 'user', 'stale-a')])
    await loadingA
    expect(service.runtime.getSnapshot().sessionId).toBe('session-b')
    expect(service.runtime.getSnapshot().document?.messages).toEqual([])

    pending.get(toCanonicalOwnerKey({ profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:b' }))?.([message(1, 'user', 'fresh-b', 'local:b')])
    await loadingB
    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['fresh-b'])
    service.destroy()
  })

  it('SQLite load 期间到达的 live event 在同一 generation 合并且保持 sequence 顺序', async () => {
    let resolveLoad: ((events: readonly unknown[]) => void) | undefined
    let live: ((event: WorkbenchEventEnvelope) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: () => new Promise(resolve => { resolveLoad = resolve }),
      subscribe: listener => { live = listener; return () => {} },
    })

    const loading = service.bind(session())
    live?.(message(2, 'assistant', 'live-second'))
    resolveLoad?.([message(1, 'user', 'loaded-first')])
    await loading

    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['loaded-first', 'live-second'])
    service.destroy()
  })

  it('畸形 journal row 不伪装成完整 ready，并留下可诊断的 degraded 状态', async () => {
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [message(1, 'user', 'valid'), { schemaVersion: 99, secretShape: true }],
      subscribe: () => () => {},
    })

    await service.bind(session())

    expect(service.runtime.getSnapshot().document?.messages.map(item => item.content)).toEqual(['valid'])
    expect(service.runtime.getSnapshot()).toMatchObject({
      status: 'degraded',
      error: expect.stringContaining('1'),
    })
    expect(service.runtime.getSnapshot().document?.diagnostics).toContainEqual(expect.objectContaining({
      code: 'canonical.journal.malformed', level: 'error',
    }))
    service.destroy()
  })
})
