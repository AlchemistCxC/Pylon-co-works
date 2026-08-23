import { describe, expect, it } from 'vitest'
import { createWorkbenchEnvelope, type WorkbenchSemanticEvent } from '../events/workbenchEventSchema.ts'
import {
  createWorkbenchDocument,
  reduceWorkbenchEvent,
  selectAssist,
  selectSessionSurface,
} from '../workbenchProjector.ts'

const envelope = (sequence: number, event: WorkbenchSemanticEvent) => createWorkbenchEnvelope({
  sessionId: 'session-c14-review',
  sequence,
  recordedAt: `2026-08-24T00:00:${String(sequence).padStart(2, '0')}.000Z`,
  source: { provider: 'peri', sourceId: `c14-review-${sequence}` },
  identity: {},
  provenance: { origin: 'local-observed', trust: 'authoritative' },
  event,
})

describe('C14 normalized session and assist projection', () => {
  it('keeps only valid usage fields first-class and retains unknown leaves for audit', () => {
    const document = reduceWorkbenchEvent(createWorkbenchDocument('session-c14-review'), envelope(1, {
      type: 'usage.updated',
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 4,
        contextUsed: 25,
        contextLimit: 100,
        costUsd: 0.05,
        currency: 'USD',
        futureCounter: 7,
        calls: -1,
      },
    }))

    expect(selectSessionSurface(document).usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 4,
      contextUsed: 25,
      contextLimit: 100,
      contextPercent: 25,
      costUsd: 0.05,
      currency: 'USD',
      raw: { futureCounter: 7, calls: -1 },
    })
    expect(document.diagnostics.some(item => item.code === 'session.usage.invalid-field')).toBe(true)
  })

  it('recomputes derived context percent when a later partial usage patch changes a counter', () => {
    const document = [
      envelope(1, { type: 'usage.updated', usage: { contextUsed: 25, contextLimit: 100 } }),
      envelope(2, { type: 'usage.updated', usage: { contextUsed: 60 } }),
    ].reduce(reduceWorkbenchEvent, createWorkbenchDocument('session-c14-review'))

    expect(selectSessionSurface(document).usage).toMatchObject({
      contextUsed: 60, contextLimit: 100, contextPercent: 60,
    })
  })

  it('normalizes commands/config while retaining unknown values outside renderer settings', () => {
    const commands = envelope(1, {
      type: 'session.commands-updated',
      commands: [{ id: 'compact', name: '/compact', description: '压缩上下文', inputHint: '[focus]', availability: true, capability: 'compact', future: 'kept' }],
    })
    const config = envelope(2, {
      type: 'session.config-updated',
      options: [{ id: 'temperature', label: 'Temperature', value: { providerScale: 'adaptive' }, valueType: 'provider.custom', editable: true, schema: { type: 'object' }, version: 3, future: 'kept' }],
    })
    const document = [commands, config].reduce(reduceWorkbenchEvent, createWorkbenchDocument('session-c14-review'))

    expect(selectSessionSurface(document).commands[0]).toMatchObject({
      id: 'compact', name: '/compact', description: '压缩上下文', capability: 'compact', raw: { future: 'kept' },
    })
    expect(selectSessionSurface(document).options[0]).toMatchObject({
      id: 'temperature', value: { providerScale: 'adaptive' }, valueType: 'provider.custom', editable: false, version: 3,
      raw: { future: 'kept', value: { providerScale: 'adaptive' }, valueType: 'provider.custom' },
    })
  })

  it('projects assist events into an ephemeral document slice without transcript pollution', () => {
    const events = [
      envelope(1, { type: 'assist.prediction', placeholder: '继续修复', actions: [{ id: 'accept', label: '接受' }] }),
      envelope(2, { type: 'assist.file-suggestions', files: ['src/a.ts', 'src/b.ts'] }),
      envelope(3, { type: 'assist.queued-command', command: '/compact' }),
    ]
    const live = events.reduce(reduceWorkbenchEvent, createWorkbenchDocument('session-c14-review'))

    expect(selectAssist(live)).toEqual({
      prediction: { placeholder: '继续修复', actions: [{ id: 'accept', label: '接受' }] },
      files: ['src/a.ts', 'src/b.ts'],
      queuedCommand: '/compact',
    })
    expect(live.messages).toEqual([])
    expect(live.timeline.map(item => item.kind)).toEqual(['assist', 'assist', 'assist'])
  })
})
