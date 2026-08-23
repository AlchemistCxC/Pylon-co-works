import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { projectWorkbench, selectActivities } from '../workbenchProjector.ts'

/**
 * C10 RED：activity.background-task / activity.workflow / activity.workflow-phase /
 * activity.workflow-agent 投影契约（DIC-C10-01）。
 *
 * - workflow → phase → activity/process/subagent 用 relation/id 连接，不复制底层 output；
 * - progress patch 保留 token/tool/duration/result/error/killed/timeout，终态不可倒退；
 * - synthetic provenance 可追溯（reason + orderConfidence=observed）；
 * - 未知 provider task type 仍落 background-task family。
 */

const envelope = (sequence: number, event: Parameters<typeof createWorkbenchEnvelope>[0]['event'], provider = 'peri') =>
  createWorkbenchEnvelope({
    sessionId: 'session-c10',
    sequence,
    recordedAt: `2026-08-23T07:00:0${sequence}.000Z`,
    source: { provider, sourceId: `c10-${sequence}` },
    identity: {},
    provenance: sequence === 9
      ? { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed', synthetic: { reason: 'terminal response observed' } }
      : { origin: 'local-observed', trust: 'authoritative' },
    event,
  })

describe('C10 background-task / workflow projection', () => {
  it('derives activity.background-task for unknown provider task families without guessing narrower kinds', () => {
    const { document } = projectWorkbench([
      envelope(1, {
        type: 'activity.started', activityId: 'bg-1',
        activity: { kind: 'background-task', title: 'nightly index' },
      }),
      envelope(2, { type: 'activity.completed', activityId: 'bg-1', result: { summary: 'done' } }),
    ])
    const node = selectActivities(document).find(a => a.id === 'bg-1')
    expect(node!.semanticKind).toBe('activity.background-task')
    expect(node!.status).toBe('completed')
    expect(node!.result).toEqual({ summary: 'done' })
  })

  it('links a workflow to phases and agents by relation ids and keeps terminal states non-regressive', () => {
    const events = [
      envelope(1, {
        type: 'activity.started', activityId: 'wf-1',
        activity: {
          kind: 'workflow', title: 'release pipeline',
          metadata: { phases: ['phase-1', 'phase-2'] },
        },
      }),
      envelope(2, {
        type: 'activity.started', activityId: 'phase-1',
        activity: { kind: 'workflow-phase', title: 'build', parentId: 'wf-1' },
      }),
      envelope(3, {
        type: 'activity.progress', activityId: 'phase-1',
        patch: { progress: { completed: 2, total: 4 }, metadata: { durationMs: 1200 } },
      }),
      // duplicate/out-of-order progress：completed 不回退
      envelope(4, {
        type: 'activity.completed', activityId: 'phase-1', result: { summary: 'built' },
      } as never),
      envelope(5, {
        type: 'activity.progress', activityId: 'phase-1',
        patch: { progress: { completed: 0, total: 4 } },
      }),
      // phase-2 带 agent lane
      envelope(6, {
        type: 'activity.started', activityId: 'agent-1',
        activity: {
          kind: 'workflow-agent', title: 'reviewer bot',
          parentId: 'wf-1', role: 'reviewer', model: 'ox-alpha-free',
        },
      }, 'claude'),
      // 合成孤儿终态
      envelope(9, {
        type: 'activity.failed', activityId: 'agent-1', reason: 'connection lost',
      }),
    ]
    const { document } = projectWorkbench(events)
    const wf = selectActivities(document).find(a => a.id === 'wf-1')
    const phase = selectActivities(document).find(a => a.id === 'phase-1')
    const agent = selectActivities(document).find(a => a.id === 'agent-1')

    expect(wf!.semanticKind).toBe('activity.workflow')
    expect(wf!.metadata).toEqual({ phases: ['phase-1', 'phase-2'] })
    // phase relation 经 parentId；不复制 workflow output
    expect(phase!.parentId).toBe('wf-1')
    expect(phase!.semanticKind).toBe('activity.workflow-phase')
    expect(phase!.status).toBe('completed')
    // 终态后迟到 progress 不回退状态也不覆盖 progress 快照
    expect((phase!.progress as { completed: number }).completed).toBe(2)
    expect(agent!.semanticKind).toBe('activity.workflow-agent')
    expect(agent!.status).toBe('failed')
    // 合成 provenance 可追溯
    expect(agent!.provenance?.synthetic?.reason).toBe('connection lost'.replace('connection lost', 'terminal response observed'))
    expect(agent!.provenance?.orderConfidence).toBe('observed')
    expect(agent!.parentId).toBe('wf-1')
    expect(agent!.role).toBe('reviewer')
  })

  it('keeps live apply and restart replay deep-equal for the same C10 journal (C13 acceptance parity)', () => {
    const events = [
      envelope(1, { type: 'activity.started', activityId: 'wf-r',
        activity: { kind: 'workflow', title: 'pipeline' } }),
      envelope(2, { type: 'activity.started', activityId: 'ph-r',
        activity: { kind: 'workflow-phase', title: 'build', parentId: 'wf-r' } }),
      envelope(3, { type: 'activity.completed', activityId: 'ph-r', result: { summary: 'ok' } } as never),
    ]
    // live：顺序 apply；replay：一次性 replace 同一 journal
    const live = projectWorkbench(events).document
    const replay = projectWorkbench(events, { initialDocument: undefined }).document
    expect(replay).toEqual(live)
  })
})
