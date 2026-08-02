import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { PROFILE_SCHEMA_VERSION } from './profilePersistence'
import { DEFAULT_CC_LAYOUT, cloneCcLayout, normalizeCcLayout, setCcHiddenState, setCcScaleState, updateCcPlacementState } from './ccLayoutState'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState'
import { createCustomPreset, deleteCustomPreset, normalizeCustomPresets, pickCustomPresetTheme, upsertCustomPreset } from './customPresets'
import { normalizeThemeMigrationState } from './themeMigration'
import { markZoneCustom } from './themePresetState'
import { clampCcHeight, resolveVisibleStatusWidgetCount } from './ccHeightState'
import type { CustomPreset } from './customPresets'
import { useIdentityStore } from './identityStore'
import type { Profile } from './identityStore'

export type { Profile, Session, UserMapping, AgentEntry } from './identityStore'
export type { SessionConfig } from './runtimeStore'

export interface ThemeSettings {
  /** 全局强调色（--accent）：链接/前缀/焦点/选中态统一取色，此前硬编码 #3b82f6 无法主题化 */
  accent: string
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
  spinnerFramePreset: 'sparkles' | 'ascii-line' | 'braille' | 'dots' | 'orbit' | 'clock' | 'wave' | 'blocks' | 'scan' | 'custom'
  spinnerCustomFrames: string
  spinnerVerbSet: 'zh' | 'en' | 'analysis' | 'engineering' | 'custom'
  spinnerCustomVerbs: string
  spinnerDoneMarker: string
  spinnerCancelledMarker: string
  spinnerErrorMarker: string
  spinnerDoneMarkerMode: 'frame' | 'custom'
  spinnerCancelledMarkerMode: 'frame' | 'custom'
  spinnerErrorMarkerMode: 'frame' | 'custom'
  spinnerIntervalMs: number
  spinnerColor: string; spinnerSize: number
  msgStyle: string; msgFont: string; msgTextColor: string; msgLineHeight: number
  messageLayout: 'classic' | 'claude' | 'bubble'
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
  applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void
  setZoneField: (zone: string, partial: Partial<ThemeSettings>) => void
  setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void
  saveCustomPreset: (name: string, id?: string) => string
  applyCustomPreset: (id: string) => void
  removeCustomPreset: (id: string) => void
}

