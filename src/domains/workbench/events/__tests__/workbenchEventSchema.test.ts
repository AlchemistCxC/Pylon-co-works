import { describe, expect, it } from 'vitest'
import {
  CANONICAL_SEMANTIC_PROJECTION_REGISTRY,
  createWorkbenchEnvelope,
  migrateWorkbenchEnvelope,
  parseWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
} from '../workbenchEventSchema.ts'
import { CANONICAL_EVENT_TYPES } from '../../../events/eventSchema.ts'
import type { JsonValue } from '../../content/contentPartSchema.ts'

const source = { provider: 'peri', sourceId: 'wire-1', agentId: 'agent-1' } as const

const textEvent = {
  type: 'message.delta',
  role: 'assistant',
  parts: [{ kind: 'text', text: 'hello' }],
} as const

function envelope(overrides: Partial<WorkbenchEventEnvelope> = {}): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: 'session-1',
    sequence: 1,
    recordedAt: '2026-08-21T00:00:00.000Z',
    source,
    identity: { messageId: 'message-1' },
    provenance: { origin: 'local-observed', trust: 'authoritative' },
    event: textEvent,
    ...overrides,
  })
}

describe('Workbench event envelope schema', () => {
  it('has a renderer-facing projection vector for every canonical event type', () => {
    const expectedTypes: Record<(typeof CANONICAL_EVENT_TYPES)[number], string> = {
      'user.message': 'message.delta',
      'assistant.text.delta': 'message.delta',
      'assistant.thinking.delta': 'reasoning.delta',
      'tool.call.started': 'tool.started',
      'tool.call.updated': 'tool.progress',
      'tool.call.completed': 'tool.completed',
      'tool.call.failed': 'tool.failed',
      'interaction.requested': 'interaction.requested',
      'interaction.answered': 'interaction.resolved',
      'turn.completed': 'session.completed',
      'turn.failed': 'diagnostic.notice',
      'usage.updated': 'usage.updated',
      'plan.replaced': 'plan.replaced',
      'session.mode-updated': 'session.mode-updated',
      'session.model-updated': 'session.model-updated',
      'session.config-updated': 'session.config-updated',
      'session.commands-updated': 'session.commands-updated',
      'history.snapshot': 'event.unknown',
      unknown: 'event.unknown',
    }
    const fixtures: Record<string, { typed: Record<string, JsonValue>; text?: string }> = {
      'user.message': { typed: { text: 'question' }, text: 'question' },
      'assistant.text.delta': { typed: { text: 'answer' }, text: 'answer' },
      'assistant.thinking.delta': { typed: { text: 'thinking' }, text: 'thinking' },
      'tool.call.started': { typed: { tool: { name: 'Read' } } },
      'tool.call.updated': { typed: { tool: { name: 'Read' }, progress: { percent: 50 } } },
      'tool.call.completed': { typed: { tool: { name: 'Read' }, result: { ok: true } } },
      'tool.call.failed': { typed: { tool: { name: 'Read' }, result: { ok: false } } },
      'interaction.requested': { typed: { interactionId: 'ask-1' } },
      'interaction.answered': { typed: { interactionId: 'ask-1', response: { optionId: 'allow' } } },
      'turn.completed': { typed: { stopReason: 'end_turn', usage: { outputTokens: 2 }, model: 'model-1' } },
      'turn.failed': { typed: { error: 'failed', code: 'turn.failed' } },
      'usage.updated': { typed: { usage: { inputTokens: 3 } } },
      'plan.replaced': { typed: { entries: [{ id: 'step-1', content: 'Inspect' }] } },
      'session.mode-updated': { typed: { mode: 'auto' } },
      'session.model-updated': { typed: { model: 'model-1' } },
      'session.config-updated': { typed: { options: [{ id: 'reasoning', value: 'high' }] } },
      'session.commands-updated': { typed: { commands: [{ name: '/compact' }] } },
      'history.snapshot': { typed: { checkpoint: 'replay-1' } },
      unknown: { typed: { future: true } },
    }

    for (const eventType of CANONICAL_EVENT_TYPES) {
      const projection = CANONICAL_SEMANTIC_PROJECTION_REGISTRY[eventType]
      expect(projection, `${eventType} registry entry`).toBeTypeOf('function')
      const fixture = fixtures[eventType]!
      const event = projection({ ...fixture, raw: { eventType, fixture: true } })
      expect(event.type, `${eventType} semantic type`).toBe(expectedTypes[eventType])
    }
  })

  it('keeps config and command payloads on their session semantic surfaces', () => {
    const config = migrateWorkbenchEnvelope({
      owner: { localSessionId: 'session-1' }, sequence: 9, eventType: 'session.config-updated', rawPayload: {},
      typedPayload: { options: [{ id: 'model', value: 'model-1' }] },
    })
    const commands = migrateWorkbenchEnvelope({
      owner: { localSessionId: 'session-1' }, sequence: 10, eventType: 'session.commands-updated', rawPayload: {},
      typedPayload: { commands: [{ name: '/compact' }] },
    })
    expect(config.ok).toBe(true)
    expect(commands.ok).toBe(true)
    if (config.ok) expect(config.value.event).toEqual({ type: 'session.config-updated', options: [{ id: 'model', value: 'model-1' }] })
    if (commands.ok) expect(commands.value.event).toEqual({ type: 'session.commands-updated', commands: [{ name: '/compact' }] })
  })

  it.each([
    ['tool.started', 'tool.started'],
    ['tool.call.started', 'tool.started'],
    ['tool.call.updated', 'tool.progress'],
    ['tool.call.completed', 'tool.completed'],
    ['tool.call.failed', 'tool.failed'],
    ['assistant.reasoning.delta', 'reasoning.delta'],
    ['assistant.thinking.delta', 'reasoning.delta'],
    ['plan.replaced', 'plan.replaced'],
    ['usage.updated', 'usage.updated'],
    ['turn.completed', 'session.completed'],
    ['turn.failed', 'diagnostic.notice'],
    ['session.completed', 'session.completed'],
  ])('migrates %s into typed semantic event %s', (eventType, expectedType) => {
    const result = migrateWorkbenchEnvelope({
      owner: { localSessionId: 'session-1' }, sequence: 2, eventType,
      rawPayload: { typed: true }, typedPayload: { text: 'x', entries: [], usage: { input: 1 }, stopReason: 'end' },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.event.type).toBe(expectedType)
  })

  it('keeps additive completion fields and cancellation reason at the semantic seam', () => {
    const completed = migrateWorkbenchEnvelope({
      owner: { localSessionId: 'session-1' }, sequence: 6, eventType: 'turn.completed', rawPayload: {},
      typedPayload: { stopReason: 'end_turn', usage: { inputTokens: 2 }, model: 'hermes-1' },
    })
    expect(completed.ok).toBe(true)
    if (completed.ok) expect(completed.value.event).toMatchObject({
      type: 'session.completed', stopReason: 'end_turn', usage: { inputTokens: 2 }, model: 'hermes-1',
    })

    const cancelled = migrateWorkbenchEnvelope({
      owner: { localSessionId: 'session-1' }, sequence: 7, eventType: 'turn.failed', rawPayload: {},
      typedPayload: { stopReason: 'cancelled' },
    })
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.value.event).toMatchObject({ type: 'diagnostic.notice', code: 'turn.failed' })
  })

  it.each([
    ['plan.entry-updated', 'plan.entry-updated'],
    ['goal.updated', 'goal.updated'],
    ['activity.completed', 'activity.completed'],
    ['session.model-updated', 'session.model-updated'],
    ['session.mode-updated', 'session.mode-updated'],
    ['session.status-updated', 'session.status-updated'],
  ])('preserves typed migration for %s', (eventType, expectedType) => {
    const result = migrateWorkbenchEnvelope({ owner: { localSessionId: 'session-1' }, sequence: 3, eventType, rawPayload: {}, typedPayload: { goalId: 'g', model: 'm', mode: 'auto', status: 'running', entry: {} } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.event.type).toBe(expectedType)
  })

  it('does not synthesize an interaction identity during migration', () => {
    const result = migrateWorkbenchEnvelope({ owner: { localSessionId: 'session-1' }, sequence: 4, eventType: 'interaction.requested', rawPayload: { request: true }, typedPayload: {} })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.event.type).toBe('event.unknown')
  })

  it('maps canonical interaction.answered to a resolved interaction with response', () => {
    const result = migrateWorkbenchEnvelope({
      owner: { localSessionId: 'session-1' }, sequence: 8, eventType: 'interaction.answered', rawPayload: {},
      typedPayload: { interactionId: 'ask-1', response: { optionId: 'allow' } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.event).toEqual({
      type: 'interaction.resolved', interactionId: 'ask-1', response: { optionId: 'allow' },
    })
  })

  it.each([['lifecycle.recovered'], ['diagnostic.notice']])('migrates %s without unknown fallback', eventType => {
    const result = migrateWorkbenchEnvelope({ owner: { localSessionId: 'session-1' }, sequence: 5, eventType, rawPayload: {}, typedPayload: { reason: 'retry', level: 'info', message: 'ok' } })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.event.type).toBe(eventType)
  })

  it.each([
    ['known text event', envelope()],
    ['unknown event', envelope({
      event: {
        type: 'event.unknown',
        originalType: 'provider.future_event',
        summary: 'future event',
        raw: { value: 1 },
        truncated: false,
      },
    })],
  ])('%s parses and round-trips without losing semantic data', (_name, input) => {
    const parsed = parseWorkbenchEnvelope(JSON.parse(JSON.stringify(input)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual(input)
    expect(parseWorkbenchEnvelope(JSON.parse(JSON.stringify(parsed.value)))).toEqual(parsed)
  })

  it('derives a stable event id without array position or current time', () => {
    const first = envelope({ identity: {} })
    const second = envelope({ identity: {} })
    expect(first.eventId).toBe(second.eventId)
    expect(first.eventId).not.toMatch(/undefined|NaN/)
  })

  it.each([
    { origin: 'local-observed', trust: 'unverified' },
    { origin: 'recovery-import', trust: 'authoritative' },
  ] as const)('rejects invalid provenance %#', provenance => {
    const result = parseWorkbenchEnvelope(envelope({ provenance }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some(issue => issue.code === 'provenance.trust')).toBe(true)
  })

  it('migrates a version zero envelope at the read seam', () => {
    const legacy = {
      ...envelope(),
      schemaVersion: 0,
    }
    const migrated = migrateWorkbenchEnvelope(legacy)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.value.schemaVersion).toBe(1)
  })

  it('adds structured metadata when envelope raw exceeds the journal cap', () => {
    const created = createWorkbenchEnvelope({
      sessionId: 'session-1',
      sequence: 2,
      recordedAt: '2026-08-21T00:00:00.000Z',
      source,
      provenance: { origin: 'local-observed', trust: 'authoritative' },
      event: textEvent,
      raw: { payload: 'x'.repeat(70_000) },
      rawMaxBytes: 512,
    })
    expect(created.rawMetadata?.truncated).toBe(true)
    expect(created.rawMetadata?.omittedBytes).toBeGreaterThan(0)
    expect(parseWorkbenchEnvelope(created).ok).toBe(true)
  })
})
