/**
 * Browser snapshot projection: legacy Message[] -> unverified Workbench events.
 * Storage access belongs to the session host. This adapter never upgrades demo
 * or migrated content to authoritative native history.
 */
import type { Message } from '../../components/chat/messageTypes.ts'
import { createWorkbenchEnvelope, type WorkbenchEventEnvelope } from '../../domains/workbench/events/workbenchEventSchema.ts'

/** Browser/demo compatibility bridge. The visual seed predates the Workbench
 * journal and stores Message[] snapshots; terminal-like renders only the
 * Workbench projection, so hydrate those snapshots into provider-neutral events.
 */
export function messageSnapshotToWorkbenchEnvelopes(sessionId: string, messages: readonly Message[]): readonly WorkbenchEventEnvelope[] {
  const recordedBase = Date.now() - Math.max(0, messages.length - 1) * 1000
  const envelopes: WorkbenchEventEnvelope[] = []
  let sequence = 0
  messages.forEach((message, index) => {
    const messageId = message.id || `snapshot-message-${index + 1}`
    const recordedAt = new Date(recordedBase + index * 1000).toISOString()
    const identity = { messageId }
    const source = { provider: 'browser-demo', sourceId: messageId }
    const provenance = { origin: 'migration' as const, trust: 'unverified' as const, provider: 'browser-demo', orderConfidence: 'observed' as const, synthetic: { reason: 'message-snapshot-bridge' } }
    const text = message.content || ''
    const parts: Array<{ kind: 'text' | 'markdown'; text: string }> = text
      ? [{ kind: message.role === 'assistant' ? 'markdown' : 'text', text }]
      : []
    const push = (event: WorkbenchEventEnvelope['event'], suffix: string) => {
      sequence += 1
      envelopes.push(createWorkbenchEnvelope({
        eventId: `snapshot:${sessionId}:${messageId}:${suffix}`,
        sessionId, sequence, recordedAt, occurredAt: recordedAt,
        source, identity, provenance, event,
      }))
    }
    if (message.role === 'tool') {
      const toolCallId = messageId
      const tool: Record<string, string | Array<{ kind: 'text' | 'markdown'; text: string }>> = {
        toolCallId, name: message.toolName || 'Tool',
      }
      if (message.toolKind) tool.kind = message.toolKind
      if (message.toolInput) tool.input = message.toolInput
      if (message.toolStatus) tool.status = message.toolStatus
      if (message.toolOutput) tool.progress = message.toolOutput
      push({ type: 'tool.started', tool }, 'tool-start')
      if (message.running || (message.toolStatus && !['completed', 'failed', 'cancelled'].includes(message.toolStatus))) {
        push({ type: 'tool.progress', tool }, 'tool-progress')
      } else {
        const terminalType = message.toolStatus === 'failed' ? 'tool.failed' : 'tool.completed'
        const terminalTool = { ...tool, ...(parts.length > 0 ? { parts } : {}), ...(message.toolOutput ? { rawOutput: message.toolOutput } : {}) }
        push({ type: terminalType, tool: terminalTool, result: message.toolOutput }, 'tool-end')
      }
      return
    }
    if (message.role === 'reasoning') {
      push({ type: 'reasoning.delta', parts }, 'reasoning-delta')
      push({ type: 'reasoning.completed', parts: [], durationMs: message.thoughtDurationMs }, 'reasoning-end')
      return
    }
    if (message.role === 'assistant') {
      push({ type: 'message.started', role: 'assistant', parts: [] }, 'message-start')
      push({ type: 'message.delta', role: 'assistant', parts }, 'message-delta')
      push({ type: 'message.completed', role: 'assistant', parts: [] }, 'message-end')
      return
    }
    push({ type: 'message.completed', role: 'user', parts }, 'message-end')
  })
  return envelopes
}

