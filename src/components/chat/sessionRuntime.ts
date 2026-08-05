import type { Session, SessionConfig } from '../../store'
import type { AvailableCommand } from '../../infrastructure/acp/chatContracts'

export interface SessionLiveStats {
  tokensUsed: number
  tokensMax: number
  cacheReadTokens: number
  commands: AvailableCommand[]
}

export function emptySessionLiveStats(): SessionLiveStats {
  return {
    tokensUsed: 0,
    tokensMax: 131072,
    cacheReadTokens: 0,
    commands: [],
  }
}

export function updateSessionLiveStats(
  state: Record<string, SessionLiveStats>,
  source: string,
  partial: Partial<SessionLiveStats>,
): Record<string, SessionLiveStats> {
  return {
    ...state,
    [source]: {
      ...emptySessionLiveStats(),
      ...state[source],
      ...partial,
    },
  }
}

interface ClearSessionSourceStateOptions {
  source: string
  sessionLiveStats: Record<string, SessionLiveStats>
  sessionModes: Record<string, string>
  sessionConfig: Record<string, SessionConfig>
  generatingSources: string[]
}

function omitSource<T>(state: Record<string, T>, source: string): Record<string, T> {
  const next = { ...state }
  delete next[source]
  return next
}

export function clearSessionSourceState({
  source,
  sessionLiveStats,
  sessionModes,
  sessionConfig,
  generatingSources,
}: ClearSessionSourceStateOptions) {
  return {
    sessionLiveStats: omitSource(sessionLiveStats, source),
    sessionModes: omitSource(sessionModes, source),
    sessionConfig: omitSource(sessionConfig, source),
    generatingSources: generatingSources.filter(item => item !== source),
  }
}

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