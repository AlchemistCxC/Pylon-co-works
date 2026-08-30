import { describe, expect, it } from 'vitest'
import { normalizeHermesEvent } from '../hermesNormalizer.ts'
import { splitToolTitle } from '../../../tool/toolResolution.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

const context: NormalizeContext = {
  provider: 'hermes',
  sessionId: 'hermes-session',
  sourceId: 'replay-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  replay: true,
  provenance: { origin: 'recovery-import', trust: 'unverified', provider: 'hermes', importId: 'hermes-import-1' },
}

describe('Hermes normalizer', () => {
  it('sanity parses colon titles', () => {
    expect(splitToolTitle('execute_code: print(1)')).toEqual({ name: 'execute_code', summary: 'print(1)' })
  })
  it('marks grouped replay ordering without changing semantic payload', () => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'replayed' },
      _meta: { hermesReplay: true },
    }, context)
    expect(result.events[0]).toMatchObject({
      provenance: { origin: 'recovery-import', trust: 'unverified', orderConfidence: 'grouped', collectionComplete: true },
      event: { type: 'message.delta', role: 'assistant' },
    })
  })

  it('does not guess incomplete delegation/media shapes', () => {
    const result = normalizeHermesEvent({ sessionUpdate: 'delegate', payload: { id: 'missing-target' } }, context)
    expect(result.events[0].event).toMatchObject({ type: 'event.unknown', originalType: 'delegate' })
    expect(result.diagnostics[0]).toMatchObject({ provider: 'hermes', recoverable: true })
  })

  it('canonicalizes terminal preview titles into machine identity plus command input', () => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'terminal-1',
      title: 'terminal: git status --short',
      kind: 'execute',
    }, { ...context, replay: false })

    expect(result.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: {
        name: 'terminal',
        providerName: 'terminal',
        title: 'Terminal',
        input: { command: 'git status --short' },
        kind: 'execute',
        action: 'execute',
      },
    })
    expect(result.events[0].raw).toMatchObject({ title: 'terminal: git status --short' })
  })

  it.each([
    ['execute_code', 'execute_code: print(1)', 'print(1)', { code: 'print(1)' }],
    ['terminal', 'terminal', 'ls', { command: 'ls' }],
    ['process', 'process: restart worker', 'restart worker', { command: 'restart worker' }],
  ])('normalizes %s argument aliases without leaking them into the tool name', (name, title, preview, input) => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'tool_call', toolCallId: `tool-${name}`, name, title,
      kind: 'execute', preview,
    }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({
      tool: { name, title: name === 'execute_code' ? 'Execute Code' : name[0]!.toUpperCase() + name.slice(1), input },
    })
  })
})
