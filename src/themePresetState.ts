export interface PresetRouteState {
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
}

export function markZoneCustom<T extends PresetRouteState>(state: T, zone: string): Pick<PresetRouteState, 'activePreset' | 'dirty'> {
  return {
    activePreset: { ...state.activePreset, [zone]: 'custom' },
    dirty: { ...state.dirty, [zone]: true },
  }
}
