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
import { resolveCcHiddenWidgetIds } from '../cc/widgetDefinitions.ts'
import { PRESET_ZONES, resolveInputMode } from './presetReducer.ts'

/**
 * 主题域 schema 版本（A4：独立于 PROFILE_SCHEMA_VERSION=4）。
 * 沿用共享编号的续号 5：保证存量数据（version 4）升级时触发 migrate。
 *
 * ★★ 版本号职责（#238 刀2 起收窄 —— **后来者请勿再往这里塞东西**）：
 * 它**只表示「数据格式版本」**：只在**数据结构发生不可自动推导的变化、且需要一次显式
 * 语义转换**时才 bump。
 * ★ **明确反例：加控件、加字段、改槽位、改 id —— 一律不需要 bump。**
 * 依据：「结构对齐」（补缺控件项 / 补校字段值 / 按 id 合并）已从 migrate 钩子摘出来，
 * 改由**读盘路径每次无条件跑一次**（`alignThemeStructure`，挂钩在 `store.ts` 的 persist `merge`）。
 * 在此之前它与版本号绑死 ⇒ 忘 bump 就**静默坏**，历史上已栽过三次（见下）。
 *
 * 历史：各版本 bump 背后的**一次性语义转换**内容
 * - v6：普通界面退出"全局终端体"（升级一次后用户仍可在字体设置里主动选回等宽体）。
 * - v8（2026-09-14）：中控新增 `reasoning` 控件。★ 事故：补位逻辑当时只挂在 migrate 上、
 *   而 migrate 仅在版本变化时触发 ⇒ 存量 v7 安装里 `ccLayout.placements` 缺该项，
 *   被 ControlCenter 的槽位过滤剔掉，控件永远不出现（刷新无效，因为布局存在 localStorage）。
 * - v9（2026-09-15）：新增 `permission*` 字段组。★ 事故：不 bump ⇒ 存量安装里这 7 个键
 *   永远是 undefined，权限控件按 **NaN 尺寸**渲染。
 * - v10（用量控件 S11）：`pct` 并入 `tokens` 成单一「用量」控件，默认位从状态区首行移到次行。
 * - v11（刀4 中控名单换代，2026-09-18）：中控元件名单旧 11 → 新 7 —— 删 5 个 id
 *   （session / workspace / activity / ekg / tasks）连同它们的字段（存量数据里的这些键
 *   在 `normalizeThemeMigrationState` 里显式清掉）；`ekg` 四形态仪表整体移除
 *   （实现留档见 `备份\ekg-留档\`，issue #170）；legacy `send` 的槽位/显隐/缩放三处键
 *   迁到注册轨 id `cc-send-button`（只改键名不改值）。
 *   ★ 其中**「缩放」那一处改名已随 #238 刀7 删除**（`ccScale` 字段整体退场）⇒ 现在只剩槽位（在
 *   `normalizeCcLayout` 内）与显隐（`renameLegacyCcHiddenKeys`）两处。
 *
 * ★ 上述前两次事故的**共同根因已在刀2 拔掉**：结构对齐不再依赖版本号 ⇒ 加控件/加字段
 * 不再需要 bump（"必须记得 bump"这套耦合消失）。
 */
export const THEME_SCHEMA_VERSION = 11

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

/** v11（刀4）：被删元件的 cc 主题字段 —— 旧数据显式清键，避免随 state 流入 store。 */
const REMOVED_CC_THEME_KEYS = [
  'ccStyle', 'ekgWidth', 'ekgGreen', 'ekgYellow', 'ekgRed',
  'barTrackColor', 'barFillColor', 'barFillFollow', 'barHeight',
] as const

/** v11（刀4）：legacy `send` → 注册轨 id（槽位事实的继任者）。 */
const LEGACY_CC_KEY_RENAMES: Readonly<Record<string, string>> = Object.freeze({ send: 'cc-send-button' })

