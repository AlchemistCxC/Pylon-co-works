import { normalizeCustomPresets } from './customPresets.ts'
import { normalizeCcLayout, type CcLayoutV3 } from './ccLayoutState.ts'
import { PRESET_ZONES } from './domains/theme/presetReducer.ts'

export type ThemeMigrationDefaults = {
  base: object
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
  ccLayout: CcLayoutV3
}

type ThemeMigrationState = Record<string, unknown> & {
  appliedPreset?: unknown
  custom?: unknown
  /** 旧版键（A1 前模型）：读入后映射为新键 */
  activePreset?: unknown
  dirty?: unknown
  ccLayout?: unknown
  customPresets?: unknown
}

function normalizeZoneRecord<T>(value: unknown, defaults: Record<string, T>, valid: (item: unknown) => item is T): Record<string, T> {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(PRESET_ZONES.map(zone => [zone, valid(candidate[zone]) ? candidate[zone] : defaults[zone]]))
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

  // A1 迁移：旧 activePreset/dirty 键 → appliedPreset/custom；旧 'custom' 值（基准丢失）
  // → appliedPreset='' + custom=true（旧模型 dirty 未持久化，'custom' 值是触碰的唯一信号）。
  const legacyApplied = (state.appliedPreset ?? state.activePreset) as Record<string, unknown> | undefined
  const legacyCustom = (state.custom ?? state.dirty) as Record<string, boolean> | undefined
  const appliedRecord = normalizeZoneRecord(
    legacyApplied,
    defaults.appliedPreset,
    (value): value is string => typeof value === 'string',
  )
  const customRecord = normalizeZoneRecord(
    legacyCustom,
    defaults.custom,
    (value): value is boolean => typeof value === 'boolean',
  )
  for (const zone of PRESET_ZONES) {
    if (legacyApplied?.[zone] === 'custom') {
      appliedRecord[zone] = ''
      customRecord[zone] = true
    }
  }
  normalized.appliedPreset = appliedRecord
  normalized.custom = customRecord

  normalized.customPresets = normalizeCustomPresets(state.customPresets)
  return normalized
}
