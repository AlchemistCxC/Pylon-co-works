import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../../sheets/agent-workbench/agentWorkbenchSession.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'
import { getCanonicalEventFeed } from '../../infrastructure/events/canonicalEventFeed.ts'

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

/** #200：session/load 恢复导入行的 provenance（journal 空时恢复 agent 侧历史）。 */
function importedRow(sequence: number, sessionUpdate: string, fields: Record<string, unknown> = {}) {
  const row = canonicalRow(sequence, sessionUpdate, fields)
  return {
    ...row,
    provenance: { origin: 'recovery-import', trust: 'unverified', provider: 'peri' },
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

  it('#200：空 journal 重建升级——recovery-import 历史不进入生成态（核心回归）', async () => {
    // #155 T2 重建升级日：journal 为空，bind 经 session/load 拿 agent 侧历史并
    // recovery-import 落盘。导入历史没有终态行（agent 重放不带 done 帧）——修复前
    // 投影器把全部消息停在 running 态 → 文档派生 generating=true，永久
    // 「仍在等待后端响应」并阻塞发送队列。
    const imported = [
      importedRow(1, 'user_message_chunk', { content: { type: 'text', text: '历史问题' } }),
      importedRow(2, 'agent_message_chunk', { content: { type: 'text', text: '历史回答' } }),
    ]
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async () => imported,
      subscribe: () => () => {},
    })
    const active = session('session-recovery', 'local:rebind')
    await service.bind(active)
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating, '导入历史不得进入生成态').toBe(false)
    expect(snapshot.summary, '无终态证据不得造终态摘要').toBeNull()
    expect(snapshot.document?.messages.at(-1)?.running, '导入消息按已沉淀处理').toBe(false)

    // 之后的真实 live 回合照常开时钟（回归护栏：豁免只认 recovery-import）。
    let pushEvent: ((row: unknown) => void) | undefined
    service.destroy()
    const live = createAgentWorkbenchSessionRuntime({
      loadAll: async () => imported,
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    })
    await live.bind(active)
    pushEvent?.(canonicalRow(3, 'user_message_chunk', { content: { type: 'text', text: '新回合' } }))
    expect(live.runtime.getSnapshot().generating, 'live user 帧必须开启时钟').toBe(true)
    live.destroy()
  })

  it('#200：loading 中途到达的导入 user 帧既不开时钟、也不进生成态', async () => {
    // 同一场景的 live 侧防线：若导入行经发布通道在载入中途到达（loading=true），
    // 修复前会走 applyLive 的「非乐观 user echo = 新回合」分支开启 TurnClock。
    let pushEvent: ((row: unknown) => void) | undefined
    let releaseLoad: (() => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: () => new Promise<readonly unknown[]>(resolve => { releaseLoad = () => resolve([]) }),
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    })
    const active = session('session-recovery-live', 'local:rebind')
    const binding = service.bind(active)

    pushEvent?.(importedRow(1, 'user_message_chunk', { content: { type: 'text', text: '历史回合' } }))
    expect(service.runtime.getSnapshot().generating, '载入中的导入帧不得复活生成态').toBe(false)

    releaseLoad?.()
    await binding
    const snapshot = service.runtime.getSnapshot()
    expect(snapshot.generating, '导入帧缓冲折入后仍不得是生成态').toBe(false)
    expect(snapshot.document?.messages.at(-1)?.running, '导入消息按已沉淀处理').toBe(false)
    service.destroy()
  })

  it('#204 ②：思考中切走再切回，后续思考帧必须继续折入同一块（不得截断/复制）', async () => {
    // 用户报告：「思考中切换页面，返回后会生成两个思考块，内容为完整思考的截断
    // （截断处从切换页面开始）」。
    //
    // 根因：`bind` 把闭包 `turnEpoch` 重置为 0，而 `workbenchRuntime.acceptDocument`
    // 对 `applyDocument`（live 帧）执行 `options.turnEpoch < snapshot.turnEpoch` 即拒绝；
    // 切回后 snapshot 的 epoch 仍是切走前那一轮的值（终态/回合事实没有回退），
    // 于是切回后的思考帧被静默丢弃——文档停在切回那一刻的 journal 快照，之后的
    // 内容要么缺一段（截断），要么在终帧后的 refresh 重折时另起一块（复制）。
    const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:rebind' }
    const ownerKey = toCanonicalOwnerKey(owner)
    const thinkingRow = (sequence: number, text: string) => ({
      schemaVersion: 1,
      eventId: `${ownerKey}#${sequence}`,
      owner,
      provenance: { origin: 'local-observed', trust: 'authoritative', provider: 'peri' },
      clientGeneration: 1,
      sequence,
      occurredAt: `2026-09-05T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      receivedAt: `2026-09-05T00:00:${String(sequence).padStart(2, '0')}.000Z`,
      eventType: 'assistant.thinking.delta',
      payloadVersion: 1,
      identity: { messageId: 'thought-1' },
      typedPayload: { text },
      rawPayload: { update: { sessionUpdate: 'agent_thought_chunk', messageId: 'thought-1', content: { type: 'text', text } } },
    })

    const journal: unknown[] = []
    let pushEvent: ((row: unknown) => void) | undefined
    const service = createAgentWorkbenchSessionRuntime({
      loadAll: async key => (key === ownerKey ? [...journal] : []),
      subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    })
    const active = session('session-thinking', 'local:rebind')
    await service.bind(active)

    // 第一段思考：用户帧开启回合，随后两条思考 delta（对应 journal 行 1..3）。
    const phase1 = [
      canonicalRow(1, 'user_message_chunk', { content: { type: 'text', text: '长问题' } }),
      thinkingRow(2, '甲'),
      thinkingRow(3, '乙'),
    ]
    for (const row of phase1) pushEvent?.(row)
    expect(service.runtime.getSnapshot().document?.messages.filter(message => message.role === 'reasoning').map(message => message.content)).toEqual(['甲乙'])

    // 切走：journal 落盘第一段（生产里此刻已 durable）。
    journal.push(...phase1)
    await service.bind(session('session-other-thinking', 'local:other'))
    // 切回：文档由 journal 重建（仍是一块 running 的思考）。
    await service.bind(active)
    const beforeSwitchBack = service.runtime.getSnapshot()
    expect(beforeSwitchBack.document?.messages.filter(message => message.role === 'reasoning').map(message => message.content), '切回后 journal 快照应为一段完整思考').toEqual(['甲乙'])

    // 切回后的思考继续流式到达（回合未终结，无新的 user 帧）。
    pushEvent?.(thinkingRow(4, '丙'))
    pushEvent?.(thinkingRow(5, '丁'))

    const snapshot = service.runtime.getSnapshot()
    const document = snapshot.document
    const thoughts = document?.messages.filter(message => message.role === 'reasoning') ?? []

    expect(thoughts.length, '思考块不得因切回而分裂成两块').toBe(1)
    expect(thoughts[0]?.content, '切回后的思考必须继续折入同一块（不截断）').toBe('甲乙丙丁')
    expect(document?.revision, 'live 帧必须真正落进文档（revision 前进）').toBe(5)

    // 顺序稳定：timeline 严格升序，消息 sequence 不回退。
    const sequences = (document?.timeline ?? []).map(entry => entry.sequence)
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right))
    const messageSequences = (document?.messages ?? []).map(message => message.sequence)
    expect(messageSequences).toEqual([...messageSequences].sort((left, right) => left - right))

    // 复制那一路：终帧后的 canonical refresh（`AgentWorkbenchLifecycle.onCanonicalRefresh`）
    // 会把 journal 行重折进当前文档。若切回后的思考帧曾被丢弃，这些行在 appliedRanges 里
    // 没有覆盖记录，重折就会**再折一遍**——正文变成两段（用户看到的「两个思考块」）。
    journal.push(thinkingRow(4, '丙'), thinkingRow(5, '丁'))
    await service.refresh(active)
    const afterRefresh = service.runtime.getSnapshot().document
    const refreshedThoughts = afterRefresh?.messages.filter(message => message.role === 'reasoning') ?? []
    expect(refreshedThoughts.length, 'journal 重折不得再折出第二个思考块').toBe(1)
    expect(refreshedThoughts[0]?.content, 'journal 重折不得重复拼接已应用内容').toBe('甲乙丙丁')
    service.destroy()
  })
})
