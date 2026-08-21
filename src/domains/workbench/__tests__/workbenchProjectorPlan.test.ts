import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  selectPlan,
  selectGoal,
  selectTimeline,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'
type JsonValue = import('../events/workbenchEventSchema.ts').JsonValue

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  identity: WorkbenchEventEnvelope['identity'] = {},
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity,
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

describe('WorkbenchProjector plan/goal slices (C08)', () => {
  it('projects plan.replaced and entry patches into a document plan slice keyed by stable id', () => {
    const document = reduce([
      envelope(1, { type: 'plan.replaced', entries: [
        { id: 'a', content: '第一步', status: 'completed' },
        { id: 'b', content: '第二步', status: 'in_progress', activeForm: '正在第二步' },
      ] as unknown as readonly JsonValue[] }),
      envelope(2, { type: 'plan.entry-updated', entry: { id: 'b', content: '第二步', status: 'blocked', blockedReason: '等待审批' } as unknown as JsonValue }),
      envelope(3, { type: 'plan.entry-updated', entry: { id: 'b', content: '第二步', status: 'in_progress' } as unknown as JsonValue }),
    ])
    expect(selectPlan(document).entries.map(entry => [entry.id, entry.status])).toEqual([
      ['a', 'completed'],
      ['b', 'in_progress'],
    ])
    // timeline kind 正确归类为 plan
    expect(selectTimeline(document).map(item => item.kind)).toEqual(['plan', 'plan', 'plan'])
  })

  it('projects goal.updated / goal.cleared and classifies goal timeline entries as plan family', () => {
    const document = reduce([
      envelope(1, { type: 'goal.updated', goal: { goalId: 'g-1', objective: '完成渲染引擎', status: 'active', tokenBudget: 5000, tokensUsed: 120 } as unknown as JsonValue }),
      envelope(2, { type: 'goal.updated', goal: { goalId: 'g-1', status: 'blocked', blockedReason: '预算耗尽' } as unknown as JsonValue }),
      envelope(3, { type: 'goal.cleared', goalId: 'g-1' }),
      envelope(4, { type: 'assist.prediction', actions: [] }),
    ])
    expect(selectGoal(document)).toBeUndefined()
    expect(selectTimeline(document).map(item => item.kind)).toEqual(['plan', 'plan', 'plan', 'assist'])
  })

  it('keeps live apply and restart replay deep-equal for the same journal (plan/goal included)', () => {
    const events = [
      envelope(1, { type: 'plan.replaced', entries: [{ id: 'x', content: '任务 X', status: 'pending' }] as unknown as readonly JsonValue[] }),
      envelope(2, { type: 'goal.updated', goal: { goalId: 'g-9', objective: '目标', status: 'active' } as unknown as JsonValue }),
      envelope(3, { type: 'plan.entry-updated', entry: { id: 'x', content: '任务 X', status: 'completed' } as unknown as JsonValue }),
    ]
    const live = events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
    const replay = projectWorkbench(events).document
    expect(JSON.stringify(live.plan)).toEqual(JSON.stringify(replay.plan))
    expect(JSON.stringify(live.goal)).toEqual(JSON.stringify(replay.goal))
  })

  it('tolerates malformed plan/goal payloads with diagnostics instead of throwing', () => {
    const document = reduce([
      envelope(1, { type: 'plan.replaced', entries: 'not-an-array' as unknown as readonly JsonValue[] }),
      envelope(2, { type: 'goal.updated', goal: 'not-an-object' as unknown as JsonValue }),
    ])
    expect(selectPlan(document).entries).toEqual([])
    expect(selectGoal(document)).toBeUndefined()
    expect(document.diagnostics.length).toBeGreaterThanOrEqual(2)
  })
})
