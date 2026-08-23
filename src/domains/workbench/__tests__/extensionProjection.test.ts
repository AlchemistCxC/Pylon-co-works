import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope, parseWorkbenchEnvelope } from '../events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench, reduceWorkbenchEvent, selectExtensions } from '../workbenchProjector.ts'
import { createWorkbenchRuntime } from '../workbenchRuntime.ts'

const envelope = createWorkbenchEnvelope({
  sessionId: 'session-c15', sequence: 4, recordedAt: '2026-08-24T00:00:00.000Z',
  source: { provider: 'peri', sourceId: 'plugin-event-1' }, identity: {},
  provenance: { origin: 'local-observed', trust: 'authoritative' },
  event: {
    type: 'extension.event', kind: 'plugin.demo/result', payload: { status: 'completed', summary: 'done' },
    fallback: [{ kind: 'unknown', originalType: 'plugin.demo/result', summary: 'unknown plugin event', raw: { status: 'completed' }, truncated: false }],
  },
})

describe('C15 extension projection', () => {
  it('rejects malformed namespaced kinds at the journal read seam', () => {
    const malformed = { ...envelope, event: { ...envelope.event, kind: '.plugin' } }
    expect(parseWorkbenchEnvelope(malformed).ok).toBe(false)
  })

  it('projects namespaced events into a durable document slice with source/provenance', () => {
    const document = reduceWorkbenchEvent(createWorkbenchDocument('session-c15'), envelope)
    expect(selectExtensions(document)).toEqual([expect.objectContaining({
      id: envelope.eventId, kind: 'plugin.demo/result', sequence: 4,
      payload: { status: 'completed', summary: 'done' },
      source: { provider: 'peri', sourceId: 'plugin-event-1' },
      provenance: { origin: 'local-observed', trust: 'authoritative' },
    })])
    expect(document.timeline[0]?.kind).toBe('extension')
  })

  it('keeps live apply and replay projection deeply equal and freezes nested payload', () => {
    const replay = projectWorkbench([envelope], { initialDocument: createWorkbenchDocument('session-c15') }).document
    const live = reduceWorkbenchEvent(createWorkbenchDocument('session-c15'), envelope)
    expect(live).toEqual(replay)

    const runtime = createWorkbenchRuntime({ sessionId: 'session-c15', status: 'ready', messages: [], streamingText: '', streamingThinking: '', generating: false, generationStart: 0, tokenCount: 0, summary: null, tasks: [], availableModels: [], activeModel: '', availableModes: [], activeMode: '', canAttach: false, promptImage: false, error: null, document: createWorkbenchDocument('session-c15') })
    runtime.applyDocument(live)
    const extension = runtime.getSnapshot().document!.extensions[0]!
    expect(Object.isFrozen(extension)).toBe(true)
    expect(Object.isFrozen(extension.payload)).toBe(true)
    expect(runtime.getSlice('extensions')).toEqual([extension])
  })
})
