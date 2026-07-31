import type { Message } from './messageTypes'

export interface MessageLookups {
  toolById: Map<string, Message>
  resolvedToolIds: Set<string>
  failedToolIds: Set<string>
  runningToolIds: Set<string>
}

function toolIdFromMessage(message: Message): string | null {
  if (message.role !== 'tool' || !message.id.startsWith('tool-')) return null
  const id = message.id.slice('tool-'.length)
  return id || null
}

export function buildMessageLookups(messages: readonly Message[]): MessageLookups {
  const toolById = new Map<string, Message>()
  const resolvedToolIds = new Set<string>()
  const failedToolIds = new Set<string>()
  const runningToolIds = new Set<string>()

  for (const message of messages) {
    const toolId = toolIdFromMessage(message)
    if (!toolId) continue
    toolById.set(toolId, message)
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

  return { toolById, resolvedToolIds, failedToolIds, runningToolIds }
}
