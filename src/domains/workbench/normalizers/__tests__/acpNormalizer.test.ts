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
      update: { sessionUpdate: 'tool_call', toolCallId: 't-1', name: 'ProviderRead', title: '读取文件', _meta: { pylon: { toolName: 'read_file' } }, rawInput: { path: 'a.ts' } },
    }, { ...context, sequence: 2 })
    expect(tool.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: {
        toolCallId: 't-1', name: 'read_file', providerName: 'ProviderRead', kind: 'read', action: 'read',
        input: { path: 'a.ts' }, rawInput: { path: 'a.ts' },
      },
    })
  })

  it('narrows generic lifecycle metadata without making renderer read ACP raw', () => {
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'tool-progress', status: 'failed',
        progress: { completed: 1, total: 3, message: 'reading' },
        locations: [{ path: '/workspace/a.ts', line: 4 }],
        durationMs: 1250, error: { message: 'permission denied', code: 'EACCES', retryable: false },
      },
    }, context)

    expect(result.events[0].event).toMatchObject({
      type: 'tool.failed',
      tool: {
        progress: { completed: 1, total: 3, message: 'reading' },
        locations: [{ path: '/workspace/a.ts', line: 4 }],
        durationMs: 1250,
        error: { message: 'permission denied', code: 'EACCES', retryable: false },
      },
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

  it('keeps structured blocks typed from ACP wire through the semantic event seam', () => {
    const result = normalizeAcpEvent({
      source: 'peri',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: [
          { type: 'progress', current: 2, total: 4, message: 'working' },
          { type: 'list', title: 'results', items: [{ type: 'code', text: 'const ok = true', language: 'ts' }] },
          { type: 'tool_result', name: 'Search', status: 'completed', content: [{ type: 'location', path: '/workspace/a.ts', line: 7 }] },
        ],
      },
    }, context)

    expect(result.events[0].event).toMatchObject({
      type: 'message.delta',
      role: 'assistant',
      parts: [
        { kind: 'progress', current: 2, total: 4, message: 'working' },
        { kind: 'list', items: [{ kind: 'code', text: 'const ok = true', language: 'ts' }] },
        { kind: 'tool-result', content: [{ kind: 'location', path: '/workspace/a.ts', line: 7 }] },
      ],
    })
    expect(result.diagnostics).toEqual([])
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

  it('normalizes ACP error as a provider.error semantic event so projection can settle the stream', () => {
    const result = normalizeAcpEvent({
      update: { sessionUpdate: 'error', errorCode: 'protocol_error', error: 'transport failed' },
    }, context)

    expect(result.events[0].event).toEqual({
      type: 'diagnostic.notice',
      level: 'error',
      message: 'transport failed',
      code: 'provider.error',
    })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'provider.error', message: 'transport failed' }),
    ]))
  })

  it.each([
    ['tool_call', undefined],
    ['tool_call_update', 'completed'],
  ])('uses _meta.pylon.toolName for %s and never treats localized title as machine identity', (sessionUpdate, status) => {
    registerToolRegistryEntry({ provider: 'claude-code', name: 'Agent', aliases: ['Task'], kind: 'execute', action: 'delegate', capabilities: ['delegate'] })
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate,
        toolCallId: 'tool-meta',
        title: '启动子代理（本地化）',
        ...(status ? { status } : {}),
        _meta: { pylon: { toolName: 'Task' } },
      },
    }, { ...context, provider: 'claude-code', replay: sessionUpdate === 'tool_call_update' })
    expect(result.events[0].event).toMatchObject({
      tool: { name: 'Task', canonicalName: 'Agent', title: '启动子代理（本地化）', capabilities: ['delegate'] },
    })
  })

  it('falls back to generic tool semantics and a diagnostic when machine name is missing', () => {
    const result = normalizeAcpEvent({
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-missing', title: 'Read file.txt' },
    }, context)
    expect(result.events[0].event).toMatchObject({ tool: { name: 'unknown', title: 'Read file.txt', kind: 'other', action: 'unknown' } })
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'tool.name.missing' })]))
  })

  it('keeps Claude parentToolUseId out of identity.taskId (parent belongs to source/tool edge)', () => {
    const result = normalizeAcpEvent({
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'child-tool',
        _meta: { claudeCode: { parentToolUseId: 'parent-tool' } },
        name: 'Bash',
      },
    }, { ...context, provider: 'claude-code' })

    expect(result.events[0]?.identity).not.toHaveProperty('taskId', 'parent-tool')
    expect(result.events[0]?.event).toMatchObject({
      type: 'tool.started',
      tool: { toolCallId: 'child-tool', parentToolUseId: 'parent-tool' },
    })
  })

  it('promotes only standard C14 wire fields into canonical usage/commands/config names', () => {
    const usage = normalizeAcpEvent({ update: {
      sessionUpdate: 'usage_update', used: 30, size: 200,
      cost: { amount: 0.01, currency: 'USD' },
      _meta: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 4 },
      usage: { cacheWriteTokens: 2, vendorFuture: 9 },
    } }, context)
    expect(usage.events[0].event).toEqual({
      type: 'usage.updated', usage: {
        inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheWriteTokens: 2,
        contextUsed: 30, contextLimit: 200, costUsd: 0.01, currency: 'USD', vendorFuture: 9,
      },
    })

    const commands = normalizeAcpEvent({ update: { sessionUpdate: 'available_commands_update', commands: [
      { name: 'review', input_hint: ' <scope>', description: 'Review changes' },
    ] } }, context)
    expect(commands.events[0].event).toEqual({ type: 'session.commands-updated', commands: [
      { id: 'review', name: '/review', inputHint: ' <scope>', description: 'Review changes' },
    ] })

    const config = normalizeAcpEvent({ update: { sessionUpdate: 'config_option_update', configOptions: [
      { id: 'model', name: 'Model', currentValue: 'gpt-5', type: 'select', options: [{ value: 'gpt-5' }], version: 3 },
    ] } }, context)
    expect(config.events[0].event).toEqual({ type: 'session.config-updated', options: [
      { id: 'model', label: 'Model', value: 'gpt-5', valueType: 'select', editable: true, schema: { options: [{ value: 'gpt-5' }] }, version: 3 },
    ] })
  })

  it('defaults unknown config kinds to read-only while keeping ACP select/boolean editable', () => {
    const result = normalizeAcpEvent({ update: { sessionUpdate: 'config_option_update', configOptions: [
      { id: 'model', name: 'Model', currentValue: 'gpt-5', type: 'select', options: [{ value: 'gpt-5' }] },
      { id: 'thinking', name: 'Thinking', currentValue: true, type: 'boolean' },
      { id: 'vendor-shape', name: 'Vendor shape', currentValue: { mode: 'adaptive' }, type: 'provider.custom' },
    ] } }, context)

    expect(result.events[0].event).toMatchObject({ type: 'session.config-updated', options: [
      { id: 'model', value: 'gpt-5', valueType: 'select', editable: true },
      { id: 'thinking', value: true, valueType: 'boolean', editable: true },
      {
        id: 'vendor-shape', value: { mode: 'adaptive' }, valueType: 'provider.custom', editable: false,
        raw: { value: { mode: 'adaptive' }, valueType: 'provider.custom' },
      },
    ] })
  })

  it('normalizes snake-case config ids and nested value ids without losing machine choices', () => {
    const result = normalizeAcpEvent({ update: {
      session_update: 'config_option_update',
      config_options: [{
        config_id: 'thought_level',
        label: 'Thinking level',
        current_value: { value_id: { value: 'high' } },
        value_type: 'select',
        schema: { enum: [{ value_id: 'low', name: 'Low' }, { value_id: 'high', name: 'High' }] },
      }],
    } }, context)

    expect(result.events[0].event).toMatchObject({
      type: 'session.config-updated',
      options: [{
        id: 'thought_level',
        value: 'high',
        valueType: 'select',
        editable: true,
        schema: { options: [{ value_id: 'low', name: 'Low' }, { value_id: 'high', name: 'High' }] },
      }],
    })
  })
})
