/**
 * presetReducer — 预设路由的纯计算层（A0 抽出，A1 改模型）。
 *
 * 六个预设 action 的全部状态转换从 store.ts 迁到这里，store 只留
 * set(reducer(state, args)) 薄壳。依赖全部显式 .ts：node --experimental-strip-types
 * 可直接 import 本模块 → 预设语义可做确定性行为测试（save 的 id/now 由 shell 注入）。
 *
 * A1 模型：appliedPreset（基准名，无 'custom' 值）+ custom（触碰标记，事件驱动）+
 * PRESET_ZONES（5 zone，layout 无字段排除）。字段写入只标 custom，不动基准。
 */

/** 参与预设路由的 zone：layout 无字段（实证 zone:'layout'=0）排除 */
export const PRESET_ZONES = ['global', 'sidebar', 'chat', 'cc', 'right'] as const
export type PresetZone = (typeof PRESET_ZONES)[number]
import type { CcLayoutV3 } from '../../ccLayoutState.ts'
import { normalizeCcLayout } from '../../ccLayoutState.ts'
import {
  clampCcHeight,
  resolveVisibleStatusWidgetCount,
  type CcFooterLayout,
  type CcHintMode,
  type CcInputMode,
  type CcOverflowMode,
} from '../../ccHeightState.ts'
import {
  pickCustomPresetTheme,
  upsertCustomPreset,
  deleteCustomPreset,
  type CustomPreset,
} from '../../customPresets.ts'
import { normalizeThemeState, THEME_DEFAULTS } from '../../themeFieldDefs.ts'
import { markZoneCustom } from '../../themePresetState.ts'
import type { ThemeSettings } from '../../store.ts'
import type { PresetBundleV2 } from './presetBundle.ts'

const DEFAULTS = THEME_DEFAULTS as Record<string, string | number | boolean>

/** W2-15（F3-B）：全量主题 → 相对 DEFAULTS 的 delta（过滤与默认相等键；自定义预设存储用） */
export function toThemeDelta(theme: Record<string, unknown> | Partial<ThemeSettings>): Partial<ThemeSettings> {
  const delta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(theme)) {
    if (key in DEFAULTS && value === DEFAULTS[key]) continue
    delta[key] = value
  }
  return delta as Partial<ThemeSettings>
}

/**
 * 预设路由所需的状态切片。字段类型与 ThemeState 兼容（结构可赋值）：
 * ThemeState → ThemePresetState 无需断言；patch 用 ThemePresetPatch（兼容 Partial<ThemeState>）。
 */
export interface ThemePresetState {
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
  customPresets: CustomPreset[]
  ccLayout: CcLayoutV3
  ccHeight: number
  ccBgHeight: number
  inputMode: string
  inputVariant: string
  inputSubmitButtonMode: string
  footerLayout: string
  cliHintMode: string
  ccHidden: string[]
  ccStyle: string
  cliOverflowMode: string
}

/** reducer 返回的 patch：主题字段 + 预设路由/cc 同步字段（可赋值给 Partial<ThemeState>） */
export type ThemePresetPatch = Partial<ThemeSettings> & Partial<Pick<ThemePresetState, 'appliedPreset' | 'custom' | 'customPresets' | 'ccLayout' | 'ccHeight' | 'ccBgHeight'>>

/** cc 高度 clamp（迁自 store.ts，行为不变）：布局约束真值来自 ccHeightState */
function clampPresetCcHeight(theme: Partial<ThemeSettings>): number {
  const inputMode = (theme.inputMode ?? String(DEFAULTS.inputMode)) as CcInputMode
  const footerLayout = (theme.footerLayout ?? String(DEFAULTS.footerLayout)) as CcFooterLayout
  const hintMode = (theme.cliHintMode ?? String(DEFAULTS.cliHintMode)) as CcHintMode
  const ccStyle = theme.ccStyle ?? String(DEFAULTS.ccStyle)
  const cliOverflowMode = (theme.cliOverflowMode ?? String(DEFAULTS.cliOverflowMode)) as CcOverflowMode
  const visibleStatusWidgets = resolveVisibleStatusWidgetCount({
    hiddenIds: Array.isArray(theme.ccHidden) ? theme.ccHidden : [],
    inputMode,
    ccStyle,
    submitButtonMode: String(theme.inputSubmitButtonMode ?? DEFAULTS.inputSubmitButtonMode),
  })
  return clampCcHeight(typeof theme.ccHeight === 'number' ? theme.ccHeight : Number(DEFAULTS.ccHeight), {
    inputMode,
    footerLayout,
    hintMode,
    visibleStatusWidgets,
    cliOverflowMode,
  })
}

