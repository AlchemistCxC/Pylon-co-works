import { afterEach, describe, expect, it } from 'vitest'
import { clearToolRegistryForTests, registerToolRegistryEntry } from '../../../tool/toolRegistry.ts'
import { normalizeAcpEvent } from '../acpNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const context: NormalizeContext = {
  provider: 'peri',
  sessionId: 'session-1',
  sourceId: 'wire-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
}

afterEach(() => clearToolRegistryForTests())

describe('ACP normalizer', () => {
  it('normalizes text and tool wire shapes into A01 envelopes', () => {
    registerToolRegistryEntry({ provider: 'peri', name: 'read_file', kind: 'read', action: 'read' })
    const text = normalizeAcpEvent({
      source: 'peri',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello', messageId: 'm-1' } },
    }, context)
    expect(text.events[0].event).toMatchObject({
      type: 'message.delta',
      role: 'assistant',
      parts: [{ kind: 'text', text: 'hello' }],
    })
    expect(text.events[0].identity.messageId).toBe('m-1')

    const tool = normalizeAcpEvent({
      source: 'peri',
      update: { sessionUpdate: 'tool_call', toolCallId: 't-1', title: 'read_file', rawInput: { path: 'a.ts' } },
    }, { ...context, sequence: 2 })
    expect(tool.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { toolCallId: 't-1', name: 'read_file', kind: 'read', action: 'read' },
    })
  })

  it('keeps good blocks and turns malformed/unknown blocks into visible unknown content', () => {
    const result = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: [
          { type: 'text', text: 'good' },
          { type: 'future_block', payload: { value: 1 } },
          42,
        ],
      },
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'message.delta',
      parts: [
        { kind: 'text', text: 'good' },
        { kind: 'unknown', originalType: 'future_block' },
        { kind: 'unknown', originalType: 'malformed' },
      ],
    })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'peri', wireKind: 'agent_message_chunk', recoverable: true }),
    ]))
  })

  it('preserves unknown wire events and changes only provenance between live and replay', () => {
    const live = normalizeAcpEvent({ source: 'peri', update: { sessionUpdate: 'future_event', payload: { x: 1 } } }, context)
    const replay = normalizeAcpEvent({ source: 'peri', update: { sessionUpdate: 'future_event', payload: { x: 1 } } }, {
      ...context,
      provenance: { origin: 'recovery-import', trust: 'unverified', provider: 'peri', importId: 'import-1' },
    })
    expect(live.events[0].event).toEqual(replay.events[0].event)
    expect(live.events[0].provenance).not.toEqual(replay.events[0].provenance)
    expect(live.events[0].event.type).toBe('event.unknown')
  })
})
