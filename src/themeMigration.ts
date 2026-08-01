import { normalizeCustomPresets } from './customPresets.ts'
import { normalizeCcLayout, type CcLayoutV3 } from './ccLayoutState.ts'
import { ZONES } from './themeFields.ts'

export type ThemeMigrationDefaults = {
  base: object
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
  ccLayout: CcLayoutV3
}

type ThemeMigrationState = Record<string, unknown> & {
  activePreset?: unknown
  dirty?: unknown
  ccLayout?: unknown
  customPresets?: unknown
}

function normalizeZoneRecord<T>(value: unknown, defaults: Record<string, T>, valid: (item: unknown) => item is T): Record<string, T> {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(ZONES.map(zone => [zone, valid(candidate[zone]) ? candidate[zone] : defaults[zone]]))
}

export function normalizeThemeMigrationState(
  persisted: unknown,
  defaults: ThemeMigrationDefaults,
): Record<string, unknown> {
  const state: ThemeMigrationState = persisted && typeof persisted === 'object'
    ? { ...(persisted as ThemeMigrationState) }
    : {}

  delete state.ccSizes
  delete state.ccPositions
  delete state.ccCliCustomized
  delete state.ccLayoutVersion
  const normalized: Record<string, unknown> = { ...defaults.base, ...state }
  normalized.ccLayout = normalizeCcLayout(
    state.ccLayout as Partial<CcLayoutV3> | undefined,
  )
  normalized.ccEditMode = false
  normalized.activePreset = normalizeZoneRecord(
    state.activePreset,
    defaults.activePreset,
    (value): value is string => typeof value === 'string',
  )
  normalized.dirty = normalizeZoneRecord(
    state.dirty,
    defaults.dirty,
    (value): value is boolean => typeof value === 'boolean',
  )
  normalized.customPresets = normalizeCustomPresets(state.customPresets)
  return normalized
}
