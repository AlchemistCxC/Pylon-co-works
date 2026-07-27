import type { Profile, Session } from './store'

export const SESSION_SCHEMA_VERSION = 1
export const SESSION_STORAGE_KEY = 'pylon-sessions'
export const LEGACY_SESSION_STORAGE_KEY = 'prism-sessions'

interface SessionEnvelope {
  version: number
  sessions: Session[]
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const timestamp = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback

function normalizeSession(value: unknown, profiles: Profile[], index: number): Session | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id).trim()
  if (!id) return null

  const now = Date.now() + index
  const name = text(raw.name, `session-${id}`).trim() || `session-${id}`
  const validProfileId = text(raw.profileId)
  const profileId = profiles.some(profile => profile.id === validProfileId)
    ? validProfileId
    : (profiles[0]?.id || '')

  return {
    id,
    periId: text(raw.periId) || undefined,
    name,
    source: text(raw.source).trim() || `local:${name}`,
    profileId,
    createdAt: timestamp(raw.createdAt, now),
    lastActiveAt: timestamp(raw.lastActiveAt, timestamp(raw.createdAt, now)),
    platform: text(raw.platform, 'local'),
    workdir: text(raw.workdir),
    sessionPrompt: text(raw.sessionPrompt),
    skills: stringList(raw.skills),
    hooks: stringList(raw.hooks),
    autoName: text(raw.autoName),
  }
}

export function normalizeSessions(value: unknown, profiles: Profile[]): Session[] {
  const rawSessions = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).sessions)
      ? (value as Record<string, unknown>).sessions as unknown[]
      : []

  const seen = new Set<string>()
  const sessions: Session[] = []
  rawSessions.forEach((raw, index) => {
    const session = normalizeSession(raw, profiles, index)
    if (!session || seen.has(session.id)) return
    seen.add(session.id)
    sessions.push(session)
  })
  return sessions
}

export function serializeSessions(sessions: Session[]): string {
  const envelope: SessionEnvelope = { version: SESSION_SCHEMA_VERSION, sessions }
  return JSON.stringify(envelope)
}

export function parseSessions(raw: string | null, profiles: Profile[]): Session[] {
  if (!raw) return []
  return normalizeSessions(JSON.parse(raw), profiles)
}

export function persistSessions(storage: StorageLike, sessions: Session[]): void {
  storage.setItem(SESSION_STORAGE_KEY, serializeSessions(sessions))
}

export function loadSessions(storage: StorageLike, profiles: Profile[]): Session[] {
  const current = storage.getItem(SESSION_STORAGE_KEY)
  const legacy = current == null ? storage.getItem(LEGACY_SESSION_STORAGE_KEY) : null
  const sessions = parseSessions(current ?? legacy, profiles)

  // 旧数组格式和旧 key 都在首次读取时迁移到带 version 的唯一存储。
  if (current != null || legacy != null) {
    persistSessions(storage, sessions)
    if (legacy != null) storage.removeItem(LEGACY_SESSION_STORAGE_KEY)
  }
  return sessions
}