/**
 * 预设应用的 cc 高度同步：ccHeight 被 clamp 上调时，ccBgHeight 必须跟随
 * （否则背景比容器短，露出底部无背景条）。返回两者。
 */
function syncPresetCcHeight(theme: Partial<ThemeSettings>): { ccHeight: number; ccBgHeight: number } {
  const ccHeight = clampPresetCcHeight(theme)
  const bgHeight = typeof theme.ccBgHeight === 'number' ? theme.ccBgHeight : Number(DEFAULTS.ccBgHeight)
  return { ccHeight, ccBgHeight: Math.max(bgHeight, ccHeight) }
}

/**
 * inputVariant↔inputMode 联动不变量（MEDIUM 5 收敛）：inputMode==='cli' ⟺ inputVariant==='cli'。
 * 单一真值：setZoneFieldReducer 漏斗 / migration 派生 / UI 层 chips sync 全部满足同一关系。
 */
export function resolveInputMode(inputVariant: string): 'cli' | 'default' {
  return inputVariant === 'cli' ? 'cli' : 'default'
}

export function applyInputVariantInvariant(
  partial: Record<string, unknown>,
  current: { inputMode: string; inputVariant: string },
): Record<string, unknown> {
  const patch = { ...partial }
  if ('inputVariant' in patch) {
    patch.inputMode = resolveInputMode(String(patch.inputVariant))
  } else if ('inputMode' in patch) {
    const inputMode = String(patch.inputMode)
    patch.inputVariant = inputMode === 'cli'
      ? 'cli'
      : (current.inputVariant !== 'cli' ? current.inputVariant : 'composer')
  }
  return patch
}

/**
 * 单字段写入（D1 校验漏斗）：写入字段 + 该 zone 标记 custom（基准不动）。
 * 漏斗内聚三条布局不变量（此前只在 setCcHeight/预设 action/migrate 各自维护）：
 * - inputVariant↔inputMode 联动（cli ⟺ cli，否则 inputMode=default）
 * - ccHeight clamp（≥ resolveCcMinHeight 布局约束真值）
 * - ccBgHeight ≥ ccHeight（背景不短于容器）
 */
export function setZoneFieldReducer(state: ThemePresetState, zone: string, partial: Record<string, unknown>): ThemePresetPatch {
  // 联动：先于 cc 高度 clamp（clamp 需要同步后的 inputMode）
  const patch = applyInputVariantInvariant(partial, state)

  // cc 高度不变量：高度或影响最小高的结构字段被写时整组收敛。
  // 属性面板/设置页恢复控件或切换 CLI 布局后，状态高度必须与 CSS 实际最小高一致。
  if (zone === 'cc' || 'ccHeight' in patch || 'ccBgHeight' in patch) {
    const merged = { ...state, ...patch } as ThemePresetState
    const clamped = clampCcHeight(Number(merged.ccHeight), {
      inputMode: String(merged.inputMode),
      footerLayout: String(merged.footerLayout),
      hintMode: String(merged.cliHintMode),
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: merged.ccHidden ?? [],
        inputMode: String(merged.inputMode),
        ccStyle: String(merged.ccStyle),
        submitButtonMode: String(merged.inputSubmitButtonMode ?? 'inline'),
      }),
      cliOverflowMode: String(merged.cliOverflowMode),
    })
    const bg = Number('ccBgHeight' in patch ? patch.ccBgHeight : merged.ccBgHeight)
    patch.ccHeight = clamped
    patch.ccBgHeight = Math.max(Number.isFinite(bg) ? bg : 0, clamped)
  }

  return {
    ...patch,
    ...markZoneCustom(state, zone),
  }
}

/** 应用 zone 预设：写字段 + 记基准名 + 清该 zone custom（A2：不再手写 global 标记，全局由 deriveGlobalStatus 派生） */
export function applyZonePresetReducer(
  state: ThemePresetState,
  zone: string,
  presetName: string,
  presetTheme: Partial<ThemeSettings>,
): ThemePresetPatch {
  return {
    ...presetTheme,
    // cc zone 预设即恢复规范排布（预设不携带 ccLayout → 默认布局），与其他 zone 预设一致
    ...(zone === 'cc' ? { ccLayout: normalizeCcLayout(presetTheme.ccLayout) } : {}),
    ...(zone === 'cc' && presetTheme.ccHeight !== undefined ? syncPresetCcHeight(presetTheme) : {}),
    appliedPreset: { ...state.appliedPreset, [zone]: presetName },
    custom: { ...state.custom, [zone]: false },
  }
}

