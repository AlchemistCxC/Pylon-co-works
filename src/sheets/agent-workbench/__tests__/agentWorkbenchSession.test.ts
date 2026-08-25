import { describe, expect, it } from 'vitest'
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
