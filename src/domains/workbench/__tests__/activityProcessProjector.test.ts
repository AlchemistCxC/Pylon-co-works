import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { projectWorkbench } from '../workbenchProjector.ts'

describe('C07 activity.process projection', () => {
  it('merges process identity, progress, output, terminal state, and provenance outside messages', () => {
    const envelope = (sequence: number, event: Parameters<typeof createWorkbenchEnvelope>[0]['event']) => createWorkbenchEnvelope({
      sessionId: 'session-1', sequence, recordedAt: `2026-08-23T00:00:0${sequence}.000Z`,
      source: { provider: 'peri', sourceId: `process-${sequence}` },
      identity: { taskId: 'activity-1', runId: 'run-1' },
      provenance: sequence === 1
        ? { origin: 'local-observed', trust: 'authoritative' }
        : { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed', synthetic: { reason: 'terminal response observed' } },
      event,
    })
    const events = [
      envelope(1, {
        type: 'activity.started', activityId: 'activity-1',
        activity: {
          kind: 'process', semanticKind: 'activity.process', title: 'npm test', parentId: 'tool-1',
          processId: 'proc-1', sessionId: 'shell-1',
        },
      }),
      envelope(2, {
        type: 'activity.progress', activityId: 'activity-1',
        patch: {
          progress: { completed: 2, total: 3 },
          parts: [{ kind: 'log', source: 'runner', entries: [{ level: 'info', text: 'running' }] }],
        },
      }),
      envelope(3, {
        type: 'activity.completed', activityId: 'activity-1',
        result: {
          parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'passed', ordinal: 0 }], exitCode: 0 }],
        },
      }),
    ]

    const document = projectWorkbench(events).document
    expect(document.messages).toEqual([])
    expect(document.activities).toHaveLength(1)
    expect(document.activities[0]).toMatchObject({
      id: 'activity-1', kind: 'activity', activityKind: 'process', semanticKind: 'activity.process',
      title: 'npm test', parentId: 'tool-1', processId: 'proc-1', sessionId: 'shell-1',
      status: 'completed', progress: { completed: 2, total: 3 },
      parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'passed', ordinal: 0 }], exitCode: 0 }],
      provenance: expect.objectContaining({
        origin: 'plugin', orderConfidence: 'observed', synthetic: { reason: 'terminal response observed' },
      }),
    })
  })

  it('narrows nested process parts and preserves malformed evidence as bounded unknown content', () => {
    const envelope = createWorkbenchEnvelope({
      sessionId: 'session-1', sequence: 1, recordedAt: '2026-08-23T00:00:01.000Z',
      source: { provider: 'hermes', sourceId: 'process-malformed' },
      identity: { taskId: 'activity-malformed' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: {
        type: 'activity.completed', activityId: 'activity-malformed',
        activity: { kind: 'process', semanticKind: 'activity.process', title: 'unsafe output' },
        result: {
          parts: [
            { kind: 'terminal', streams: [{ stream: 'stdout', text: 'kept' }], exitCode: 0 },
            { kind: 'terminal', streams: [{ stream: 'stdin', text: 'malformed evidence' }] },
          ],
        },
      },
    })

    const document = projectWorkbench([envelope]).document
    const activity = document.activities[0]!
    expect(activity.parts).toEqual([
      { kind: 'terminal', streams: [{ stream: 'stdout', text: 'kept' }], exitCode: 0 },
      expect.objectContaining({ kind: 'unknown', originalType: 'terminal', truncated: false }),
    ])
    expect(document.diagnostics).toContainEqual(expect.objectContaining({
      code: 'activity.process.part-malformed',
      eventId: envelope.eventId,
      level: 'warning',
      data: expect.objectContaining({ activityId: 'activity-malformed', partIndex: 1 }),
    }))
  })
})
