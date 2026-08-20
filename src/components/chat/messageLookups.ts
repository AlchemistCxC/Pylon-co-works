import type { Message } from './messageTypes'
import { toolIdFromMessage } from '../../domains/tool/id.ts'

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
    if (message.running || visualStatus === 'pending' || visualStatus === 'in_progress') {
      runningToolIds.add(toolId)
    }
    if (visualStatus === 'failed' || visualStatus === 'error') {
      failedToolIds.add(toolId)
    }
    if (!message.running && (visualStatus === 'completed' || message.toolOutput !== undefined)) {
      resolvedToolIds.add(toolId)
    }
  }

  return { resolvedToolIds, failedToolIds, runningToolIds }
}
