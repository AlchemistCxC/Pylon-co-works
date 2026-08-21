import { describe, expect, it } from 'vitest'
import { normalizeClaudeCodeEvent } from '../claudeCodeNormalizer.ts'
import type { NormalizeContext } from '../agentEventNormalizer.ts'

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
})
