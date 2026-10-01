import { describe, expect, it } from 'vitest'
import { createAgentWorkbenchSessionRuntime } from '../../application/agent-workbench/agentWorkbenchSession.ts'
import type { Session } from '../../domains/identity/identityStore.ts'
import { toCanonicalOwnerKey } from '../../domains/events/eventSchema.ts'

/**
 * #442 Step1 行为契约：后端权威 `turnBoundary` 可用时，跨源「或」判定与
 * duration 扫描**退役**（回退轨仅在字段缺失时激活）。
 *
 * 背景（issue #442 现状问题 1）：`canonicalLatestBoundary==='terminal' ||
 * ledgerTerminalReason!==undefined` 的「或」判定存在，是因为同一 load 响应里
 * journal 读可能早于终态行落盘（时序：settle → done 广播 → persist）。后端把
 * 「账本（存在即权威）或 journal 判据」合成进顶层 `turnBoundary` 后，前端不再
 * 需要两路取「或」——`open` 也是权威的「未收敛」表态。
 */

function session(id: string, source: string): Session {
  return {
    id, source, agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function canonicalRow(sequence: number, sessionUpdate: string) {
  const owner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:boundary' }
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
    rawPayload: { update: { sessionUpdate } },
  }
}

function boundaryHarness(initialJournal: unknown[] = [canonicalRow(1, 'user_message_chunk'), canonicalRow(2, 'done')]) {
  const journal = [...initialJournal]
  let pushEvent: ((row: unknown) => void) | undefined
  const service = createAgentWorkbenchSessionRuntime({
    loadAll: async () => journal,
    subscribe: listener => { pushEvent = listener; return () => { pushEvent = undefined } },
    listenTerminalFallback: () => () => {},
  })
  const active = session('session-boundary', 'local:boundary')
  return {
    service, active,
    /** 只推 live 帧（本轮的行**不**落 journal——正是终态行落盘时序窗口的镜像）。 */
    pushLive: (row: unknown) => pushEvent?.(row),
  }
}

describe('#442 Step1 turnBoundary 权威字段替代跨源「或」判定', () => {
  it('journal 读早于终态行落盘（尾行是锚点）：boundary=terminal 直接封存并以权威两端补摘要', async () => {
    // journal 只有锚点行（本轮终态行尚未落盘）——回退轨在这里判 open、不封存。
    const h = boundaryHarness([canonicalRow(1, 'user_message_chunk')])
    await h.service.bind(h.active)

    await h.service.refresh(h.active, undefined, {
      turnBoundary: { kind: 'terminal', startedAtMs: Date.parse('2026-09-05T00:00:01.000Z'), endedAtMs: Date.parse('2026-09-05T00:00:08.500Z') },
    })
    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.generating, '权威 terminal 必须封存').toBe(false)
    expect(snapshot.summary).toMatchObject({
      reason: 'done',
      displayOnly: true,
      durationSource: 'turn-boundary',
      elapsedMs: 7500,
      durationAvailable: true,
    })
    h.service.destroy()
  })

  it('在途回合 + journal 尾行是上一轮终态：boundary=open 权威否决，不压塌（#390 缺陷族镜像）', async () => {
    const h = boundaryHarness()
    await h.service.bind(h.active)
    // 本轮开跑：live 帧驱动生成态，但 journal 尾行仍是上一轮的 done(2)。
    h.pushLive(canonicalRow(3, 'user_message_chunk'))
    h.pushLive({ ...canonicalRow(4, 'agent_message_chunk'), eventType: 'assistant.text.delta' })
    expect(h.service.runtime.getSnapshot().generating, 'live 帧必须开启生成态').toBe(true)

    // 账本权威（后端在途事实）：当前回合 open。回退轨在这里会被 journal 尾行的
    // 终态（上一轮）判成已收敛而压塌；权威 open 必须否决。
    await h.service.refresh(h.active, undefined, { turnBoundary: { kind: 'open', startedAtMs: 1 } })
    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.generating, '权威 open 不得压熄在途生成态').toBe(true)
    expect(snapshot.summary, '权威 open 不得补出上一轮摘要').toBeNull()
    h.service.destroy()
  })

  it('字段缺失 → 回退轨激活：journal 终态照旧补 displayOnly 摘要（#99 兜底不回退）', async () => {
    const h = boundaryHarness()
    await h.service.bind(h.active)
    await h.service.refresh(h.active)
    const snapshot = h.service.runtime.getSnapshot()
    expect(snapshot.summary).toMatchObject({ reason: 'done', displayOnly: true, durationSource: 'canonical-events' })
    h.service.destroy()
  })

  it('boundary=unknown（后端无证据）→ 同回退轨', async () => {
    const h = boundaryHarness()
    await h.service.bind(h.active)
    await h.service.refresh(h.active, undefined, { turnBoundary: { kind: 'unknown' } })
    expect(h.service.runtime.getSnapshot().summary).toMatchObject({ reason: 'done', displayOnly: true, durationSource: 'canonical-events' })
    h.service.destroy()
  })
})
