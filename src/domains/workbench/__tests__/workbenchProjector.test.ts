import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  selectActivities,
  selectInteractions,
  selectSessionSurface,
  selectTimeline,
  type WorkbenchDocument,
} from '../workbenchProjector.ts'
import { selectLegacyMessages } from '../workbenchLegacyFacade.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'

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
  provenance: WorkbenchEventEnvelope['provenance'] = { origin: 'local-observed', trust: 'authoritative' },
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    ...base,
    sequence,
    source: { provider: base.provider, sourceId: `${base.sourceId}-${sequence}` },
    identity,
    provenance,
    event,
  })
}

function reduce(events: readonly WorkbenchEventEnvelope[]): WorkbenchDocument {
  return events.reduce(reduceWorkbenchEvent, createWorkbenchDocument(base.sessionId))
}

describe('WorkbenchProjector', () => {
  it('projects messages, timeline and unknown diagnostics through one pure reducer', () => {
    const events = [
      envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'question' }] }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] }, { messageId: 'm-1' }),
      envelope(3, { type: 'event.unknown', originalType: 'future_event', summary: 'future', raw: { value: 1 }, truncated: false }),
    ]
    const document = reduce(events)
    expect(selectLegacyMessages(document).map(message => [message.role, message.content])).toEqual([
      ['user', 'question'],
      ['assistant', 'answer'],
    ])
    expect(selectTimeline(document).map(item => item.kind)).toEqual(['message', 'message', 'unknown'])
    expect(document.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'event.unknown', eventId: events[2].eventId }),
    ]))
  })

  it('is idempotent for duplicate event ids and keeps tool orphan relation until parent arrives', () => {
    const toolUpdate = envelope(2, {
      type: 'tool.progress',
      tool: { toolCallId: 'tool-1', name: 'read', parentActivityId: 'parent-1', status: 'completed' },
    }, { toolCallId: 'tool-1' })
    const duplicate = reduceWorkbenchEvent(reduceWorkbenchEvent(createWorkbenchDocument(base.sessionId), toolUpdate), toolUpdate)
    expect(duplicate.appliedEventIds).toEqual([toolUpdate.eventId])
    expect(selectActivities(duplicate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', parentId: 'parent-1', orphan: true }),
    ]))

    const parent = envelope(3, { type: 'activity.started', activityId: 'parent-1', activity: { title: 'parent' } }, { taskId: 'parent-1' })
    const attached = reduce([toolUpdate, parent])
    expect(selectActivities(attached)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', parentId: 'parent-1', orphan: false }),
    ]))
  })

  it('resolves interactions, session state and turn failure deterministically', () => {
    const events = [
      envelope(1, { type: 'interaction.requested', interactionId: 'ask-1', request: { question: 'continue?' } }, { interactionId: 'ask-1' }),
      envelope(2, { type: 'session.commands-updated', commands: [{ name: '/compact' }] }),
      envelope(3, { type: 'usage.updated', usage: { inputTokens: 4 } }),
      envelope(4, { type: 'diagnostic.notice', level: 'error', message: 'failed', code: 'turn.failed' }),
      envelope(5, { type: 'interaction.resolved', interactionId: 'ask-1', response: { answer: 'yes' } }, { interactionId: 'ask-1' }),
    ]
    const document = reduce(events)
    expect(selectInteractions(document)).toEqual([])
    expect(selectSessionSurface(document)).toMatchObject({ commands: [{ name: '/compact' }], usage: { inputTokens: 4 } })
    expect(document.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'turn.failed', level: 'error' }),
    ]))
  })

  it('settles running messages when a turn failure diagnostic arrives', () => {
    const running = envelope(1, { type: 'message.started', role: 'assistant', parts: [{ kind: 'text', text: 'partial' }] })
    const failed = envelope(2, { type: 'diagnostic.notice', level: 'error', message: 'timeout', code: 'turn.failed' })
    const document = reduce([running, failed])
    expect(document.messages[0].running).toBe(false)
    expect(document.session.status).toBe('error')
  })

  it('live, restart and recovery provenance produce the same document', () => {
    const live = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'same' }] })
    const restart = envelope(1, live.event, live.identity, { origin: 'migration', trust: 'unverified' })
    const recovery = envelope(1, live.event, live.identity, { origin: 'recovery-import', trust: 'unverified', provider: 'peri', importId: 'import-1' })
    expect(projectWorkbench([live]).document).toEqual(projectWorkbench([restart]).document)
    expect(projectWorkbench([live]).document).toEqual(projectWorkbench([recovery]).document)
  })

  it('sorts journal sequence deterministically while identity events may arrive out of order', () => {
    const first = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'a' }] })
    const second = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'b' }] })
    expect(projectWorkbench([second, first]).document).toEqual(projectWorkbench([first, second]).document)
  })

  it('does not guess a message boundary from role when identity is missing', () => {
    const first = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'first' }] })
    const second = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'second' }] })
    expect(selectLegacyMessages(projectWorkbench([first, second]).document).map(message => message.content)).toEqual(['first', 'second'])
  })
})
