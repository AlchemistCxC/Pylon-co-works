import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_CC_LAYOUT, cloneCcLayout, setCcHiddenState, setCcScaleState, updateCcPlacementState } from './ccLayoutState'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState'
import { createCustomPresetId } from './customPresets'
import { markZoneCustom } from './themePresetState'
import { ZONE_FIELDS } from './themeFieldDefs'
import { clampCcHeight, resolveVisibleStatusWidgetCount } from './ccHeightState'
import { THEME_SETTING_KEYS } from './themeFieldDefs'
import { THEME_SCHEMA_VERSION, themeDomainMigrate } from './domains/theme/migration'
import { DEFAULTS } from './domains/theme/themeDefaults'
import type { CustomPreset } from './customPresets'
import {
  applyCustomPresetReducer,
  applyZonePresetReducer,
  removeCustomPresetReducer,
  saveCustomPresetReducer,
  setGlobalPresetReducer,
  setZoneFieldReducer,
} from './domains/theme/presetReducer'
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
  toolOk: string; toolRun: string; toolErr: string; userTagBg: string; userTagText: string
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
  statusBg: string; statusBgImage: string; ekgWidth: number; ekgGreen: string; ekgYellow: string; ekgRed: string; pillBg: string; pillText: string; prismOnColor: string
  barTrackColor: string; barFillColor: string; barFillFollow: boolean; barHeight: number  // 柱状图：外壳背景/柱子色/是否跟随用量三段色/高度
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
  appliedPreset: Record<string, string>
  custom: Record<string, boolean>
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
  /** 重置单个 zone 的字段到默认值（不清其他 zone），并清该 zone 的 custom/appliedPreset */
  resetZone: (zone: string) => void
  applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void
  setZoneField: (zone: string, partial: Partial<ThemeSettings>) => void
  setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void
  saveCustomPreset: (name: string, id?: string) => string
  applyCustomPreset: (id: string) => void
  removeCustomPreset: (id: string) => void
}

// clampPresetCcHeight / syncPresetCcHeight 已随预设动作迁入 domains/theme/presetReducer.ts

// DEFAULTS 定义移入 domains/theme/themeDefaults.ts（可被 node import → 完整性断言测试）

export const useStore = create<ThemeState>()(persist(
  (set, get) => ({
  ...DEFAULTS,

  customPresets: [],

  setZoneField: (zone, partial) => set(state => setZoneFieldReducer(state, zone, partial)),
  setCcEditMode: (enabled) => set({ ccEditMode: enabled }),
  setCcHeight: (height) => set(state => {
    // D1：ccBgHeight 必须 ≥ ccHeight（背景不短于容器，与 setZoneField 漏斗同不变量）
    const ccHeight = clampCcHeight(height, {
      inputMode: state.inputMode,
      footerLayout: state.footerLayout,
      hintMode: state.cliHintMode,
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: state.ccHidden,
        inputMode: state.inputMode,
        ccStyle: state.ccStyle,
        submitButtonMode: state.inputSubmitButtonMode,
      }),
      cliOverflowMode: state.cliOverflowMode,
    })
    return { ccHeight, ccBgHeight: Math.max(state.ccBgHeight, ccHeight), ...markZoneCustom(state, 'cc') }
  }),
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
      appliedPreset: { ...state.appliedPreset, [zone]: '' },
      custom: { ...state.custom, [zone]: false },
    }
  }),

  // 六个预设动作：纯计算在 domains/theme/presetReducer.ts，此处只留 set(reducer(state, args)) 薄壳
  applyZonePreset: (zone, presetName, presetTheme) => set(state => applyZonePresetReducer(state, zone, presetName, presetTheme)),
  setGlobalPreset: (name, theme) => set(() => setGlobalPresetReducer(name, theme)),
  saveCustomPreset: (name, id) => {
    const state = get()
    const now = Date.now()
    // id/now 由 shell 注入：reducer 保持确定性（A0 起，预设逻辑可做确定性行为测试）
    const resolvedId = id && state.customPresets.some(preset => preset.id === id)
      ? id
      : createCustomPresetId(now, Object.keys(state.customPresets))
    const { patch, savedId } = saveCustomPresetReducer(state, { id: resolvedId, name, now })
    set(patch)
    return savedId
  },
  applyCustomPreset: (id) => set(state => applyCustomPresetReducer(state, id) ?? {}),
  removeCustomPreset: (id) => set(state => removeCustomPresetReducer(state, id)),
}),
{ name: 'pylon-theme', version: THEME_SCHEMA_VERSION, migrate: persisted =>
  themeDomainMigrate(persisted, {
    base: DEFAULTS,
    appliedPreset: DEFAULTS.appliedPreset,
    custom: DEFAULTS.custom,
    ccLayout: DEFAULTS.ccLayout,
  }),
  partialize: (state) => {
    // A4 白名单：THEME_SETTING_KEYS（主题字段，含 ccLayout/ccHidden/ccScale 对象）+ 显式 meta。
    // 取代"排除式 partialize"——杜绝新增 action/临时字段误持久化，并修剪迁移遗留的旧键。
    const persisted: Record<string, unknown> = {}
    for (const key of THEME_SETTING_KEYS) persisted[key] = state[key]
    persisted.appliedPreset = state.appliedPreset
    persisted.custom = state.custom
    persisted.customPresets = state.customPresets
    return persisted
  },
  onRehydrateStorage: () => state => {
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
