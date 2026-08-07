/**
 * profilePersistence — Profile 独立持久化（FE-AUD-002 / 阶段 1B）。
 *
 * versioned envelope `pylon-profiles`：profiles + activeProfileId。
 * normalize 拒绝空 id、重复 id 与损坏对象；损坏/缺失回退 defaults。
 * 旧 pylon-theme 内嵌 profile 由调用方一次性迁移落本 key（见 identityStore.hydrateProfiles）。
 */

export interface PersistedProfile {
  id: string
  name: string
  persona: string
  model: string
  avatar?: string
}

export interface ProfilePersistenceState<T extends PersistedProfile = PersistedProfile> {
  profiles: T[]
  activeProfileId: string
}

/** 历史 schema 版本引用（保留；主题域注释引用） */
export const PROFILE_SCHEMA_VERSION = 4
/** pylon-profiles envelope 版本 */
export const PROFILE_ENVELOPE_VERSION = 1
export const PROFILE_STORAGE_KEY = 'pylon-profiles'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

/** 单 profile 规范化：拒绝空 id 与损坏对象 */
export function normalizePersistedProfile(raw: unknown): PersistedProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const id = text(value.id)
  if (!id) return null
  const name = text(value.name) || `profile-${id}`
  const persona = typeof value.persona === 'string' ? value.persona : ''
  const model = typeof value.model === 'string' ? value.model : ''
  const avatar = text(value.avatar)
  return {
    id,
    name,
    persona,
    model,
    ...(avatar ? { avatar } : {}),
  }
}

/** 列表规范化：过滤无效项，重复 id 保留首个；空列表回退 defaults */
export function normalizeProfileState(
  profiles: unknown,
  activeProfileId: unknown,
  defaults: PersistedProfile[],
): ProfilePersistenceState {
  const seen = new Set<string>()
  const valid: PersistedProfile[] = []
  if (Array.isArray(profiles)) {
    for (const raw of profiles) {
      const profile = normalizePersistedProfile(raw)
      if (!profile || seen.has(profile.id)) continue
      seen.add(profile.id)
      valid.push(profile)
    }
  }
  const list = valid.length > 0 ? valid : defaults
  const activeId = typeof activeProfileId === 'string' ? activeProfileId : ''
  return {
    profiles: list,
    activeProfileId: list.some(profile => profile.id === activeId) ? activeId : (list[0]?.id || ''),
  }
}

/** 解析 envelope；缺失/损坏/未知版本回退 defaults */
export function parseProfileEnvelope(raw: string | null, defaults: PersistedProfile[]): ProfilePersistenceState {
  if (!raw) return { profiles: defaults, activeProfileId: defaults[0]?.id || '' }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { profiles: defaults, activeProfileId: defaults[0]?.id || '' }
    const envelope = parsed as { profiles?: unknown; activeProfileId?: unknown }
    return normalizeProfileState(envelope.profiles, envelope.activeProfileId, defaults)
  } catch {
    return { profiles: defaults, activeProfileId: defaults[0]?.id || '' }
  }
}

export function serializeProfileEnvelope(state: ProfilePersistenceState): string {
  return JSON.stringify({
    version: PROFILE_ENVELOPE_VERSION,
    profiles: state.profiles,
    activeProfileId: state.activeProfileId,
  })
}

export function persistProfiles(storage: StorageLike, state: ProfilePersistenceState): boolean {
  try {
    storage.setItem(PROFILE_STORAGE_KEY, serializeProfileEnvelope(normalizeProfileState(state.profiles, state.activeProfileId, [])))
    return true
  } catch {
    return false
  }
}

export function loadProfiles(storage: StorageLike, defaults: PersistedProfile[]): ProfilePersistenceState {
  let raw: string | null = null
  try {
    raw = storage.getItem(PROFILE_STORAGE_KEY)
  } catch {
    return { profiles: defaults, activeProfileId: defaults[0]?.id || '' }
  }
  return parseProfileEnvelope(raw, defaults)
}
