import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  selectLifecycle,
  selectSystemErrors,
  selectTimeline,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

const base = {
  provider: 'peri',
  sourceId: 'wire-1',
  sessionId: 'session-1',
  recordedAt: '2026-08-21T00:00:00.000Z',
} as const

function envelope(sequence: number, event: WorkbenchSemanticEvent): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event,
  })
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

describe('WorkbenchProjector lifecycle slices (C13)', () => {
  it('projects retry chain into lifecycle slice and keeps timeline entries', () => {
    const document = reduce([
      envelope(1, { type: 'lifecycle.retrying', attempt: 1, maxAttempts: 3, delayMs: 1000, error: { technicalMessage: 'boom', recoverability: 'retry' } as unknown as import('../events/workbenchEventSchema.ts').JsonValue }),
      envelope(2, { type: 'lifecycle.recovered', source: 'canonical' }),
    ])
    expect(selectLifecycle(document).retry).toBeUndefined()
    expect(selectLifecycle(document).history.map(item => item.kind)).toEqual(['retry', 'recovered'])
    expect(selectTimeline(document).map(item => item.kind)).toEqual(['lifecycle', 'lifecycle'])
  })

  it('separates system errors from notices; error carries structured NormalizedError not raw string', () => {
    const document = reduce([
      envelope(1, { type: 'diagnostic.notice', level: 'info', message: '提示信息' }),
      envelope(2, { type: 'diagnostic.notice', level: 'error', message: '连接失败', code: 'agent_connection_timeout' }),
    ])
    // notice 不进 systemErrors；error 级 notice 进
    expect(selectSystemErrors(document)).toHaveLength(1)
    expect(selectSystemErrors(document)[0]).toMatchObject({ code: 'agent_connection_timeout' })
    expect(selectSystemErrors(document)[0]?.userSummary).toBe('连接失败')
  })

  it('keeps live apply and restart replay deep-equal for lifecycle state', () => {
    const events = [
      envelope(1, { type: 'lifecycle.compact-started', strategy: 'rolling', tokensBefore: 1000 }),
      envelope(2, { type: 'lifecycle.compact-completed', tokensBefore: 1000, tokensAfter: 300 }),
      envelope(3, { type: 'lifecycle.suspended', reason: '等待输入' }),
    ]
    const live = events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
    // restart replay 走同一 journal 的排序投影（projectWorkbench 按 sequence 排序），与 live 深等
    const replay = projectWorkbench(events).document
    expect(JSON.stringify(live.lifecycle)).toEqual(JSON.stringify(replay.lifecycle))
  })
})