export const DEFAULTS: ThemeSettings = {
  accent: '#3b82f6',
  transparency: 0.85, bgBlur: 16, globalFont: 'system', globalFontSize: 18, globalBgImage: '', globalBgColor: '#e8e8ec', uiScheme: 'light',
  sidebarBg: 'rgba(0,0,0,0.02)', sidebarBgImage: '', sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
  chatBg: '', chatBgImage: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.4, chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
  synKeyword: '#b48ead', synString: '#96b5b4', synComment: '#65737e', synLiteral: '#d08770', synEntity: '#ebcb8b', synFunction: '#8fa1b3',
  synVariable: '#c0c5ce', synProperty: '#c0c5ce', synRegex: '#d08770', synMarkupHeading: '#65737e', synCoReference: '#65737e', synSupport: '#8fa1b3',
  toolOk: '#4EBA65', toolRun: '#93A5FF', toolErr: '#FF6B80', toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.40)', userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
  diffAdded: '#4EBA65', diffRemoved: '#FF6B80',
  toolIndicatorGlow: 0, toolIndicatorGlowColor: '',
  toolConnectorMode: 'none', toolConnectorColor: 'rgba(0,0,0,0.12)',
  toolConnectorStyle: 'solid', toolConnectorWidth: 2, toolConnectorOpacity: 1,
  inputBg: 'rgba(0,0,0,0.02)', inputBgImage: '', inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)', inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputFontSize: 17, inputMinHeight: 56,
  inputMode: 'cli', inputVariant: 'cli', inputShowPlaceholder: true, inputShowHistoryHint: true, inputSubmitButtonMode: 'inline', cliLineWidth: 2, cliLineColor: '', cliTextColor: '', cliPromptColor: '', cliLinePadding: 6, cliContentOffsetY: 0,
  cliHintMode: 'full',
  statusBg: 'transparent', statusBgImage: '', ekgWidth: 150, ekgFontSize: 16, ekgGreen: '#4EBA65', ekgYellow: '#FFC107', ekgRed: '#FF6B80', pillBg: '#373737', pillText: '#999999', prismOnColor: '#4EBA65',
  ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2.0,
  barTrackColor: 'rgba(0,0,0,0.18)', barFillColor: '#4EBA65', barFillFollow: true, barHeight: 10,
  ekgLeftColor: 'rgba(0,0,0,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.08)', tokenDisplay: 'ekg',
  rightBg: 'rgba(0,0,0,0.02)', rightBgImage: '', rightWidth: 260,
  sidebarTransparency: 1, sidebarBlur: 0, chatTransparency: 1, chatBlur: 0, rightTransparency: 1, rightBlur: 0,
  userName: '', userPrefix: '❯', userColor: '',
  toolIndicator: '●',
  spinnerFramePreset: 'sparkles', spinnerCustomFrames: '',
  spinnerVerbSet: 'zh', spinnerCustomVerbs: '',
  spinnerDoneMarker: '✓', spinnerCancelledMarker: '■', spinnerErrorMarker: '!',
  spinnerDoneMarkerMode: 'custom', spinnerCancelledMarkerMode: 'custom', spinnerErrorMarkerMode: 'custom', spinnerIntervalMs: 120,
  spinnerColor: '', spinnerSize: 14,
  msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,
  messageLayout: 'classic', footerLayout: 'free', cliOverflowMode: 'fixed-scroll',
  ccHeight: 150, ccBgHeight: 150, ccBg: 'transparent', ccBgImage: '', ccStatusFontSize: 14,
  ccStyle: 'wave',
  ccVariant: 'terminal',
  modelVariant: 'dropdown', modeVariant: 'pill', sendVariant: 'icon', attachVariant: 'icon',
  modeAutoColor: '#FFC107', modeEditColor: '#A2A9E4',
  ccHidden: [], ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  ccEditMode: false,
  ccScale: {},
  activePreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
}

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
    activePreset: { global: name, sidebar: name, chat: name, cc: name, right: name },
    dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
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
    const theme = pickCustomPresetTheme(preset.theme)
    return {
      ...theme,
      ccLayout: normalizeCcLayout(theme.ccLayout),
      activePreset: { global: id, sidebar: id, chat: id, cc: id, right: id },
      dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
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
  state.spinnerFramePreset = state.spinnerFramePreset === 'ascii-line'
    || state.spinnerFramePreset === 'braille'
    || state.spinnerFramePreset === 'dots'
    || state.spinnerFramePreset === 'orbit'
    || state.spinnerFramePreset === 'clock'
    || state.spinnerFramePreset === 'wave'
    || state.spinnerFramePreset === 'blocks'
    || state.spinnerFramePreset === 'scan'
    || state.spinnerFramePreset === 'custom'
    ? state.spinnerFramePreset
    : 'sparkles'
  state.spinnerCustomFrames = typeof state.spinnerCustomFrames === 'string' ? state.spinnerCustomFrames : ''
  state.spinnerVerbSet = state.spinnerVerbSet === 'en'
    || state.spinnerVerbSet === 'analysis'
    || state.spinnerVerbSet === 'engineering'
    || state.spinnerVerbSet === 'custom'
    ? state.spinnerVerbSet
    : 'zh'
  state.spinnerCustomVerbs = typeof state.spinnerCustomVerbs === 'string' ? state.spinnerCustomVerbs : ''
  state.spinnerDoneMarker = typeof state.spinnerDoneMarker === 'string' ? state.spinnerDoneMarker : '✓'
  state.spinnerCancelledMarker = typeof state.spinnerCancelledMarker === 'string' ? state.spinnerCancelledMarker : '■'
  state.spinnerErrorMarker = typeof state.spinnerErrorMarker === 'string' ? state.spinnerErrorMarker : '!'
  state.spinnerDoneMarkerMode = state.spinnerDoneMarkerMode === 'frame' ? 'frame' : 'custom'
  state.spinnerCancelledMarkerMode = state.spinnerCancelledMarkerMode === 'frame' ? 'frame' : 'custom'
  state.spinnerErrorMarkerMode = state.spinnerErrorMarkerMode === 'frame' ? 'frame' : 'custom'
  state.spinnerIntervalMs = typeof state.spinnerIntervalMs === 'number' && Number.isFinite(state.spinnerIntervalMs)
    ? Math.max(40, Math.min(1000, state.spinnerIntervalMs))
    : 120
  state.messageLayout = state.messageLayout === 'claude' || state.messageLayout === 'bubble' ? state.messageLayout : 'classic'
  state.inputVariant = state.inputVariant === 'cli' || state.inputVariant === 'composer' || state.inputVariant === 'compact' || state.inputVariant === 'command'
    ? state.inputVariant
    : state.inputMode === 'cli' ? 'cli' : 'composer'
  state.inputShowPlaceholder = state.inputShowPlaceholder !== false
  state.inputShowHistoryHint = state.inputShowHistoryHint !== false
  state.inputSubmitButtonMode = state.inputSubmitButtonMode === 'external' || state.inputSubmitButtonMode === 'hidden'
    ? state.inputSubmitButtonMode
    : 'inline'
  state.inputMode = state.inputVariant === 'cli' ? 'cli' : 'default'
  state.footerLayout = state.footerLayout === 'peri' ? 'peri' : 'free'
  state.cliOverflowMode = state.cliOverflowMode === 'grow' || state.cliOverflowMode === 'overlay' ? state.cliOverflowMode : 'fixed-scroll'
  const migratedInputMode = typeof state.inputMode === 'string' ? state.inputMode : DEFAULTS.inputMode
  const migratedHintMode = state.cliHintMode === 'hidden' || state.cliHintMode === 'compact' ? state.cliHintMode : 'full'
  state.ccHeight = clampCcHeight(typeof state.ccHeight === 'number' ? state.ccHeight : DEFAULTS.ccHeight, {
    inputMode: migratedInputMode,
    footerLayout: state.footerLayout,
    hintMode: migratedHintMode,
    visibleStatusWidgets: resolveVisibleStatusWidgetCount({
      hiddenIds: Array.isArray(state.ccHidden) ? state.ccHidden : [],
      inputMode: migratedInputMode,
      ccStyle: state.ccStyle || 'wave',
    }),
    cliOverflowMode: state.cliOverflowMode,
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
