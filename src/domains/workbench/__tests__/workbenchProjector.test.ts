import { describe, expect, it } from 'vitest'
import {
  createWorkbenchDocument,
  projectWorkbench,
  reduceWorkbenchEvent,
  selectActivities,
  selectInteractions, selectPendingInteractions,
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
      tool: { toolCallId: 'tool-1', name: 'read', semanticKind: 'tool.read', parentActivityId: 'parent-1', status: 'completed' },
    }, { toolCallId: 'tool-1' })
    const duplicate = reduceWorkbenchEvent(reduceWorkbenchEvent(createWorkbenchDocument(base.sessionId), toolUpdate), toolUpdate)
    expect(duplicate.appliedEventIds).toEqual([toolUpdate.eventId])
    expect(selectActivities(duplicate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'tool-1', parentId: 'parent-1', semanticKind: 'tool.read', orphan: true }),
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
    // C11 语义升级：selectInteractions 返回全量（resolved 仍可审计）；待处理队列为空
    expect(selectInteractions(document)).toHaveLength(1)
    expect(selectInteractions(document)[0]).toMatchObject({ id: 'ask-1', status: 'resolved' })
    expect(selectPendingInteractions(document)).toEqual([])
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

  it('aggregates contiguous same-role chunks when the provider omits message identity', () => {
    const first = envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'first' }] })
    const second = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'second' }] })
    expect(selectLegacyMessages(projectWorkbench([first, second]).document).map(message => message.content)).toEqual(['firstsecond'])
  })

  it('aggregates one assistant stream when the provider rotates identity on every chunk', () => {
    const chunks = [
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '这' }] }, { messageId: 'chunk-1' }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '是' }] }, { messageId: 'chunk-2' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: ' complete' }] }, { messageId: 'chunk-3' }),
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: ' answer' }] }, { messageId: 'chunk-4' }),
    ]

    expect(selectLegacyMessages(projectWorkbench(chunks).document).map(message => message.content))
      .toEqual(['这是 complete answer'])
  })

  it('keeps assistant streams separated across a tool boundary even when identity is reused', () => {
    const document = reduce([
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'before tool' }] }, { messageId: 'turn-message' }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'after tool' }] }, { messageId: 'turn-message' }),
    ])

    expect(document.messages.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual(['before tool', 'after tool'])
  })

  it('keeps identity-less chunks separated across a tool boundary', () => {
    const document = reduce([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'before tool' }] }),
      envelope(2, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read' } }, { toolCallId: 'tool-1' }),
      envelope(3, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'after tool' }] }),
    ])
    expect(document.messages.filter(message => message.role === 'reasoning').map(message => message.content))
      .toEqual(['before tool', 'after tool'])
  })

  it('settles every running message when the session completes', () => {
    const document = reduce([
      envelope(1, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'thinking' }] }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] }),
      envelope(3, { type: 'session.completed', stopReason: 'end_turn' }),
    ])
    expect(document.messages.map(message => message.running)).toEqual([false, false])
  })

  it('folds adjacent optimistic and authoritative copies of the same user message', () => {
    const optimistic = envelope(
      1,
      { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'one prompt' }] },
      { interactionId: 'client-1' },
      { origin: 'optimistic-local', trust: 'unverified' },
    )
    const authoritative = envelope(
      2,
      { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'one prompt' }] },
      {},
      { origin: 'local-observed', trust: 'authoritative' },
    )
    const messages = projectWorkbench([optimistic, authoritative]).document.messages
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: authoritative.eventId, content: 'one prompt', identity: {} })
  })

  it('folds a late optimistic append even after assistant chunks won the persistence race', () => {
    const authoritative = envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'prompt' }] })
    const assistant = envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }] })
    const optimistic = envelope(3,
      { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'prompt' }] },
      { interactionId: 'client-late' }, { origin: 'optimistic-local', trust: 'unverified' })
    expect(projectWorkbench([authoritative, assistant, optimistic]).document.messages.map(message => message.content))
      .toEqual(['prompt', 'answer'])
  })
})
