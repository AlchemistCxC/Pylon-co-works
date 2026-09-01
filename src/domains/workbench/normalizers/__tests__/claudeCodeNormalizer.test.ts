import { describe, expect, it } from 'vitest'
import { normalizeClaudeCodeEvent } from '../claudeCodeNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'
import claudeAcpWire from './fixtures/claude-acp-wire.json'

const context: NormalizeContext = {
  provider: 'claude-code',
  sessionId: 'claude-session',
  sourceId: 'claude-wire-1',
  sequence: 1,
  recordedAt: '2026-08-21T00:00:00.000Z',
  provenance: { origin: 'local-observed', trust: 'authoritative' },
}

describe('Claude Code normalizer', () => {
  it('keeps parentToolUseId in semantic tool metadata and never requires renderer raw access', () => {
    const result = normalizeClaudeCodeEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Bash',
      rawInput: { command: 'pwd' },
      _meta: { claudeCode: { parentToolUseId: 'parent-1', toolName: 'Bash' } },
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { toolCallId: 'tool-1', name: 'Bash', parentToolUseId: 'parent-1' },
    })
  })

  it('normalizes Claude image attachment into a semantic image part', () => {
    const result = normalizeClaudeCodeEvent({
      sessionUpdate: 'agent_message_chunk',
      content: [{ type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } }],
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'message.delta',
      parts: [{ kind: 'image', source: 'AAAA', mimeType: 'image/png' }],
    })
  })

  it('accepts snake-case Claude metadata in nested ACP params and preserves the exact wire as raw evidence', () => {
    const wire = {
      params: {
        session_id: 'claude-session',
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-snake',
          message_id: 'message-snake',
          title: '读取文件（本地化标题）',
          kind: 'read',
          raw_input: { file_path: 'README.md' },
          _meta: {
            claude_code: {
              tool_name: 'Read',
              parent_tool_use_id: 'parent-snake',
            },
          },
        },
      },
    }
    const result = normalizeClaudeCodeEvent(wire, context)
    expect(result.events[0]).toMatchObject({
      identity: { toolCallId: 'tool-snake', messageId: 'message-snake' },
      source: { parentAgentId: 'parent-snake' },
      event: {
        type: 'tool.started',
        tool: {
          toolCallId: 'tool-snake',
          name: 'Read',
          parentToolUseId: 'parent-snake',
          input: { file_path: 'README.md' },
        },
      },
    })
    expect(result.events[0].raw).toEqual(wire)
  })

  it('normalizes the actual Claude ACP image shape and direct structured content wrappers', () => {
    const result = normalizeClaudeCodeEvent({
      sessionUpdate: 'agent_message_chunk',
      content: [
        { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
        { type: 'content', content: { type: 'resource_link', uri: 'file:///README.md', name: 'README.md', mimeType: 'text/markdown' } },
      ],
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'message.delta',
      parts: [
        { kind: 'image', source: 'AAAA', sourceKind: 'base64', mimeType: 'image/png' },
        { kind: 'resource', uri: 'file:///README.md', title: 'README.md', mimeType: 'text/markdown' },
      ],
    })
  })

  it('creates a cautious NotebookEdit diff only when its required fields are explicit', () => {
    const result = normalizeClaudeCodeEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'notebook-1',
      _meta: { claudeCode: { toolName: 'NotebookEdit' } },
      rawInput: {
        notebook_path: 'analysis.ipynb',
        new_source: 'print("ok")',
        cell_id: 'cell-1',
        edit_mode: 'replace',
      },
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: {
        name: 'NotebookEdit',
        parts: [{ kind: 'diff', path: 'analysis.ipynb', newText: 'print("ok")', status: 'replace' }],
      },
    })
  })

  it('maps a direct redacted_thinking update to reasoning.redacted without exposing its body', () => {
    const result = normalizeClaudeCodeEvent({
      session_update: 'redacted_thinking',
      message_id: 'redacted-1',
      reason: 'provider_policy',
      text: 'secret reasoning must not be displayed',
    }, context)
    expect(result.events[0]).toMatchObject({
      identity: { messageId: 'redacted-1' },
      event: {
        type: 'reasoning.redacted',
        reason: 'provider_policy',
        parts: [{ kind: 'redacted-reasoning', reason: 'provider_policy' }],
      },
    })
    expect(JSON.stringify(result.events[0].event)).not.toContain('secret reasoning')
    expect(result.events[0].raw).toEqual(expect.objectContaining({ text: 'secret reasoning must not be displayed' }))
  })

  it('does not promote a localized title to machine identity when Claude metadata is absent', () => {
    const result = normalizeClaudeCodeEvent({
      sessionUpdate: 'tool_call',
      toolCallId: 'title-only',
      title: '读取文件 README.md',
      kind: 'read',
    }, context)
    expect(result.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { name: 'unknown', kind: 'read' },
    })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tool.name.missing' }),
    ]))
  })

  it('normalizes the captured Claude ACP lifecycle fixture and retains parent linkage', () => {
    const start = normalizeClaudeCodeEvent(claudeAcpWire.start, context)
    expect(start.events[0]).toMatchObject({
      event: {
        type: 'tool.started',
        tool: {
          toolCallId: 'cc-bash-1', name: 'Bash', kind: 'execute',
          input: { command: 'npm test' }, parentToolUseId: 'cc-parent-1',
        },
      },
      source: { parentAgentId: 'cc-parent-1' },
      raw: claudeAcpWire.start,
    })

    const progress = normalizeClaudeCodeEvent(claudeAcpWire.progress, context)
    expect(progress.events[0].event).toMatchObject({
      type: 'tool.progress',
      tool: { toolCallId: 'cc-bash-1', name: 'Bash', status: 'in_progress', parentToolUseId: 'cc-parent-1' },
    })

    const complete = normalizeClaudeCodeEvent(claudeAcpWire.complete, context)
    expect(complete.events[0].event).toMatchObject({
      type: 'tool.completed',
      tool: { name: 'Bash', rawOutput: { type: 'bash_code_execution_result' }, parts: [{ kind: 'text', text: 'all tests passed' }] },
    })
  })

  it('keeps Claude Write/Edit diffs typed, including Write oldText=null semantics', () => {
    const write = normalizeClaudeCodeEvent(claudeAcpWire.write, context)
    expect(write.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { name: 'Write', kind: 'edit', parts: [{ kind: 'diff', path: 'src/new.ts', oldText: '', newText: 'export const ok = true' }] },
    })
    const edit = normalizeClaudeCodeEvent(claudeAcpWire.edit, context)
    expect(edit.events[0].event).toMatchObject({
      type: 'tool.started',
      tool: { name: 'Edit', kind: 'edit', parts: [{ kind: 'diff', path: 'src/app.ts', oldText: 'old', newText: 'new' }] },
    })
  })

  it('normalizes Claude image/resource, delegated Task, WebSearch, and plan fixtures', () => {
    const message = normalizeClaudeCodeEvent(claudeAcpWire.message, context)
    expect(message.events[0].event).toMatchObject({
      type: 'message.delta',
      parts: [
        { kind: 'image', source: 'AAAA', mimeType: 'image/png' },
        { kind: 'resource', uri: 'file:///README.md', title: 'README.md', mimeType: 'text/markdown' },
      ],
    })

    const agent = normalizeClaudeCodeEvent(claudeAcpWire.agent, context)
    expect(agent.events[0]).toMatchObject({
      source: { parentAgentId: 'cc-parent-1' },
      event: { type: 'tool.started', tool: { name: 'Task', parentToolUseId: 'cc-parent-1', input: { prompt: 'Run the test suite' } } },
    })

    const web = normalizeClaudeCodeEvent(claudeAcpWire.web, context)
    expect(web.events[0].event).toMatchObject({ type: 'tool.started', tool: { name: 'WebSearch', kind: 'fetch', input: { query: 'ACP protocol' } } })

    const plan = normalizeClaudeCodeEvent(claudeAcpWire.plan, context)
    expect(plan.events[0].event).toMatchObject({
      type: 'plan.replaced',
      entries: [
        { content: 'Inspect ACP', status: 'completed' },
        { content: 'Add fixtures', status: 'in_progress' },
      ],
    })
  })
})
