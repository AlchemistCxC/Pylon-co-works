export interface SessionCommandRecord {
  id: string
  source: string
}

export function resolveSessionSource(sessionId: string | null, sessions: readonly SessionCommandRecord[]): string | null {
  if (!sessionId) return null
  return sessions.find(session => session.id === sessionId || session.source === sessionId)?.source ?? null
}
