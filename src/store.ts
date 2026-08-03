import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PROFILE_SCHEMA_VERSION } from './profilePersistence'
import { DEFAULT_CC_LAYOUT, cloneCcLayout, normalizeCcLayout, setCcHiddenState, setCcScaleState, updateCcPlacementState } from './ccLayoutState'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState'
import { createCustomPreset, deleteCustomPreset, normalizeCustomPresets, pickCustomPresetTheme, upsertCustomPreset } from './customPresets'
import { normalizeThemeMigrationState } from './themeMigration'
import { markZoneCustom } from './themePresetState'
import { ZONES, ZONE_FIELDS } from './themeFields'
import { clampCcHeight, resolveVisibleStatusWidgetCount } from './ccHeightState'
import { normalizeThemeState, THEME_DEFAULTS } from './themeFieldDefs'
import type { CustomPreset } from './customPresets'
import { useIdentityStore } from './identityStore'
import type { Profile } from './identityStore'

export type { Profile, Session, UserMapping, AgentEntry } from './identityStore'
export type { SessionConfig } from './runtimeStore'

export interface ThemeSettings {
  /** 全局强调色（--accent）：链接/前缀/焦点/选中态统一取色，此前硬编码 #3b82f6 无法主题化 */
  accent: string
  /** 布局骨架显隐（CC 单流模式入口）：tab 条 / 侧栏 / 宠物 */
  showTabBar: boolean; showSidebar: boolean; showPet: boolean
  transparency: number; bgBlur: number; globalFont: string; globalFontSize: number
  globalBgImage: string; globalBgColor: string; uiScheme: string
  sidebarBg: string; sidebarBgImage: string; sidebarWidth: number; sidebarTextColor: string; sidebarNameSize: number; sidebarGroupSize: number
  chatBg: string; chatBgImage: string; chatFont: string; chatFontSize: number; chatLineHeight: number; chatTextColor: string; chatCodeColor: string; chatCodeBg: string
  // 语法高亮（starry-night pl-* 映射，默认 base16-ocean.dark 配色）
  synKeyword: string; synString: string; synComment: string; synLiteral: string; synEntity: string; synFunction: string
  synVariable: string; synProperty: string; synRegex: string; synMarkupHeading: string; synCoReference: string; synSupport: string
  toolOk: string; toolRun: string; toolErr: string; toolNameColor: string; toolSummaryColor: string; userTagBg: string; userTagText: string
  /** diff 块级色（此前复用 toolOk/toolErr，CC 系为独立柔和色） */
  diffAdded: string; diffRemoved: string
  /** diff 词级高亮色（CC 双层：整行背景 + 变更词背景） */
  diffAddedWord: string; diffRemovedWord: string
  toolIndicatorGlow: number; toolIndicatorGlowColor: string
  toolConnectorMode: string; toolConnectorColor: string
  toolConnectorStyle: 'solid' | 'dotted' | 'pulse'; toolConnectorWidth: number; toolConnectorOpacity: number
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; inputSendBg: string; inputFocusBorder: string; inputFontSize: number; inputMinHeight: number
  inputMode: string; inputVariant: 'cli' | 'composer' | 'compact' | 'command'; inputShowPlaceholder: boolean; inputShowHistoryHint: boolean; inputSubmitButtonMode: 'inline' | 'external' | 'hidden'; cliLineWidth: number; cliLineColor: string; cliTextColor: string; cliPromptColor: string; cliLinePadding: number; cliContentOffsetY: number
  cliHintMode: 'hidden' | 'compact' | 'full'
  statusBg: string; statusBgImage: string; ekgWidth: number; ekgFontSize: number; ekgGreen: string; ekgYellow: string; ekgRed: string; pillBg: string; pillText: string; prismOnColor: string
  ekgLineWidth: number; ekgAmplitudeMax: number; ekgSpeedBase: number; ekgSpeedMax: number
  barTrackColor: string; barFillColor: string; barFillFollow: boolean; barHeight: number  // 柱状图：外壳背景/柱子色/是否跟随用量三段色/高度
  ekgLeftColor: string; ekgMovingColor: string; ekgConsumedColor: string; tokenDisplay: string
  rightBg: string; rightBgImage: string; rightWidth: number
  sidebarTransparency: number; sidebarBlur: number; chatTransparency: number; chatBlur: number; rightTransparency: number; rightBlur: number
  userName: string; userPrefix: string; userColor: string
  toolIndicator: string
  spinnerFramePreset: 'sparkles' | 'ascii-line' | 'braille' | 'dots' | 'orbit' | 'clock' | 'wave' | 'blocks' | 'scan' | 'cc' | 'custom'
  spinnerCustomFrames: string
  spinnerVerbSet: 'zh' | 'en' | 'analysis' | 'engineering' | 'cc' | 'custom'
  spinnerCustomVerbs: string
  spinnerDoneMarker: string
  spinnerCancelledMarker: string
  spinnerErrorMarker: string
  spinnerDoneMarkerMode: 'frame' | 'custom'
  spinnerCancelledMarkerMode: 'frame' | 'custom'
  spinnerErrorMarkerMode: 'frame' | 'custom'
  spinnerIntervalMs: number
  spinnerColor: string; spinnerSize: number
  /** CC stalled 渐变红（3s 无响应后帧/文案趋向此色） */
  spinnerStalledColor: string
  msgStyle: string; msgFont: string; msgTextColor: string; msgLineHeight: number
  messageLayout: 'classic' | 'claude' | 'bubble'
  /** CC 视觉还原：助手消息 ● 圆点 */
  assistantDot: boolean; assistantDotGlyph: string; assistantDotColor: string
  footerLayout: 'free' | 'peri'
  cliOverflowMode: 'fixed-scroll' | 'grow' | 'overlay'
  ccHeight: number; ccBgHeight: number; ccBg: string
  ccBgImage: string
  ccStatusFontSize: number
  ccStyle: string
  ccVariant: string
  modelVariant: string; modeVariant: string; sendVariant: string; attachVariant: string
  /** 权限模式徽标色（此前硬编码 #FFC107/#A2A9E4） */
  modeAutoColor: string; modeEditColor: string
  ccHidden: string[]
  ccLayout: CcLayoutV3
  ccEditMode: boolean
  ccScale: Record<string, number>  // naturalSize 控件独立缩放% (50-200) key=widget id
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
}

