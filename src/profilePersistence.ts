export interface PersistedProfile {
  id: string
}

export interface ProfilePersistenceState<T extends PersistedProfile> {
  profiles: T[]
  activeProfileId: string
}

export const PROFILE_SCHEMA_VERSION = 4

export function normalizeProfileState<T extends PersistedProfile>(
  profiles: T[],
  activeProfileId: string,
  defaults: T[],
): ProfilePersistenceState<T> {
  const validProfiles = profiles.length > 0 ? profiles : defaults
  const hasActive = validProfiles.some(profile => profile.id === activeProfileId)
  return {
    profiles: validProfiles,
    activeProfileId: hasActive ? activeProfileId : (validProfiles[0]?.id || ''),
  }
}