function renameLegacyCcHiddenKeys(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(id => LEGACY_CC_KEY_RENAMES[String(id)] ?? id)
    : value
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
  // v11（刀4）：名单换代的删键与改名（幂等；ccLayout.placements 的别名在 normalizeCcLayout 内）
  for (const key of REMOVED_CC_THEME_KEYS) delete state[key]
  // ★ 只在**真有这个键**时才赋值：直接 `state.ccHidden = rename(undefined)` 会新建一个
  // 值为 undefined 的键，而下面的 `{...defaults.base, ...state}` 会让它**覆盖掉默认值** ——
  // 读盘路径上表现为 ccHidden 变成 undefined（渲染侧 `[...ccHidden]` 直接抛）。
  // 旧路径只在"老数据恰好缺这个键"时才会踩到；#238 刀2 把本函数放到了每次读盘路径上，
  // 干净新装也会走，所以在源头修掉。
  // ★ #238 刀7：`ccScale`（控件缩放）已整体删除 ⇒ 它那条同款改名（`renameLegacyCcScaleKeys`）
  //   随之退场。老数据里残留的 `ccScale` 键不用在这里清 —— `store.ts` 的 `partialize` 是
  //   `THEME_SETTING_KEYS` 白名单式，下次写盘自然修剪掉（与刀5A 删三个 cc 字段同一处置）。
  if (state.ccHidden !== undefined) state.ccHidden = renameLegacyCcHiddenKeys(state.ccHidden)
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
 * 值层对齐：defs 驱动的通用值归一化 + 历史字段特判 + 中控高度 clamp + 自定义预设归一。
 *
 * 幂等（跑两次结果相同）、不依赖版本号 —— 这是「结构对齐」的两个组成部分之一
 * （另一部分是 `normalizeThemeMigrationState` 的缺项合并）。
 */
function normalizeThemeValues(state: Record<string, unknown>, base: object): Record<string, unknown> {
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
  const migratedInputMode = typeof state.inputMode === 'string' ? state.inputMode : String((base as Record<string, unknown>).inputMode ?? 'cli')
  const migratedHintMode = state.cliHintMode === 'hidden' || state.cliHintMode === 'compact' ? state.cliHintMode : 'full'
  const migratedFooterLayout = state.footerLayout === 'peri' ? 'peri' : 'free'
  const migratedOverflowMode = state.cliOverflowMode === 'grow' || state.cliOverflowMode === 'overlay' ? state.cliOverflowMode : 'fixed-scroll'
  state.ccHeight = clampCcHeight(typeof state.ccHeight === 'number' ? state.ccHeight : Number((base as Record<string, unknown>).ccHeight ?? 150), {
    inputMode: migratedInputMode as CcInputMode,
    footerLayout: migratedFooterLayout as CcFooterLayout,
    hintMode: migratedHintMode as CcHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: resolveCcHiddenWidgetIds({
        ccHidden: Array.isArray(state.ccHidden) ? state.ccHidden : [],
        cliHintMode: migratedHintMode,
      }),
    }),
    cliOverflowMode: migratedOverflowMode as CcOverflowMode,
  })
  state.customPresets = normalizeCustomPresets(state.customPresets)
  return state
}

/**
 * ★★ 结构对齐（#238 刀2）：补缺控件项 / 补校字段值 / **按 id 合并**。
 *
 * **与版本号无关** —— 由读盘路径**每次读盘无条件跑一次**（挂钩在 `store.ts` 的
 * persist `merge`），不再依赖"记得 bump 版本号"。这条正是本刀要拔的根：
 * 以前它只挂在 migrate 钩子里，而 migrate 只在持久化版本变化时触发 ⇒ 忘 bump 即静默坏。
 *
 * - **缺项补默认**（`normalizeCcLayout` 按当前控件全集逐 id 合并）；
 * - **多余项忽略**（不在全集里的旧 id 自然丢弃）；
 * - **用户手调值一律保留**：`offsetX` / `offsetY` / `order` 与所有已设字段值
 *   （既定口径：「布局归一化不是把用户排布拍平」）；
 * - **幂等**：连续跑两次结果相同（`__tests__/structuralAlignment.test.ts` 钉住）。
 */
export function alignThemeStructure(persisted: unknown, defaults: ThemeMigrationDefaults): Record<string, unknown> {
  return normalizeThemeValues(normalizeThemeMigrationState(persisted, defaults), defaults.base)
}

/**
 * 完整迁移：**版本号变化时**的一次性语义转换（+ 一次结构对齐，幂等）。
 *
 * ★ 结构对齐**不是**本函数独有的职责 —— 每次读盘都会跑（见 `alignThemeStructure`）。
 * 这里保留一次调用，是为了让 migrate 的返回值仍是一份完整可用的状态
 * （zustand 的 migrate 结果会先合并进 store），并且与刀2 之前的行为逐字段相同。
 */
export function themeDomainMigrate(persisted: unknown, defaults: ThemeMigrationDefaults, fromVersion = 0): Record<string, unknown> {
  const state = normalizeThemeMigrationState(persisted, defaults)
  // ★ 真正的一次性语义转换（v6）：普通界面退出"全局终端体"。只在从 <6 升上来时做一次，
  // 之后用户仍可在新字体设置里主动选回等宽体。
  // ★ 反例提醒：**加控件 / 加字段 / 改槽位 / 改 id 都不属于这里** —— 那些由每次读盘的结构对齐覆盖。
  if (fromVersion < 6 && state.globalFont === 'mono') state.globalFont = 'system'
  return normalizeThemeValues(state, defaults.base)
}

