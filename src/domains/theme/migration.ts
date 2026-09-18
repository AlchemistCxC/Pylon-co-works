/**
 * migration — 主题持久化 schema 迁移（A4：从 store.ts/themeMigration.ts 抽入域）。
 *
 * store.ts 只留 `migrate: persisted => themeDomainMigrate(persisted, DEFAULTS)` 薄壳。
 * 依赖全显式 .ts，node 可直接 import 做确定性迁移测试。
 */
import { normalizeCustomPresetId, normalizeCustomPresets } from '../../customPresets.ts'
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
 *
 * v8（2026-09-14）：中控新增 reasoning 控件。normalizeCcLayout 本会把旧布局补齐
 * 新增控件默认位置，但该逻辑只挂在 migrate 钩子上；而 migrate 仅在持久化版本
 * 变化时触发。旧安装存的是 v7，与当时常量同号 → 钩子不跑 → 老浏览器里
 * ccLayout.placements 缺 reasoning 项 → ControlCenter 的槽位过滤把它剔掉，
 * 控件永远不出现（刷新无效，因为布局存在 localStorage）。
 * bump 到 8 迫使存量安装再跑一次迁移，补入 reasoning（合并按 widget ID 进行，
 * 可重复执行且保留用户既有拖拽位置）。
 *
 * v9（权限选择控件）：新增 permission* 字段组（权限控件外观与交互）。控件 id `mode`
 * 早已存在、布局无需变更，但存量安装的 localStorage 里没有这 7 个键，而字段归一化
 * 只挂在 migrate 钩子上跑；不 bump 则它们永远是 undefined（控件尺寸会算成 NaN）。
 *
 * v10（用量控件 S11）：`pct` 并入 `tokens` 成为单一「用量」控件，默认位置从状态区
 * 首行移到次行、紧跟权限控件。同样受「归一化只挂 migrate」限制 —— 不 bump 则存量
 * 布局里 tokens 仍停在旧位置（status-primary/3），新默认位不生效。
 * 本版同时把 CC_LAYOUT_SCHEMA_VERSION 7→8：归一化遇到 v7 布局不在接受列表
 * [3,4,5,6,8] 内 → 整份布局回落默认值（用户已确认接受排版重置的代价）。
 */
export const THEME_SCHEMA_VERSION = 10

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

export function normalizeZoneRecord<T>(value: unknown, defaults: Record<string, T>, valid: (item: unknown) => item is T): Record<string, T> {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return Object.fromEntries(PRESET_ZONES.map(zone => [zone, valid(candidate[zone]) ? candidate[zone] : defaults[zone]])) as Record<string, T>
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
  // Older themes had one toolIndicator glyph. Preserve that choice when the
  // three state-specific fields are introduced instead of silently replacing
  // it with the new defaults.
  if (typeof state.toolIndicator === 'string') {
    for (const key of ['toolIndicatorRun', 'toolIndicatorOk', 'toolIndicatorErr']) {
      if (state[key] === undefined) normalized[key] = state.toolIndicator
    }
  }
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

  const normalizedCustomPresets = normalizeCustomPresets(state.customPresets)
  // A1 renamed bare custom ids into the `custom-*` namespace.  Migrate any
  // persisted zone references in the same pass; otherwise the list row would
  // expose `custom-foo` while appliedPreset still points at `foo`, making the
  // preset appear inactive after a restart.
  if (Array.isArray(state.customPresets)) {
    const aliases = new Map<string, string>()
    for (const item of state.customPresets) {
      if (!item || typeof item !== 'object') continue
      const rawId = (item as { id?: unknown }).id
      if (typeof rawId === 'string' && rawId.trim()) {
        const trimmedId = rawId.trim()
        const canonicalId = normalizeCustomPresetId(trimmedId)
        // Persisted records occasionally contain whitespace around the id;
        // zone references may contain either the raw or trimmed spelling.
        aliases.set(rawId, canonicalId)
        aliases.set(trimmedId, canonicalId)
      }
    }
    for (const zone of PRESET_ZONES) {
      const current = appliedRecord[zone]
      const canonical = aliases.get(current) ?? aliases.get(current.trim())
      if (canonical) appliedRecord[zone] = canonical
    }
  }
  normalized.customPresets = normalizedCustomPresets
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
  // v8（2026-09-14）：新增 reasoning 控件后再次 bump，理由同 v7——normalizeCcLayout
  // 的补位逻辑只在 migrate 内执行，存量 v7 安装不 bump 就永远不会补入新控件。
  // v9（2026-09-15）：新增 permission* 字段组（权限选择控件）。控件 id `mode` 早已存在、
  // 布局无需补位，但字段归一化同样只在 migrate 内执行——不 bump，存量安装里这 7 个键
  // 永远是 undefined，权限控件会按 NaN 尺寸渲染。
  // defs 驱动的通用值归一化（select 枚举/number 范围/boolean/color/text 类型 → def.default）
  Object.assign(state, normalizeThemeState(state))
  // 历史字段特殊规则（与 defs 类型不完全一致，保留既有语义）
  state.inputShowPlaceholder = state.inputShowPlaceholder !== false
  state.inputShowHistoryHint = state.inputShowHistoryHint !== false
  // These select fields historically accepted booleans. Persist the enum
  // values now so the settings control always has a valid selected option.
  state.inputFocusRingEnabled = state.inputFocusRingEnabled === false || state.inputFocusRingEnabled === 'hidden' ? 'hidden' : 'shown'
  state.inputShadowEnabled = state.inputShadowEnabled === false || state.inputShadowEnabled === 'hidden' ? 'hidden' : 'shown'
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
  state.customPresets = normalizeCustomPresets(state.customPresets)
  return state
}