/** 切换全局预设：全 PRESET_ZONES 记名 + 全 custom 清零 + 恢复规范排布 */
export function setGlobalPresetReducer(name: string, theme: Partial<ThemeSettings>): ThemePresetPatch {
  return {
    ...DEFAULTS,
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    ...(theme.ccHeight !== undefined ? syncPresetCcHeight(theme) : {}),
    appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, name])),
    custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  }
}

export interface SavePresetCommand {
  /** 已存在的预设 id（更新场景由调用方传入） */
  id: string
  name: string
  /** 由 store shell 注入，reducer 保持确定性 */
  now: number
  /** Optional v2 owner contributions captured by the shell. */
  bundle?: PresetBundleV2
}

/** 保存自定义预设：命名强制；捕获当前全主题；upsert；返回 savedId */
export function saveCustomPresetReducer(
  state: ThemePresetState,
  command: SavePresetCommand,
): { patch: ThemePresetPatch; savedId: string } {
  const { id, now } = command
  const cleanName = command.name.trim()
  if (!cleanName) throw new Error('预设名称不能为空')
  const existing = state.customPresets.find(preset => preset.id === id)
  const preset = existing
    ? { ...existing, name: cleanName.slice(0, 40), theme: toThemeDelta(pickCustomPresetTheme(state)), updatedAt: now, ...(command.bundle ? { bundle: command.bundle } : {}) }
    : { id, name: cleanName.slice(0, 40), theme: structuredClone(toThemeDelta(pickCustomPresetTheme(state))), createdAt: now, updatedAt: now, ...(command.bundle ? { bundle: command.bundle } : {}) }
  return { patch: { customPresets: upsertCustomPreset(state.customPresets, preset) }, savedId: preset.id }
}

/**
 * 应用自定义预设：防御性归一化 + 全 PRESET_ZONES 记 id + 全 custom 清零。
 * theme 显式传入时直接消费（bundle 驱动，免疫 id 漂移）；否则按 id 回查
 * customPresets（旧路径）。两者都落空返回 null（调用方必须可见地报告，
 * 不得静默吞掉）。
 */
export function applyCustomPresetReducer(
  state: ThemePresetState,
  id: string,
  explicitTheme?: Record<string, unknown>,
): ThemePresetPatch | null {
  const source = explicitTheme
    ?? state.customPresets.find(item => item.id === id)?.theme
  if (!source) return null
  const theme = normalizeThemeState(pickCustomPresetTheme(source) as Record<string, unknown>) as Partial<ThemeSettings>
  return {
    ...DEFAULTS,
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    ...(theme.ccHeight !== undefined ? syncPresetCcHeight(theme) : {}),
    appliedPreset: Object.fromEntries(PRESET_ZONES.map(zone => [zone, id])),
    custom: Object.fromEntries(PRESET_ZONES.map(zone => [zone, false])),
  }
}

/**
 * 全局预设状态派生（A2，覆盖规则 1/2 的单一真值）：
 * - 全空且无触碰 → ''
 * - 任一 zone 触碰（custom=true）→ 'custom'（规则 1：改字段 → 全局变 custom）
 * - 所有非空基准一致且无空 zone → 跟随该基准（空 zone 视为偏离 → custom，规则 2）
 */
export function deriveGlobalStatus(state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>): string {
  const zones = PRESET_ZONES
  if (zones.every(zone => state.appliedPreset[zone] === '' && state.custom[zone] === false)) return ''
  if (zones.some(zone => state.custom[zone])) return 'custom'
  const first = state.appliedPreset[zones[0]]
  if (first !== '' && zones.every(zone => state.appliedPreset[zone] === first)) return first
  return 'custom'
}

/** 单 zone 状态派生：基准名 + 是否自定义 */
export function deriveZoneStatus(
  state: Pick<ThemePresetState, 'appliedPreset' | 'custom'>,
  zone: PresetZone,
): { appliedName: string; isCustom: boolean } {
  return { appliedName: state.appliedPreset[zone] ?? '', isCustom: state.custom[zone] === true }
}

/**
 * 删除自定义预设：引用该 id 的 zone 失去基准（appliedPreset=''）且 custom=true——
 * 字段保留已删预设的值 = 失去基准的自定义快照（不是默认态）。
 */
export function removeCustomPresetReducer(state: ThemePresetState, id: string): ThemePresetPatch {
  const appliedPreset = { ...state.appliedPreset }
  const custom = { ...state.custom }
  for (const [zone, value] of Object.entries(appliedPreset)) {
    if (value === id) {
      appliedPreset[zone] = ''
      custom[zone] = true
    }
  }
  return { customPresets: deleteCustomPreset(state.customPresets, id), appliedPreset, custom }
}
