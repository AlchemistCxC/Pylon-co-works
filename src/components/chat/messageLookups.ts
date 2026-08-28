import type { Message } from './messageTypes'
import { toolIdFromMessage } from '../../domains/tool/id.ts'
import { normalizeToolStatus } from '../../domains/tool/status.ts'

export interface MessageLookups {
  resolvedToolIds: Set<string>
  failedToolIds: Set<string>
  runningToolIds: Set<string>
}

export function buildMessageLookups(messages: readonly Message[]): MessageLookups {
  const resolvedToolIds = new Set<string>()
  const failedToolIds = new Set<string>()
  const runningToolIds = new Set<string>()

  for (const message of messages) {
    const toolId = toolIdFromMessage(message)
    if (!toolId) continue
    const visualStatus = message.toolStatus
    const normalizedStatus = normalizeToolStatus(visualStatus)
    if (message.running || visualStatus === 'pending' || visualStatus === 'in_progress') {
      runningToolIds.add(toolId)
    }
    if (visualStatus === 'failed' || visualStatus === 'error') {
      failedToolIds.add(toolId)
    }
    // A cancelled tool may still include provider output (for example, a
    // partial stream or a cancellation reason). Keep the source status in the
    // rendered row instead of letting the output presence promote it to
    // completed. This is a presentation-only guard; domain status and output
    // payloads remain untouched.
    if (!message.running && normalizedStatus !== 'cancelled' && (visualStatus === 'completed' || message.toolOutput !== undefined)) {
      resolvedToolIds.add(toolId)
    }
  }

  return { resolvedToolIds, failedToolIds, runningToolIds }
}
