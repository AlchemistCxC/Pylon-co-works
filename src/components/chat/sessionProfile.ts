import type { Profile, Session } from '../../store'

export function resolveSessionProfile(sessionId: string | null, sessions: Session[], profiles: Profile[]) {
  if (!sessionId) return undefined
  const session = sessions.find(item => item.id === sessionId || item.source === sessionId)
  return session ? profiles.find(profile => profile.id === session.profileId) : undefined
}

export function belongsToProfile(sessionId: string | null, profileId: string, sessions: Session[]) {
  if (!sessionId) return true
  const session = sessions.find(item => item.id === sessionId || item.source === sessionId)
  return session?.profileId === profileId
}