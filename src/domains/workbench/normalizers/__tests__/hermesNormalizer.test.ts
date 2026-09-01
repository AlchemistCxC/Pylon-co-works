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

  it('recovers title-only ACP tool names emitted by Hermes', () => {
    const skill = normalizeHermesEvent({
      sessionUpdate: 'tool_call', toolCallId: 'skill-title-only',
      title: 'skill view (diagnose/SKILL.md)', kind: 'read',
    }, { ...context, replay: false })
    expect(skill.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: {
        name: 'skill_view', canonicalName: 'skill_view', providerName: 'skill_view',
        title: 'Skill View', input: { name: 'diagnose', file_path: 'SKILL.md' },
      },
    })

    const search = normalizeHermesEvent({
      sessionUpdate: 'tool_call', toolCallId: 'search-title-only',
      title: 'search: TODO', kind: 'search',
    }, { ...context, replay: false })
    expect(search.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { name: 'search_files', canonicalName: 'search_files', providerName: 'search_files', input: { pattern: 'TODO' } },
    })
  })

  it('unwraps ACP content wrappers and preserves markdown tool output', () => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'skill-output', status: 'completed',
      title: 'skill view (diagnose/SKILL.md)', kind: 'read',
      content: [{ type: 'content', content: { type: 'text', text: '**loaded**' } }],
    }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { name: 'skill_view', parts: [{ kind: 'text', text: '**loaded**' }] },
    })
  })

  it('does not synthesize unknown identity on Hermes completion updates', () => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'skill-output', status: 'completed',
      kind: 'read', content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({ type: 'tool.completed', tool: { kind: 'read' } })
    expect((result.events[0].event as { tool: Record<string, unknown> }).tool).not.toHaveProperty('name')
    expect(result.diagnostics).toHaveLength(0)
  })

  it('does not synthesize unknown identity on snake_case completion updates', () => {
    const result = normalizeHermesEvent({
      session_update: 'tool_call_update', tool_call_id: 'search-output', status: 'completed',
      kind: 'search', content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({ type: 'tool.completed', tool: { toolCallId: 'search-output', kind: 'search' } })
    expect((result.events[0].event as { tool: Record<string, unknown> }).tool).not.toHaveProperty('name')
    expect(result.diagnostics).toHaveLength(0)
  })

  it('accepts snake_case Hermes envelopes and nested tool metadata', () => {
    const result = normalizeHermesEvent({
      params: { update: {
        session_update: 'tool_call', tool_call_id: 'search-snake',
        title: 'search: src', kind: 'search', raw_input: { pattern: 'src' },
        _meta: { pylon: { tool_name: 'search_files' } },
      } },
    }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { toolCallId: 'search-snake', name: 'search_files', input: { pattern: 'src' } },
    })
  })
})
