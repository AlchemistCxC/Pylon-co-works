/**
 * migration — 主题持久化 schema 迁移（A4：从 store.ts/themeMigration.ts 抽入域）。
 *
 * store.ts 只留 `migrate: persisted => themeDomainMigrate(persisted, DEFAULTS)` 薄壳。
 * 依赖全显式 .ts，node 可直接 import 做确定性迁移测试。
 */
import { normalizeCustomPresets } from '../../customPresets.ts'
import { normalizeCcLayout, type CcLayoutV3 } from '../../ccLayoutState.ts'
import {
  clampCcHeight,
  resolveVisibleStatusWidgetCount,
  type CcFooterLayout,
  type CcHintMode,
  type CcInputMode,
  type CcOverflowMode,
} from '../../ccHeightState.ts'
import { normalizeThemeState } from '../../themeFieldDefs.ts'
import { PRESET_ZONES, resolveInputMode } from './presetReducer.ts'

/**
 * 主题域 schema 版本（A4：独立于 PROFILE_SCHEMA_VERSION=4）。
 * 沿用共享编号的续号 5：保证存量数据（version 4）升级时触发 migrate。
 */
export const THEME_SCHEMA_VERSION = 7

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

/**
 * 完整迁移：键映射/legacy 删除 + defs 驱动归一化 + 历史字段特判 + ccHeight clamp。
 * store 侧 migrate 薄壳调用；defaults 传 store 的 DEFAULTS（避免域→store 循环）。
 */
export function themeDomainMigrate(persisted: unknown, defaults: ThemeMigrationDefaults, fromVersion = 0): Record<string, unknown> {
  const state = normalizeThemeMigrationState(persisted, defaults)
  // v6：普通界面退出“全局终端体”。升级一次后用户仍可在新字体设置中主动选回等宽体。
  if (fromVersion < 6 && state.globalFont === 'mono') state.globalFont = 'system'
  // v7：normalizeThemeMigrationState 已把旧中控布局升级到开放的 v7 widget 集合；
  // bump 持久化版本确保同为主题 schema v6 的存量安装也执行该迁移。
  // defs 驱动的通用值归一化（select 枚举/number 范围/boolean/color/text 类型 → def.default）
  Object.assign(state, normalizeThemeState(state))
  // 历史字段特殊规则（与 defs 类型不完全一致，保留既有语义）
  state.inputShowPlaceholder = state.inputShowPlaceholder !== false
  state.inputShowHistoryHint = state.inputShowHistoryHint !== false
  state.inputVariant = state.inputVariant === 'cli' || state.inputVariant === 'composer' || state.inputVariant === 'compact' || state.inputVariant === 'command'
    ? state.inputVariant
    : state.inputMode === 'cli' ? 'cli' : 'composer'
  state.inputMode = resolveInputMode(String(state.inputVariant))
  const migratedInputMode = typeof state.inputMode === 'string' ? state.inputMode : String((defaults.base as Record<string, unknown>).inputMode ?? 'cli')
  const migratedHintMode = state.cliHintMode === 'hidden' || state.cliHintMode === 'compact' ? state.cliHintMode : 'full'
  const migratedFooterLayout = state.footerLayout === 'peri' ? 'peri' : 'free'
  const migratedOverflowMode = state.cliOverflowMode === 'grow' || state.cliOverflowMode === 'overlay' ? state.cliOverflowMode : 'fixed-scroll'
  state.ccHeight = clampCcHeight(typeof state.ccHeight === 'number' ? state.ccHeight : Number((defaults.base as Record<string, unknown>).ccHeight ?? 150), {
    inputMode: migratedInputMode as CcInputMode,
    footerLayout: migratedFooterLayout as CcFooterLayout,
    hintMode: migratedHintMode as CcHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: Array.isArray(state.ccHidden) ? state.ccHidden : [],
      inputMode: migratedInputMode as CcInputMode,
      ccStyle: (state.ccStyle as string) || 'wave',
      submitButtonMode: String(state.inputSubmitButtonMode ?? 'inline'),
    }),
    cliOverflowMode: migratedOverflowMode as CcOverflowMode,
  })
  // D2：ccBgHeight ≥ ccHeight 不变量跨重启成立（与 setZoneField 漏斗/setCcHeight 一致）
  state.ccBgHeight = Math.max(Number(state.ccBgHeight ?? 150), Number(state.ccHeight))
  state.customPresets = normalizeCustomPresets(state.customPresets)
  return state
}
