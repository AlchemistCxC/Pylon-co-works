import { describe, expect, it } from 'vitest'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent, type WorkbenchDocument } from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../events/workbenchEventSchema.ts'

const PROVENANCE = { origin: 'local-observed', trust: 'authoritative' } as const

/**
 * P45 接手（2026-09-05）：live 与 replay 收敛性差分测试。
 *
 * 生产事实：live 事件按到达序经 `reduceWorkbenchEvent` 逐条折入 document；
 * bind/refresh/重启经 `projectWorkbench` 按 sequence 排序重放。用户报告
 * "完成态破碎、重启后恢复"——同一 journal 的两条路径必须产出相同的可见
 * document，否则 live 视图与恢复视图不可互换（违反 K03 的确定性投影意图）。
 *
 * 这里对多类到达序（含乱序、终态先到）断言收敛；每个失败用例即是一类
 * live-only 缺陷（内容丢失/乱序/状态残留）。
 */

function reasoningDelta(sequence: number, text: string): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    eventId: `reasoning-${sequence}`,
    sessionId: 'session-a',
    sequence,
    recordedAt: '2026-09-05T00:00:00.000Z',
    source: { provider: 'acp', sourceId: `reasoning-${sequence}` },
    provenance: PROVENANCE,
    event: { type: 'reasoning.delta', parts: [{ kind: 'reasoning', text }] },
  })
}

function reasoningCompleted(sequence: number): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    eventId: `reasoning-end-${sequence}`,
    sessionId: 'session-a',
    sequence,
    recordedAt: '2026-09-05T00:00:01.000Z',
    source: { provider: 'acp', sourceId: `reasoning-end-${sequence}` },
    provenance: PROVENANCE,
    event: { type: 'reasoning.completed', parts: [] },
  })
}

function assistantDelta(sequence: number, text: string): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    eventId: `assistant-${sequence}`,
    sessionId: 'session-a',
    sequence,
    recordedAt: '2026-09-05T00:00:00.000Z',
    source: { provider: 'acp', sourceId: `assistant-${sequence}` },
    provenance: PROVENANCE,
    event: { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text }] },
  })
}

function assistantCompleted(sequence: number): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    eventId: `assistant-end-${sequence}`,
    sessionId: 'session-a',
    sequence,
    recordedAt: '2026-09-05T00:00:01.000Z',
    source: { provider: 'acp', sourceId: `assistant-end-${sequence}` },
    provenance: PROVENANCE,
    event: { type: 'message.completed', role: 'assistant', parts: [] },
  })
}

function sessionCompleted(sequence: number): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    eventId: `session-end-${sequence}`,
    sessionId: 'session-a',
    sequence,
    recordedAt: '2026-09-05T00:00:02.000Z',
    source: { provider: 'acp', sourceId: `session-end-${sequence}` },
    provenance: PROVENANCE,
    event: { type: 'session.completed', stopReason: 'end_turn' },
  })
}

function reduceInArrivalOrder(envelopes: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return envelopes.reduce(reduceWorkbenchEvent, createWorkbenchDocument('session-a'))
}

/** 可见结构投影：消息行（角色/内容/运行态）+ 会话状态。诊断与 identity 不参与比较。 */
function visibleShape(document: WorkbenchDocument) {
  return {
    sessionStatus: document.session.status,
    messages: document.messages.map(message => ({
      role: message.role,
      content: message.content,
      running: message.running,
      ...(message.thoughtDurationMs !== undefined ? { thoughtDurationMs: message.thoughtDurationMs } : {}),
    })),
  }
}

function expectConverges(envelopes: readonly WorkbenchEventEnvelope[]) {
  const replay = visibleShape(projectWorkbench(envelopes).document)
  const live = visibleShape(reduceInArrivalOrder(envelopes))
  expect(live).toEqual(replay)
}

describe('live arrival order converges with sequence-ordered replay', () => {
  it('control: sequence-ordered arrival converges trivially', () => {
    expectConverges([
      reasoningDelta(10, '先'),
      reasoningDelta(20, '中'),
      reasoningCompleted(30),
      sessionCompleted(40),
    ])
  })

  it('reasoning terminal arrives before its final delta', () => {
    expectConverges([
      reasoningDelta(10, '先'),
      reasoningCompleted(30),
      reasoningDelta(20, '后'),
      sessionCompleted(40),
    ])
  })

  it('session.completed arrives before a trailing reasoning delta', () => {
    expectConverges([
      reasoningDelta(10, '先'),
      sessionCompleted(40),
      reasoningDelta(20, '终态后才到的中段'),
      reasoningCompleted(30),
    ])
  })

  it('out-of-order reasoning deltas never corrupt live order (K03: missing until refresh)', () => {
    const envelopes = [
      reasoningDelta(10, '一'),
      reasoningDelta(30, '三'),
      reasoningDelta(20, '二'),
      reasoningCompleted(40),
    ]
    const live = reduceInArrivalOrder(envelopes)
    // The one-pass reducer cannot splice text backwards; corrupting the
    // segment ("一三二") is worse than showing it missing.
    expect(live.messages.map(message => message.content)).toEqual(['一三'])
    expect(live.diagnostics.some(diagnostic => diagnostic.code === 'out-of-order-text-dropped')).toBe(true)
    // The sequence-ordered replay still sees the journal truth.
    expect(projectWorkbench(envelopes).document.messages.map(message => message.content)).toEqual(['一二三'])
  })

  it('assistant terminal arrives before its final delta', () => {
    expectConverges([
      assistantDelta(10, '先'),
      assistantCompleted(30),
      assistantDelta(20, '后'),
      sessionCompleted(40),
    ])
  })

  it('out-of-order assistant deltas never corrupt live order (K03: missing until refresh)', () => {
    const envelopes = [
      assistantDelta(10, '一'),
      assistantDelta(30, '三'),
      assistantDelta(20, '二'),
      assistantCompleted(40),
    ]
    const live = reduceInArrivalOrder(envelopes)
    expect(live.messages.map(message => message.content)).toEqual(['一三'])
    expect(live.diagnostics.some(diagnostic => diagnostic.code === 'out-of-order-text-dropped')).toBe(true)
    expect(projectWorkbench(envelopes).document.messages.map(message => message.content)).toEqual(['一二三'])
  })
})
