export interface SessionSettingsValues {
  name: string
  platform: string
  workdir: string
  sessionPrompt: string
}

export function createSessionSettingsValues(session?: Partial<SessionSettingsValues>): SessionSettingsValues {
  return {
    name: session?.name || '',
    platform: session?.platform || 'local',
    workdir: session?.workdir || '',
    sessionPrompt: session?.sessionPrompt || '',
  }
}

export function isSessionSettingsDirty(
  current: SessionSettingsValues,
  initial: SessionSettingsValues,
): boolean {
  return current.name !== initial.name
    || current.platform !== initial.platform
    || current.workdir !== initial.workdir
    || current.sessionPrompt !== initial.sessionPrompt
}
