/** Read-only compatibility facade for the old Message[] consumers. */
import type { Message } from '../../components/chat/messageTypes.ts'
import type { WorkbenchDocument } from './workbenchProjector.ts'

export function selectLegacyMessages(document: WorkbenchDocument): readonly Message[] {
  return document.messages.map(message => ({
    id: message.id,
    role: message.role,
    sender: message.source.sourceId,
    content: message.content,
    time: message.time,
    agentId: message.source.agentId,
    running: message.running,
    externalIdentity: Object.keys(message.identity).length === 0 ? undefined : {
      ...(message.identity.messageId ? { messageId: message.identity.messageId } : {}),
      ...(message.identity.turnId ? { turnId: message.identity.turnId } : {}),
      ...(message.identity.toolCallId ? { toolCallId: message.identity.toolCallId } : {}),
    },
  }))
}
