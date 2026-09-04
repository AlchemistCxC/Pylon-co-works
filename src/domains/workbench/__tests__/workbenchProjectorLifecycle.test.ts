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
  it('terminal status-updated settles running rows and remains monotonic', () => {
    const running = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'partial' }] })
    const completed = envelope(2, { type: 'session.status-updated', status: 'completed' })
    const regressed = envelope(3, { type: 'session.status-updated', status: 'error' })
    const document = reduce([running, completed, regressed])
    expect(document.session.status).toBe('completed')
    expect(document.messages).toEqual([expect.objectContaining({ content: 'partial', running: false })])
  })

  it('does not rewrite a completed terminal status when a provider error arrives late', () => {
    const document = reduce([
      envelope(1, { type: 'session.completed' }),
      envelope(2, { type: 'diagnostic.notice', level: 'error', code: 'provider.error', message: 'late provider failure' }),
    ])
    expect(document.session.status).toBe('completed')
    expect(document.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider.error', level: 'error' }),
    ]))
  })

  it('absorbs all late reasoning and tool terminal events after session completion', () => {
    const document = reduce([
      envelope(1, { type: 'session.completed' }),
      envelope(2, { type: 'reasoning.completed', parts: [{ kind: 'text', text: 'late thought' }] }),
      envelope(3, { type: 'reasoning.redacted', parts: [], reason: 'late' }),
      envelope(4, { type: 'tool.completed', tool: { toolCallId: 'late-tool', name: 'Read', status: 'completed' } }),
      envelope(5, { type: 'tool.failed', tool: { toolCallId: 'late-tool-2', name: 'Read', status: 'failed' } }),
    ])
    expect(document.messages).toHaveLength(0)
    expect(document.activities).toHaveLength(0)
    expect(document.diagnostics.filter(item => item.code === 'late-event-after-terminal')).toHaveLength(1)
  })

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

  it('keeps structured provider error metadata in lifecycle retry projection', () => {
    const events = [
      envelope(1, { type: 'lifecycle.retrying', attempt: 1, maxAttempts: 2, delayMs: 500, error: {
        userSummary: '连接失败', technicalMessage: 'ECONNRESET', code: 'provider.error',
        provider: 'hermes', recoverability: 'retry', retryAfterMs: 2000, classification: 'network',
      } as unknown as import('../events/workbenchEventSchema.ts').JsonValue }),
    ]
    const live = events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
    const replay = projectWorkbench(events).document
    expect(selectLifecycle(live).retry?.error?.metadata).toMatchObject({ retryAfterMs: 2000, classification: 'network' })
    expect(JSON.stringify(live.lifecycle)).toEqual(JSON.stringify(replay.lifecycle))
  })
})
