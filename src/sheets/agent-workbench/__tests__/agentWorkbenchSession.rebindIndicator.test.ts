import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../agentWorkbenchSession.ts'
import type { Session } from '../../../identityStore.ts'
import { toCanonicalOwnerKey } from '../../../domains/events/eventSchema.ts'

/**
 * 用户报告（2026-09-05，P45 接手后）：生成结束 → 切换到其他会话 → 切回，
 * 生成指示器永久停留终态——新一轮生成期间 footer 不进入 running。
 *
 * 复现链路对齐生产：bind（含已完成 journal + controller 持有旧终态 summary）→
 * 解绑 → 重新 bind（此时 A3 防护会对终态 document 合成 terminal fence）→ 新一轮
 * （controller generating 翻 true + 通知 + canonical user echo 落 journal）→
 * 断言 runtime 快照在新回合中 generating=true、summary 已清、fence 已清。
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
    let notify: (() => void) | undefined
    let generating = false
    let controllerSummary: { elapsedMs: number; tokenCount: number; completedFrame: string; reason: 'done' } | undefined
    const controller = {
      subscribe: (_source: string, listener: () => void) => { notify = listener; return () => { notify = undefined } },
      getGenerating: () => generating,
      getStartTime: () => 1_000,
      getLastActivityAt: () => 2_000,
      getGenerationPhase: () => generating ? ({ kind: 'responding' as const }) : undefined,
      getGenerationActivity: () => undefined,
      getThinkingStart: () => undefined,
      getTokenCount: () => 12,
      getSummary: () => controllerSummary,
      getStreamingState: () => ({ text: '', thinking: '', identity: undefined }),
      rejectOptimisticUser: () => {},
    }
    const journal = [
      canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '上一轮请求' } }),
      canonicalRow(2, 'done'),
    ]
    let pushEvent: ((row: unknown) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => journal,
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
      chatController: () => controller,
    })

    const active = session('session-rebind', 'local:rebind')
    await service.bind(active)
    // 上一轮完成：controller 持有终态 summary（生成结束时的真实 controller 状态）。
    controllerSummary = { elapsedMs: 5_000, tokenCount: 12, completedFrame: '', reason: 'done' }
    notify?.()
    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done' })
    expect(service.runtime.getSnapshot().generating).toBe(false)

    // 切走 → 切回。
    await service.bind(session('session-other', 'local:other'))
    await service.bind(active)
    expect(service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done' })

    // 新一轮生成：controller 翻 generating、清掉自己的旧 summary，随后 canonical
    // user echo 落 journal（生产顺序：send → controller 激活 → echo 提交）。
    generating = true
    controllerSummary = undefined
    notify?.()
    pushEvent?.(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '新一轮请求' } }))
    pushEvent?.(canonicalRow(4, 'agent_message_chunk', { content: { type: 'text', text: '正在生成' } }))

    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating).toBe(true)
    expect(snapshot.summary).toBeNull()
    expect(snapshot.terminalFence).toBeUndefined()
    expect(snapshot.generationStart).toBeGreaterThan(0)
    service.destroy()
  })
})