/**
 * themeStore — 主题状态域（阶段 1：store 按域拆分后收敛）。
 *
 * 唯一持久化域（pylon-theme）。身份/运行时/Workspace 状态已迁出到
 * identityStore / runtimeStore / workspaceStore（组合出口见文件尾）。
 */
type ThemeState = ThemeSettings & {
  customPresets: CustomPreset[]
  setCcEditMode: (enabled: boolean) => void
  setCcHeight: (height: number) => void
  updateCcPlacement: (id: string, partial: Partial<CcWidgetPlacement>) => void
  resetCcLayout: () => void
  setCcHidden: (id: string, hidden: boolean) => void
  setCcScale: (id: string, scale: number) => void
  resetTheme: () => void
  /** 重置单个 zone 的字段到默认值（不清其他 zone），并清该 zone 的 dirty/activePreset */
  resetZone: (zone: string) => void
  applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void
  setZoneField: (zone: string, partial: Partial<ThemeSettings>) => void
  setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void
  saveCustomPreset: (name: string, id?: string) => string
  applyCustomPreset: (id: string) => void
  removeCustomPreset: (id: string) => void
}

/**
 * DEFAULTS 由 defs 派生（THEME_DEFAULTS 标量默认值）+
 * 对象/复合字段（ccLayout/ccHidden/ccScale/META 路由）保留显式声明。
 * 加标量字段：defs 加声明 + THEME_DEFAULTS 加默认值即可，此处自动。
 */
export const DEFAULTS: ThemeSettings = {
  ...THEME_DEFAULTS,
  ccHidden: [],
  ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  ccEditMode: false,
  ccScale: {},
  activePreset: { global: '', layout: '', sidebar: '', chat: '', cc: '', right: '' },
  dirty: { global: false, layout: false, sidebar: false, chat: false, cc: false, right: false },
} as unknown as ThemeSettings

