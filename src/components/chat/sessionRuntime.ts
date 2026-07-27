import type { Session } from '../../store'

interface BuildSendMessagePayloadOptions {
  session: Session
  content: string
  persona: string
  attachments: string[]
}

export function buildSendMessagePayload({ session, content, persona, attachments }: BuildSendMessagePayloadOptions) {
  return {
    source: session.source,
    content,
    persona,
    sessionPrompt: session.sessionPrompt || '',
    attachments,
  }
}