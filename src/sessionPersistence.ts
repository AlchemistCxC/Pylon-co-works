export interface PersistedProfile {
  id: string
}

export interface PersistedSession {
  id: string
  periId?: string
  name: string
  source: string
  profileId: string
  createdAt: number
  lastActiveAt: number
  platform: string
  workdir: string
  sessionPrompt: string
  skills: string[]
  hooks: string[]
  autoName: string
}

export const SESSION_SCHEMA_VERSION = 1
export const SESSION_STORAGE_KEY = 'pylon-sessions'
export const LEGACY_SESSION_STORAGE_KEY = 'prism-sessions'

interface SessionEnvelope {
  version: typeof SESSION_SCHEMA_VERSION
  sessions: PersistedSession[]
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback
const stringList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const timestamp = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback

function normalizeSession(value: unknown, profiles: PersistedProfile[]): PersistedSession | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id).trim()
  if (!id) return null

  const name = text(raw.name, `session-${id}`).trim() || `session-${id}`
  const validProfileId = text(raw.profileId)
  const profileId = profiles.some(profile => profile.id === validProfileId)
    ? validProfileId
    : (profiles[0]?.id || '')
  const createdAt = timestamp(raw.createdAt)

  return {
    id,
    periId: text(raw.periId) || undefined,
    name,
    source: text(raw.source).trim() || `local:${id}`,
    profileId,
    createdAt,
    lastActiveAt: timestamp(raw.lastActiveAt, createdAt),
    platform: text(raw.platform, 'local'),
    workdir: text(raw.workdir),
    sessionPrompt: text(raw.sessionPrompt),
    skills: stringList(raw.skills),
    hooks: stringList(raw.hooks),
    autoName: text(raw.autoName),
  }
}

function sessionInput(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  const envelope = value as Record<string, unknown>
  if (envelope.version !== SESSION_SCHEMA_VERSION || !Array.isArray(envelope.sessions)) return null
  return envelope.sessions
}

export function normalizeSessions(value: unknown, profiles: PersistedProfile[]): PersistedSession[] {
  const rawSessions = sessionInput(value)
  if (!rawSessions) return []

  const seen = new Set<string>()
  const sessions: PersistedSession[] = []
  rawSessions.forEach(raw => {
    const session = normalizeSession(raw, profiles)
    if (!session || seen.has(session.id)) return
    seen.add(session.id)
    sessions.push(session)
  })
  return sessions
}

function parseStoredSessions(raw: string | null, profiles: PersistedProfile[]): PersistedSession[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return sessionInput(parsed) ? normalizeSessions(parsed, profiles) : null
  } catch {
    return null
  }
}

export function serializeSessions(sessions: PersistedSession[]): string {
  const envelope: SessionEnvelope = { version: SESSION_SCHEMA_VERSION, sessions }
  return JSON.stringify(envelope)
}

export function parseSessions(raw: string | null, profiles: PersistedProfile[]): PersistedSession[] {
  return parseStoredSessions(raw, profiles) ?? []
}

export function persistSessions(storage: StorageLike, sessions: PersistedSession[]): void {
  try {
    storage.setItem(SESSION_STORAGE_KEY, serializeSessions(sessions))
  } catch {
    // 存储不可用/写满：静默降级——写盘失败不应让 identityStore action 抛异常
  }
}

export function loadSessions(storage: StorageLike, profiles: PersistedProfile[]): PersistedSession[] {
  const currentRaw = storage.getItem(SESSION_STORAGE_KEY)
  const current = parseStoredSessions(currentRaw, profiles)
  if (current) {
    persistSessions(storage, current)
    return current
  }

  const legacyRaw = storage.getItem(LEGACY_SESSION_STORAGE_KEY)
  const legacy = parseStoredSessions(legacyRaw, profiles)
  if (!legacy) return []

  persistSessions(storage, legacy)
  storage.removeItem(LEGACY_SESSION_STORAGE_KEY)
  return legacy
}