export const useStore = create<ThemeState>()(persist(
  (set, get) => ({
  ...DEFAULTS,

  customPresets: [],

  setZoneField: (zone, partial) => set(state => ({
    ...partial,
    ...markZoneCustom(state, zone),
  })),
  setCcEditMode: (enabled) => set({ ccEditMode: enabled }),
  setCcHeight: (height) => set(state => ({
    ccHeight: clampCcHeight(height, {
      inputMode: state.inputMode,
      footerLayout: state.footerLayout,
      hintMode: state.cliHintMode,
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: state.ccHidden,
        inputMode: state.inputMode,
        ccStyle: state.ccStyle,
      }),
      cliOverflowMode: state.cliOverflowMode,
    }),
    ...markZoneCustom(state, 'cc'),
  })),
  updateCcPlacement: (id, partial) => set(state => ({
    ccLayout: updateCcPlacementState(state.ccLayout, id, partial),
    ...markZoneCustom(state, 'cc'),
  })),
  resetCcLayout: () => set(state => ({
    ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
    ...markZoneCustom(state, 'cc'),
  })),
  setCcHidden: (id, hidden) => set(state => ({
    ccHidden: setCcHiddenState(state.ccHidden, id, hidden),
    ...markZoneCustom(state, 'cc'),
  })),
  setCcScale: (id, scale) => set(state => ({
    ccScale: setCcScaleState(state.ccScale, id, scale),
    ...markZoneCustom(state, 'cc'),
  })),

  resetTheme: () => set(structuredClone(DEFAULTS)),

  resetZone: (zone) => set(state => {
    const fields = (ZONE_FIELDS[zone] ?? []) as (keyof ThemeSettings)[]
    // 只重置标量主题字段；ccLayout/ccHidden/ccScale 等对象字段走专用动作（避免误清用户排布）
    const reset = Object.fromEntries(
      fields
        .filter(field => {
          const value = DEFAULTS[field]
          return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        })
        .map(field => [field, DEFAULTS[field]]),
    )
    return {
      ...reset,
      activePreset: { ...state.activePreset, [zone]: '' },
      dirty: { ...state.dirty, [zone]: false },
    }
  }),

  /**
   * 应用某个 zone 的预设（来自全局预设的子集）
   * 1. 写入该 zone 的所有字段
   * 2. 记录 activePreset[zone] = presetName
   * 3. 清除 dirty[zone]
   * 4. 不影响其他 zone
   */
  applyZonePreset: (zone, presetName, presetTheme) => set(state => ({
    ...presetTheme,
    ...(presetTheme.ccLayout ? { ccLayout: normalizeCcLayout(presetTheme.ccLayout) } : {}),
    activePreset: { ...state.activePreset, [zone]: presetName },
    dirty: { ...state.dirty, [zone]: false },
  })),

  /**
   * 切换全局预设
   * 1. 把全局预设的全部字段写入 store
   * 2. 把每个 zone 的 activePreset 设为同名的 zone-preset（即该 zone 的子集应用）
   * 3. 所有 zone 的 dirty 清零
   */
  setGlobalPreset: (name, theme) => set(_ => ({
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout),
    activePreset: Object.fromEntries(ZONES.map(zone => [zone, name])),
    dirty: Object.fromEntries(ZONES.map(zone => [zone, false])),
  })),
  saveCustomPreset: (name, id) => {
    const state = get()
    const existing = id ? state.customPresets.find(preset => preset.id === id) : undefined
    const now = Date.now()
    const preset = existing
      ? { ...existing, name: name.trim().slice(0, 40), theme: pickCustomPresetTheme(state), updatedAt: now }
      : createCustomPreset(name, pickCustomPresetTheme(state), now)
    set({ customPresets: upsertCustomPreset(state.customPresets, preset) })
    return preset.id
  },
  applyCustomPreset: (id) => set(state => {
    const preset = state.customPresets.find(item => item.id === id)
    if (!preset) return state
    // 防御性归一化：自定义预设可能来自旧版本/脏数据，按 defs 规则修正
    const theme = normalizeThemeState(pickCustomPresetTheme(preset.theme) as Record<string, unknown>) as Partial<ThemeSettings>
    return {
      ...theme,
      ccLayout: normalizeCcLayout(theme.ccLayout),
      activePreset: Object.fromEntries(ZONES.map(zone => [zone, id])),
      dirty: Object.fromEntries(ZONES.map(zone => [zone, false])),
    }
  }),
  removeCustomPreset: (id) => set(state => {
    const activePreset = Object.fromEntries(
      Object.entries(state.activePreset).map(([zone, value]) => [zone, value === id ? '' : value]),
    )
    const dirty = { ...state.dirty }
    for (const [zone, value] of Object.entries(state.activePreset)) {
      if (value === id) dirty[zone] = true
    }
    return { customPresets: deleteCustomPreset(state.customPresets, id), activePreset, dirty }
  }),
}),
{ name: 'pylon-theme', version: PROFILE_SCHEMA_VERSION, migrate: persisted => {
  const state = (persisted || {}) as Partial<ThemeState> & { profiles?: Profile[]; activeProfileId?: string }
  const normalizedTheme = normalizeThemeMigrationState(state, {
    base: DEFAULTS,
    activePreset: DEFAULTS.activePreset,
    dirty: DEFAULTS.dirty,
    ccLayout: DEFAULTS.ccLayout,
  })
  Object.assign(state, normalizedTheme)
  // defs 驱动的通用值归一化（select 枚举/number 范围/boolean/color/text 类型 → def.default）
  Object.assign(state, normalizeThemeState(state))
  // 历史字段特殊规则（与 defs 类型不完全一致，保留既有语义）
  state.inputShowPlaceholder = state.inputShowPlaceholder !== false
  state.inputShowHistoryHint = state.inputShowHistoryHint !== false
  state.inputVariant = state.inputVariant === 'cli' || state.inputVariant === 'composer' || state.inputVariant === 'compact' || state.inputVariant === 'command'
    ? state.inputVariant
    : state.inputMode === 'cli' ? 'cli' : 'composer'
  state.inputMode = state.inputVariant === 'cli' ? 'cli' : 'default'
  const migratedInputMode = typeof state.inputMode === 'string' ? state.inputMode : DEFAULTS.inputMode
  const migratedHintMode = state.cliHintMode === 'hidden' || state.cliHintMode === 'compact' ? state.cliHintMode : 'full'
  const migratedFooterLayout = state.footerLayout === 'peri' ? 'peri' : 'free'
  const migratedOverflowMode = state.cliOverflowMode === 'grow' || state.cliOverflowMode === 'overlay' ? state.cliOverflowMode : 'fixed-scroll'
  state.ccHeight = clampCcHeight(typeof state.ccHeight === 'number' ? state.ccHeight : DEFAULTS.ccHeight, {
    inputMode: migratedInputMode,
    footerLayout: migratedFooterLayout,
    hintMode: migratedHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: Array.isArray(state.ccHidden) ? state.ccHidden : [],
      inputMode: migratedInputMode,
      ccStyle: state.ccStyle || 'wave',
    }),
    cliOverflowMode: migratedOverflowMode,
  })
  state.customPresets = normalizeCustomPresets(state.customPresets)
  return state as ThemeState
}, partialize: (state) => {
  // 2026-08-02 修复：customPresets 不再剔除——用户保存的自定义预设必须跨重启保留
  // （Settings 提供完整保存/应用/删除 UI，此前重启即丢属缺陷）。ccEditMode/dirty/函数照旧排除。
  const { ccEditMode, setCcEditMode, setCcHeight, updateCcPlacement, resetCcLayout, setCcHidden, setCcScale, resetTheme, applyZonePreset, setZoneField, setGlobalPreset, saveCustomPreset, applyCustomPreset, removeCustomPreset, dirty, ...persisted } = state as ThemeState
  return persisted
}, onRehydrateStorage: () => state => {
  // 阶段 1 迁移：旧 pylon-theme 里的 profiles/activeProfileId 迁入 identityStore（一次性）
  const legacy = state as unknown as { profiles?: Profile[]; activeProfileId?: string }
  if (legacy?.profiles && Array.isArray(legacy.profiles) && legacy.profiles.length > 0) {
    useIdentityStore.setState({
      profiles: legacy.profiles,
      activeProfileId: typeof legacy.activeProfileId === 'string' ? legacy.activeProfileId : legacy.profiles[0].id,
    })
  }
  useIdentityStore.getState().hydrateSessions()
}}))

// ── 组合出口：按域导入点 ──
export { useIdentityStore } from './identityStore'
export { useRuntimeStore } from './runtimeStore'
export { useWorkspaceStore } from './workspaceStore'
