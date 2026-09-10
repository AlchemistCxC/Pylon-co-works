import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../identityStore.ts'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema.ts'
import { getCanonicalEventFeed } from '../../../infrastructure/events/canonicalEventFeed.ts'

/**
 * 用户报告（2026-09-05，P45 接手后）：生成结束 → 切换到其他会话 → 切回，
 * 生成指示器永久停留终态——新一轮生成期间 footer 不进入 running。
 *
 * 复现链路对齐生产（P52 D3 后 controller 时钟已退役，驱动改 TurnClock/canonical）：
 * bind（含已完成 journal → displayOnly 终态摘要）→ 解绑 → 重新 bind（A3 防护对
 * 终态 document 合成 terminal fence）→ 新一轮（feed 终帧后的新 user echo 落 journal
 * + TurnClock 重启）→ 断言 runtime 快照在新回合中 generating=true、summary 已清、
 * fence 已清。
 */

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function canonicalRow(sequence: number, sessionUpdate: string, fields: Record<string, unknown> = {}) {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:rebind' }
  return {
    schemaVersion: 1,
    eventId: `${toCanonicalOwnerKey(owner)}#${sequence}`,
    owner,
    provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
    clientGeneration: 1,
    sequence,
    occurredAt: `2026-09-05T00:00:0${sequence}.000Z`,
    receivedAt: `2026-09-05T00:00:0${sequence}.000Z`,
    eventType: sessionUpdate === 'user_message_chunk' ? 'user.message'
      : sessionUpdate === 'done' ? 'turn.completed' : 'unknown',
    payloadVersion: 1,
    rawPayload: { update: { sessionUpdate, ...fields } },
  }
}

describe('rebind keeps the generation indicator responsive (user repro)', () => {
  it('a new turn after session re-enter restarts the indicator instead of staying terminal', async () => {
    const journal = [
      canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '上一轮请求' } }),
      canonicalRow(2, 'done'),
    ]
    let pushEvent: ((row: unknown) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => journal,
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    })

    const active = session('session-rebind', 'local:rebind')
    await service.bind(active)
    // 上一轮完成：displayOnly 恢复摘要（bind 时 journal 已终态）。
    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done', displayOnly: true })
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // 切走 → 切回。
    await service.bind(session('session-other', 'local:other'))
    await service.bind(active)
    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done' })

    // 新一轮生成：user echo 落 journal（live envelope 驱动 TurnClock.start 与
    // epoch/fence 清除通道），随后 assistant 流式行。
    pushEvent?.(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '新一轮请求' } }))
    pushEvent?.(canonicalRow(4, 'agent_message_chunk', { content: { type: 'text', text: '正在生成' } }))

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(true)
    expect(snapshot.summary).toBeNull()
    expect(snapshot.terminalFence).toBeUndefined()
    expect(snapshot.generationStart).toBeGreaterThan(0)
    service.destroy()
  })

  it('P52 D3：feed 终帧信号驱动 TurnClock 终态摘要（done 幂等，首终态 wins）', async () => {
    const feed = getCanonicalEventFeed()
    let pushEvent: ((row: unknown) => void) | undefined
    const active = session('session-terminal', 'local:rebind')
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => [],
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    })

    await service.bind(active)
    // 回合起点：live user echo。
    pushEvent?.(canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '问' } }))

    // feed 终帧：done → TurnClock 写 live 终态摘要。
    await feed.acceptFrame({ event: 'pylon:done', payload: { source: active.source } })
    let snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(false)
    expect(snapshot.summary).toMatchObject({ reason: 'done', durationSource: 'live-monotonic' })

    // 迟到第二个终帧（error）：首终态 wins，摘要不被改写。
    await feed.acceptFrame({ event: 'pylon:error', payload: { source: active.source, error: 'late' } })
    snapshot = service.runtime.getSnapshot()
    expect(snapshot.summary).toMatchObject({ reason: 'done' })
    service.destroy()
  })
})
