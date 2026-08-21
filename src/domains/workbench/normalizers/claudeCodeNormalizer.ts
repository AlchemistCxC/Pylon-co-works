import type { AgentEventNormalizer, AgentWireEnvelope, NormalizeContext, NormalizeResult } from './agentEventNormalizer.ts'
import { normalizeAcpEvent } from './acpNormalizer.ts'
import { extractUpdate, isRecord } from './normalizerSupport.ts'

export const claudeCodeNormalizer: AgentEventNormalizer = {
  id: 'claude-code',
  canNormalize: (_input, context) => ['claude', 'claude-code'].includes(context.provider.toLowerCase()),
  normalize: normalizeClaudeCodeEvent,
}

export function normalizeClaudeCodeEvent(input: AgentWireEnvelope | unknown, context: NormalizeContext): NormalizeResult {
  const update = extractUpdate(input)
  const parentToolUseId = readParentToolUseId(update)
  const result = normalizeAcpEvent(input, context)
  if (!parentToolUseId) return result
  return {
    events: result.events.map(event => ({
      ...event,
      source: { ...event.source, parentAgentId: parentToolUseId },
      event: event.event.type.startsWith('tool.') && 'tool' in event.event && isRecord(event.event.tool)
        ? { ...event.event, tool: { ...event.event.tool, parentToolUseId } }
        : event.event,
    })),
    diagnostics: result.diagnostics,
  }
}

function readParentToolUseId(update: Record<string, unknown> | undefined): string | undefined {
  const meta = update?._meta
  if (!meta || typeof meta !== 'object') return undefined
  const claude = (meta as Record<string, unknown>).claudeCode
  if (!claude || typeof claude !== 'object') return undefined
  const value = (claude as Record<string, unknown>).parentToolUseId
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
