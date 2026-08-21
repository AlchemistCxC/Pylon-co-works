import { describe, expect, it } from 'vitest'
import {
  createWorkbenchEnvelope,
  migrateWorkbenchEnvelope,
  parseWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
} from '../workbenchEventSchema.ts'

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
