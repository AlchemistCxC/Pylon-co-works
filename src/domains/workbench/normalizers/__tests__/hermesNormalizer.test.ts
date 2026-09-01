import { describe, expect, it } from 'vitest'
import { normalizeHermesEvent } from '../hermesNormalizer.ts'
import { splitToolTitle } from '../../../tool/toolResolution.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'
import hermesToolCallStart from './fixtures/hermes-tool-call-start.json'
import hermesToolCallComplete from './fixtures/hermes-tool-call-complete.json'
import hermesStructuredResults from './fixtures/hermes-structured-results.json'

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

  it('unwraps ACP content wrappers and promotes skill output to a typed part', () => {
    const result = normalizeHermesEvent({
      sessionUpdate: 'tool_call_update', toolCallId: 'skill-output', status: 'completed',
      title: 'skill view (diagnose/SKILL.md)', kind: 'read',
      content: [{ type: 'content', content: { type: 'text', text: '**loaded**' } }],
    }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { name: 'skill_view', parts: [{ kind: 'skill', skillId: 'diagnose:SKILL.md', title: 'diagnose', source: 'hermes' }] },
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

  it('does not let null placeholder aliases hide populated Hermes fields', () => {
    const result = normalizeHermesEvent({ update: {
      sessionUpdate: 'tool_call', toolCallId: 'null-placeholder',
      name: 'terminal', kind: 'execute',
      rawInput: null, args: 'npm test',
    } }, { ...context, replay: false })
    expect(result.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { name: 'terminal', input: { command: 'npm test' }, rawInput: { command: 'npm test' } },
    })

    const completion = normalizeHermesEvent({ update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'null-output',
      name: 'terminal', status: 'completed',
      rawOutput: null, output: { stdout: 'ok', exit_code: 0 },
    } }, { ...context, replay: false })
    expect(completion.events[0].event).toMatchObject({
      type: 'tool.completed',
      result: { stdout: 'ok', exit_code: 0 },
      tool: { name: 'terminal', parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'ok' }] }] },
    })
  })

  it('accepts legacy updateType/eventType discriminators in bare and RPC-wrapped Hermes updates', () => {
    const bare = normalizeHermesEvent({
      updateType: 'tool_call_start',
      tool_call_id: 'legacy-start',
      title: 'terminal: pwd',
      kind: 'execute',
    }, { ...context, replay: false })
    expect(bare.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { toolCallId: 'legacy-start', name: 'terminal', input: { command: 'pwd' } },
    })

    const wrapped = normalizeHermesEvent({ params: {
      event_type: 'tool_call_update',
      tool_call_id: 'legacy-complete',
      name: 'terminal',
      status: 'completed',
      output: { stdout: 'done' },
    } }, { ...context, replay: false })
    expect(wrapped.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { toolCallId: 'legacy-complete', name: 'terminal' },
    })
  })

  it('resolves qualified Hermes tool titles without promoting arbitrary prose', () => {
    const qualified = normalizeHermesEvent({ update: {
      sessionUpdate: 'tool_call', toolCallId: 'qualified-search',
      title: 'hermes.tools.search_files: ACP', kind: 'search',
    } }, { ...context, replay: false })
    expect(qualified.events[0].event).toMatchObject({
      type: 'tool.started', tool: { name: 'search_files', input: { pattern: 'ACP' } },
    })

    const prose = normalizeHermesEvent({ update: {
      sessionUpdate: 'tool_call', toolCallId: 'prose-title',
      title: 'please use skill: diagnose', kind: 'read',
    } }, { ...context, replay: false })
    expect(prose.events[0].event).toMatchObject({
      type: 'tool.started', tool: { name: 'unknown' },
    })
    expect(prose.diagnostics.map(item => item.code)).toContain('tool.name.missing')
  })

  it('promotes structured Hermes search/terminal/memory results and preserves canonical names', () => {
    const search = normalizeHermesEvent({ update: {
      session_update: 'tool_call_update', tool_call_id: 'search-1', status: 'completed',
      name: 'search_files', args: { pattern: 'TODO' },
      raw_output: JSON.stringify({ files: [{ path: 'src/a.ts', line: 4, content: 'TODO here' }], total_count: 1 }),
    } }, { ...context, replay: false })
    expect(search.events[0].event).toMatchObject({
      type: 'tool.completed', tool: {
        name: 'search_files', input: { pattern: 'TODO' },
        parts: [{ kind: 'search-result', query: 'TODO', results: [{ source: 'src/a.ts', location: { path: 'src/a.ts', line: 4 } }] }],
      },
    })

    const terminal = normalizeHermesEvent({ update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'terminal-1', status: 'completed',
      title: 'terminal: npm test', output: { stdout: 'ok', exit_code: 0 },
    } }, { ...context, replay: false })
    expect(terminal.events[0].event).toMatchObject({
      type: 'tool.completed', tool: { name: 'terminal', input: { command: 'npm test' }, parts: [{ kind: 'terminal', command: 'npm test', streams: [{ stream: 'stdout', text: 'ok' }] }] },
    })

    const memory = normalizeHermesEvent({ update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'memory-1', status: 'completed',
      name: 'memory', args: { action: 'save', target: 'project' },
      result: { success: true, message: 'saved' },
    } }, { ...context, replay: false })
    expect(memory.events[0].event).toMatchObject({
      type: 'tool.completed', tool: { name: 'memory', parts: [{ kind: 'memory', memoryId: 'project', title: 'project', source: 'hermes' }] },
    })
  })

  it('keeps browser/delegation/integration title-only calls as identifiable generic tools', () => {
    for (const [name, title, kind] of [
      ['browser_snapshot', 'browser snapshot', 'read'],
      ['delegate_task', 'delegate: inspect tests', 'execute'],
      ['kanban_create', 'kanban_create: issue', 'execute'],
    ] as const) {
      const result = normalizeHermesEvent({ update: {
        sessionUpdate: 'tool_call', toolCallId: name, title, kind,
      } }, { ...context, replay: false })
      expect(result.events[0].event, name).toMatchObject({ type: 'tool.started', tool: { name, canonicalName: name } })
      expect(result.events[0].event).not.toMatchObject({ type: 'event.unknown' })
    }
  })

  it('normalizes the serialized Hermes ToolCallStart fixture without changing raw evidence', () => {
    const result = normalizeHermesEvent(hermesToolCallStart, { ...context, replay: false })
    expect(result.events[0]).toMatchObject({
      event: {
        type: 'tool.started',
        tool: {
          toolCallId: 'tc-hermes-terminal',
          name: 'terminal',
          providerName: 'terminal',
          kind: 'execute',
          input: { command: 'git status' },
        },
      },
      raw: hermesToolCallStart,
    })
    expect(result.diagnostics).toEqual([])
  })

  it('keeps the real Hermes completion shape identifiable by call id when the bridge omits tool name', () => {
    const result = normalizeHermesEvent(hermesToolCallComplete, { ...context, replay: false })
    expect(result.events[0]).toMatchObject({
      event: {
        type: 'tool.completed',
        tool: { toolCallId: 'tc-hermes-search', kind: 'search', parts: [{ kind: 'text', text: expect.stringContaining('Search results') }] },
      },
      raw: hermesToolCallComplete,
    })
    expect((result.events[0].event as { tool: Record<string, unknown> }).tool).not.toHaveProperty('name')
  })

  it('promotes Hermes JSON-prefix results and camelCase names to typed content parts', () => {
    const search = normalizeHermesEvent(hermesStructuredResults.search, { ...context, replay: false })
    expect(search.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: {
        name: 'search_files',
        parts: [{ kind: 'search-result', total: 1, results: [{ source: 'src/app.ts', location: { line: 42 } }] }],
      },
    })

    const skill = normalizeHermesEvent(hermesStructuredResults.skill, { ...context, replay: false })
    expect(skill.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { name: 'skill_view', parts: [{ kind: 'skill', skillId: 'diagnose:SKILL.md', title: 'diagnose' }] },
    })

    const terminal = normalizeHermesEvent(hermesStructuredResults.terminal, { ...context, replay: false })
    expect(terminal.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { name: 'terminal', input: { command: 'npm test' }, parts: [{ kind: 'terminal', exitCode: 0, durationMs: 12.5, truncation: { capturedBytes: 80, omittedBytes: 20 } }] },
    })

    const memory = normalizeHermesEvent(hermesStructuredResults.memory, { ...context, replay: false })
    expect(memory.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { name: 'memory', parts: [{ kind: 'memory', memoryId: 'project', summary: 'saved' }] },
    })
  })
})
