import { normalizeCustomPresets } from './customPresets.ts'
import { normalizeCcLayout, normalizeCcPositions, type CcPositions, type CcLayoutV3 } from './ccLayoutState.ts'

export type ThemeMigrationDefaults = {
  base: Record<string, unknown>
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
  ccPositions: CcPositions
  ccLayout: CcLayoutV3
}

const ZONES = ['global', 'sidebar', 'chat', 'cc', 'right'] as const

type ThemeMigrationState = Record<string, unknown> & {
  activePreset?: unknown
  dirty?: unknown
  ccPositions?: unknown
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
  const normalized: Record<string, unknown> = { ...defaults.base, ...state }
  normalized.ccPositions = normalizeCcPositions(
    state.ccPositions as CcPositions | undefined,
    defaults.ccPositions,
  )
  normalized.ccLayout = normalizeCcLayout(
    state.ccLayout as Partial<CcLayoutV3> | undefined,
    normalized.ccPositions as CcPositions,
  )
  normalized.ccLayoutVersion = normalized.ccLayout && typeof normalized.ccLayout === 'object'
    ? (normalized.ccLayout as CcLayoutV3).version
    : defaults.ccLayout.version
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
