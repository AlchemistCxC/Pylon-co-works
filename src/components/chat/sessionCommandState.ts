export interface SessionCommandRecord {
  id: string
  source: string
  agentId: string
}

export function resolveSessionSource(sessionId: string | null, sessions: readonly SessionCommandRecord[]): string | null {
  if (!sessionId) return null
  return sessions.find(session => session.id === sessionId || session.source === sessionId)?.source ?? null
}

/** I01-W2：按 id/source 解析出完整 Session（含 agentId，供 AgentContext 构造）。 */
export function resolveSession(sessionId: string | null, sessions: readonly SessionCommandRecord[]): SessionCommandRecord | null {
  if (!sessionId) return null
  return sessions.find(session => session.id === sessionId || session.source === sessionId) ?? null
}
