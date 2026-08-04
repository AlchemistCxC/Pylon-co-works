/**
 * presetReducer — 预设路由的纯计算层（A0，行为保持）。
 *
 * 六个预设 action 的全部状态转换从 store.ts 迁到这里，store 只留
 * set(reducer(state, args)) 薄壳。依赖全部显式 .ts：node --experimental-strip-types
 * 可直接 import 本模块 → 预设语义可做确定性行为测试（save 的 id/now 由 shell 注入）。
 *
 * A1 将在此基础上改模型（dirty→custom、activePreset→appliedPreset、PRESET_ZONES）。
 */
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
import { ZONES } from '../../themeFields.ts'
import type { ThemeSettings } from '../../store.ts'

const DEFAULTS = THEME_DEFAULTS as Record<string, string | number | boolean>

/**
 * 预设路由所需的状态切片。字段类型与 ThemeState 兼容（结构可赋值）：
 * ThemeState → ThemePresetState 无需断言；patch 用 ThemePresetPatch（兼容 Partial<ThemeState>）。
 */
export interface ThemePresetState {
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
  customPresets: CustomPreset[]
  ccLayout: CcLayoutV3
  ccHeight: number
  ccBgHeight: number
  inputMode: string
  footerLayout: string
  cliHintMode: string
  ccHidden: string[]
  ccStyle: string
  cliOverflowMode: string
}

/** reducer 返回的 patch：主题字段 + 预设路由/cc 同步字段（可赋值给 Partial<ThemeState>） */
export type ThemePresetPatch = Partial<ThemeSettings> & Partial<Pick<ThemePresetState, 'activePreset' | 'dirty' | 'customPresets' | 'ccLayout' | 'ccHeight' | 'ccBgHeight'>>

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

/** 单字段写入：写入字段 + 该 zone 标记 custom/dirty */
export function setZoneFieldReducer(state: ThemePresetState, zone: string, partial: Record<string, unknown>): ThemePresetPatch {
  return {
    ...partial,
    ...markZoneCustom(state, zone),
  }
}

/** 应用 zone 预设：写字段 + 记录预设名 + 清 dirty；切离全局 → 全局标 custom */
export function applyZonePresetReducer(
  state: ThemePresetState,
  zone: string,
  presetName: string,
  presetTheme: Partial<ThemeSettings>,
): ThemePresetPatch {
  const globalPreset = state.activePreset.global
  const breaksGlobal = Boolean(globalPreset) && globalPreset !== 'custom' && globalPreset !== presetName
  return {
    ...presetTheme,
    // cc zone 预设即恢复规范排布（预设不携带 ccLayout → 默认布局），与其他 zone 预设一致
    ...(zone === 'cc' ? { ccLayout: normalizeCcLayout(presetTheme.ccLayout) } : {}),
    ...(zone === 'cc' && presetTheme.ccHeight !== undefined ? syncPresetCcHeight(presetTheme) : {}),
    activePreset: {
      ...state.activePreset,
      [zone]: presetName,
      ...(breaksGlobal ? { global: 'custom' } : {}),
    },
    dirty: {
      ...state.dirty,
      [zone]: false,
      ...(breaksGlobal ? { global: true } : {}),
    },
  }
}

/** 切换全局预设：全 zone 记名 + 全 dirty 清零 + 恢复规范排布 */
export function setGlobalPresetReducer(name: string, theme: Partial<ThemeSettings>): ThemePresetPatch {
  return {
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    ...(theme.ccHeight !== undefined ? syncPresetCcHeight(theme) : {}),
    activePreset: Object.fromEntries(ZONES.map(zone => [zone, name])),
    dirty: Object.fromEntries(ZONES.map(zone => [zone, false])),
  }
}

export interface SavePresetCommand {
  /** 已存在的预设 id（更新场景由调用方传入） */
  id: string
  name: string
  /** 由 store shell 注入，reducer 保持确定性 */
  now: number
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
    ? { ...existing, name: cleanName.slice(0, 40), theme: pickCustomPresetTheme(state), updatedAt: now }
    : { id, name: cleanName.slice(0, 40), theme: structuredClone(pickCustomPresetTheme(state)), createdAt: now, updatedAt: now }
  return { patch: { customPresets: upsertCustomPreset(state.customPresets, preset) }, savedId: preset.id }
}

/** 应用自定义预设：防御性归一化 + 全 zone 记 id + 全 dirty 清零；找不到返回 null（无操作） */
export function applyCustomPresetReducer(state: ThemePresetState, id: string): ThemePresetPatch | null {
  const preset = state.customPresets.find(item => item.id === id)
  if (!preset) return null
  const theme = normalizeThemeState(pickCustomPresetTheme(preset.theme) as Record<string, unknown>) as Partial<ThemeSettings>
  return {
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    ...(theme.ccHeight !== undefined ? syncPresetCcHeight(theme) : {}),
    activePreset: Object.fromEntries(ZONES.map(zone => [zone, id])),
    dirty: Object.fromEntries(ZONES.map(zone => [zone, false])),
  }
}

/** 删除自定义预设：正在应用的 zone 保留其值但不再跟随命名预设 → 语义为 custom */
export function removeCustomPresetReducer(state: ThemePresetState, id: string): ThemePresetPatch {
  const activePreset = { ...state.activePreset }
  const dirty = { ...state.dirty }
  for (const [zone, value] of Object.entries(activePreset)) {
    if (value === id) {
      activePreset[zone] = 'custom'
      dirty[zone] = true
    }
  }
  return { customPresets: deleteCustomPreset(state.customPresets, id), activePreset, dirty }
}
