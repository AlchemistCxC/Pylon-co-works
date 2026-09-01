import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { reportRuntimeError } from './runtimeError'
import { DEFAULT_CC_LAYOUT, cloneCcLayout, setCcHiddenState, setCcScaleState, updateCcPlacementState } from './ccLayoutState'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState'
import { createCustomPresetId, pickCustomPresetTheme } from './customPresets'
import { markZoneCustom } from './themePresetState'
import { ZONE_FIELDS } from './themeFieldDefs'
import { clampCcHeight, resolveVisibleStatusWidgetCount } from './ccHeightState'
import { THEME_SETTING_KEYS } from './themeFieldDefs'
import { THEME_SCHEMA_VERSION, themeDomainMigrate } from './domains/theme/migration'
import { DEFAULTS } from './domains/theme/themeDefaults'
import type { CustomPreset } from './customPresets'
import { reportLegacyProfilePayload } from './app/bootstrap/hydrateIdentityAndWorkspace'
import {
  applyCustomPresetReducer,
  applyZonePresetReducer,
  removeCustomPresetReducer,
  saveCustomPresetReducer,
  setGlobalPresetReducer,
  setZoneFieldReducer,
  toThemeDelta,
} from './domains/theme/presetReducer'
import type { Profile } from './identityStore'
import { getRendererSettingsStore } from './plugin-runtime/runtimeServices.ts'
import { usePresentationPreferenceStore } from './domains/presentation/presentationPreferenceStore.ts'
import { adaptLegacyThemePreset, createPresetBundle, markUnavailablePresetProviders, normalizePresetBundle, preparePresetBundle, recordPayload, type PresentationPresetPayload, type PresetJsonValue, type RendererPresetPayload } from './domains/theme/presetBundle.ts'
import { createFirstPartyPresetProviderRegistry } from './domains/theme/firstPartyPresetProviders.ts'
import { recordSettingWrites, type SettingWriteSource } from './domains/theme/settingProvenance.ts'

export type { Profile, Session, UserMapping, AgentEntry } from './identityStore'
export type { SessionConfig } from './runtimeStore'

export interface ThemeSettings {
  /** 全局强调色（--accent）：链接/前缀/焦点/选中态统一取色，此前硬编码 #3b82f6 无法主题化 */
  accent: string
  /** 布局骨架显隐（CC 单流模式入口）：tab 条 / 侧栏 / 宠物 */
  showTabBar: boolean; showSidebar: boolean; showPet: boolean
  transparency: number; bgBlur: number; globalFont: string; codeFont: string; globalFontSize: number
  globalBgImage: string; globalBgColor: string; uiScheme: string
  titlebarBg: string; titlebarTextColor: string
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
  /** W2-01（F3-D）：FileSheet 编辑器 8 字段（defs 先行，W2-04 消费） */
  editorFontSize: number; editorLineHeight: number
  editorGutterColor: string; editorGutterBg: string; editorSelection: string; editorActiveLine: string
  editorTabActive: string; editorModifiedMark: string
  toolIndicatorGlow: number; toolIndicatorGlowColor: string
  toolConnectorMode: string; toolConnectorColor: string
  toolConnectorStyle: 'solid' | 'dotted' | 'pulse'; toolConnectorWidth: number; toolConnectorOpacity: number
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; inputSendBg: string; inputBorderColor: string; inputFocusBorder: string; inputRadius: number; inputFocusRingWidth: number; inputFontSize: number; inputMinHeight: number
  inputMode: string; inputVariant: 'cli' | 'composer' | 'compact' | 'command'; inputShowPlaceholder: boolean; inputShowHistoryHint: boolean; inputSubmitButtonMode: 'inline' | 'external' | 'hidden'; cliLineWidth: number; cliLineColor: string; cliTextColor: string; cliPromptColor: string; cliLinePadding: number; cliContentOffsetY: number
  cliHintMode: 'hidden' | 'compact' | 'full'
  statusBg: string; statusBgImage: string; ekgWidth: number; ekgGreen: string; ekgYellow: string; ekgRed: string; pillBg: string; pillText: string; prismOnColor: string
  barTrackColor: string; barFillColor: string; barFillFollow: boolean; barHeight: number  // 柱状图：外壳背景/柱子色/是否跟随用量三段色/高度
  rightBg: string; rightBgImage: string; rightWidth: number
  sidebarTransparency: number; sidebarBlur: number; chatTransparency: number; chatBlur: number; rightTransparency: number; rightBlur: number
  userName: string; userPrefix: string; userColor: string
  toolIndicator: string
  /** Terminal tool glyphs by semantic state; toolIndicator remains legacy fallback. */
  toolIndicatorRun: string; toolIndicatorOk: string; toolIndicatorErr: string
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
  messageUserBg: string; messageAssistantBg: string; messageReasoningBg: string; messageBorderColor: string; messageRadius: number
  messageLayout: 'classic' | 'claude' | 'bubble'
  /** CC 视觉还原：助手消息 ● 圆点 */
  assistantDot: boolean; assistantDotGlyph: string; assistantDotColor: string
  /** 自定义头像/图标路径（非空时替代圆点字形，列宽随图） */
  assistantDotImage: string
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
  setZoneField: (zone: string, partial: Partial<ThemeSettings>, source?: SettingWriteSource) => void
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

  // D-trace：写入溯源——source 由调用方声明（用户编辑/呈现风格/界面模式…），
  // 缺省 user-edit。记录在漏斗出口完成，reducer 保持纯函数。
  setZoneField: (zone, partial, source = 'user-edit') => {
    recordSettingWrites(source, zone, Object.keys(partial))
    set(state => setZoneFieldReducer(state, zone, partial))
  },
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
  setCcHidden: (id, hidden) => set(state => {
    const ccHidden = setCcHiddenState(state.ccHidden, id, hidden)
    const ccHeight = clampCcHeight(state.ccHeight, {
      inputMode: state.inputMode,
      footerLayout: state.footerLayout,
      hintMode: state.cliHintMode,
      visibleStatusWidgets: resolveVisibleStatusWidgetCount({
        hiddenIds: ccHidden,
        inputMode: state.inputMode,
        ccStyle: state.ccStyle,
        submitButtonMode: state.inputSubmitButtonMode,
      }),
      cliOverflowMode: state.cliOverflowMode,
    })
    return {
      ccHidden,
      ccHeight,
      ccBgHeight: Math.max(state.ccBgHeight, ccHeight),
      ...markZoneCustom(state, 'cc'),
    }
  }),
  setCcScale: (id, scale) => set(state => ({
    ccScale: setCcScaleState(state.ccScale, id, scale),
    ...markZoneCustom(state, 'cc'),
  })),

  resetTheme: () => {
    recordSettingWrites('theme-reset', '*', Object.keys(DEFAULTS))
    set(structuredClone(DEFAULTS))
  },

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
    recordSettingWrites('zone-reset', zone, Object.keys(reset))
    return {
      ...reset,
      appliedPreset: { ...state.appliedPreset, [zone]: '' },
      custom: { ...state.custom, [zone]: false },
    }
  }),

  // 六个预设动作：纯计算在 domains/theme/presetReducer.ts，此处只留 set(reducer(state, args)) 薄壳
  applyZonePreset: (zone, presetName, presetTheme) => {
    recordSettingWrites('zone-preset', zone, Object.keys(presetTheme))
    set(state => applyZonePresetReducer(state, zone, presetName, presetTheme))
  },
  setGlobalPreset: (name, theme) => {
    recordSettingWrites('global-preset', '*', Object.keys({ ...DEFAULTS, ...theme }))
    set(() => setGlobalPresetReducer(name, theme))
  },
  saveCustomPreset: (name, id) => {
    const state = get()
    const now = Date.now()
    // id/now 由 shell 注入：reducer 保持确定性（A0 起，预设逻辑可做确定性行为测试）
    const requestedId = typeof id === 'string' && id.trim() ? id.trim() : undefined
    const existing = requestedId
      ? state.customPresets.find(preset => preset.id === requestedId)
      : undefined
    // An explicit id means “overwrite this preset”.  Silently falling back to
    // a new id makes a stale row look like a no-op (and can create duplicates)
    // after persisted data has been migrated or a mode switch rebuilt the UI.
    if (requestedId && !existing) throw new Error('要覆盖的自定义预设不存在')
    const resolvedId = existing?.id
      ?? createCustomPresetId(now, state.customPresets.map(preset => preset.id))
    const cleanName = name.trim()
    if (!cleanName) throw new Error('预设名称不能为空')
    const rendererStore = getRendererSettingsStore()
    const captureProviders = createFirstPartyPresetProviderRegistry({
      captureTheme: () => toPresetJson(toThemeDelta(pickCustomPresetTheme(get()))) as PresetJsonValue,
      applyTheme: () => {}, restoreTheme: () => {},
      capturePresentation: () => ({
        activeProfileId: usePresentationPreferenceStore.getState().activeProfileId,
        rendererSuiteIdByMode: usePresentationPreferenceStore.getState().rendererSuiteIdByMode,
      }),
      applyPresentation: () => {}, restorePresentation: () => {},
      captureRenderer: () => {
        const snapshot = rendererStore.getSnapshot()
        return { values: snapshot.values, unavailable: snapshot.unavailable }
      },
      applyRenderer: () => {}, restoreRenderer: () => {},
    })
    const bundle = createPresetBundle({
      id: resolvedId,
      name: cleanName.slice(0, 40),
      now,
      ...(existing ? { createdAt: existing.createdAt } : {}),
      theme: captureProviders.resolve('builtin.theme')!.capture(),
      renderer: captureProviders.resolve('builtin.renderer-settings')!.capture() as unknown as RendererPresetPayload,
      presentation: captureProviders.resolve('builtin.presentation')!.capture() as unknown as PresentationPresetPayload,
    })
    const { patch, savedId } = saveCustomPresetReducer(state, { id: resolvedId, name, now, bundle })
    set(patch)
    return savedId
  },
  applyCustomPreset: (id) => {
    const preset = get().customPresets.find(item => item.id === id)
    // D-fix：查不到预设必须可见地报告（此前静默 return——持久化引用漂移时
    // 表现为"切换了但什么都没发生"）。
    if (!preset) {
      reportRuntimeError('应用自定义预设', new Error(`自定义预设不存在：${id}`))
      return
    }
    const bundle = normalizePresetBundle(preset.bundle) ?? adaptLegacyThemePreset({
      id: preset.id,
      name: preset.name,
      theme: toPresetJson(preset.theme),
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
    })
    // 主题 payload 单一真值：bundle 里的保存态 delta（免疫 appliedPreset 引用
    // 与列表 id 的漂移），回退用 preset.theme 本体。
    const themePayload = (recordPayload(bundle.contributions['builtin.theme']?.payload)) as Record<string, unknown>
    const beforeTheme = Object.fromEntries([
      ...THEME_SETTING_KEYS.map(key => [key, get()[key]] as const),
      ['appliedPreset', get().appliedPreset],
      ['custom', get().custom],
      ['customPresets', get().customPresets],
    ])
    const beforePresentation = usePresentationPreferenceStore.getState()
    const rendererStore = getRendererSettingsStore()
    const beforeRenderer = rendererStore.getSnapshot()
    const registry = createFirstPartyPresetProviderRegistry({
      captureTheme: () => toPresetJson(toThemeDelta(pickCustomPresetTheme(get()))) as PresetJsonValue,
      applyTheme: () => set(state => {
        const patch = applyCustomPresetReducer(state, id, themePayload)
        // D-fix：reducer 落空（查不到保存态）必须可见，禁止 ?? {} 静默吞掉。
        if (!patch) {
          reportRuntimeError('应用自定义预设', new Error(`自定义预设主题缺失：${id}`))
          return {}
        }
        recordSettingWrites('custom-preset', id, Object.keys(patch))
        return patch
      }),
      restoreTheme: () => set(beforeTheme),
      capturePresentation: () => ({
        activeProfileId: usePresentationPreferenceStore.getState().activeProfileId,
        rendererSuiteIdByMode: usePresentationPreferenceStore.getState().rendererSuiteIdByMode,
      }),
      applyPresentation: payload => {
        if (typeof payload.activeProfileId === 'string') usePresentationPreferenceStore.getState().setActiveProfileId(payload.activeProfileId)
        if (payload.rendererSuiteIdByMode) for (const [mode, suiteId] of Object.entries(payload.rendererSuiteIdByMode)) {
          if (typeof suiteId === 'string') usePresentationPreferenceStore.getState().setRendererSuiteId(mode, suiteId)
        }
      },
      restorePresentation: () => usePresentationPreferenceStore.setState({
        activeProfileId: beforePresentation.activeProfileId,
        rendererSuiteIdByMode: beforePresentation.rendererSuiteIdByMode,
      }),
      captureRenderer: () => ({ values: beforeRenderer.values, unavailable: beforeRenderer.unavailable }),
      applyRenderer: (payload, context) => {
        const current = rendererStore.getSnapshot()
        rendererStore.replaceOverrides(
          context.policy === 'complete' ? (payload.values ?? {}) : (payload.values ?? current.values),
          context.policy === 'complete' ? (payload.unavailable ?? {}) : (payload.unavailable ?? current.unavailable),
        )
      },
      restoreRenderer: () => rendererStore.replaceOverrides(beforeRenderer.values, beforeRenderer.unavailable),
    })
    let prepared
    try {
      prepared = preparePresetBundle(markUnavailablePresetProviders(bundle, registry), registry)
    } catch (error) {
      reportRuntimeError('准备应用预设', error)
      return
    }
    const commitResult = prepared.commit()
    if (commitResult && typeof (commitResult as Promise<void>).then === 'function') {
      void Promise.resolve(commitResult).catch((error: unknown) => reportRuntimeError('应用预设', error))
    }
  },
  removeCustomPreset: (id) => set(state => removeCustomPresetReducer(state, id)),
}),
{ name: 'pylon-theme', version: THEME_SCHEMA_VERSION,
  // G9（1C L1）：主题写盘失败可见（ErrorCenter 指纹去重聚合为一次性告警）
  storage: createJSONStorage(() => ({
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, value)
      } catch (error) {
        // 写盘失败可见（ErrorCenter 指纹去重聚合）；不 throw——内存态继续（1C）
        reportRuntimeError('保存主题配置', error)
      }
    },
    removeItem: key => localStorage.removeItem(key),
  })),
  migrate: (persisted, version) =>
  themeDomainMigrate(persisted, {
    base: DEFAULTS,
    appliedPreset: DEFAULTS.appliedPreset,
    custom: DEFAULTS.custom,
    ccLayout: DEFAULTS.ccLayout,
  }, version),
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
  // FE-AUD-002：旧 pylon-theme 内嵌 profile 一次性迁移到独立 pylon-profiles key
  // （迁移逻辑在 hydrateProfiles：新 key 存在时旧数据不反向覆盖）
  const legacy = state as unknown as { profiles?: Profile[]; activeProfileId?: string }
  const legacyArg =
    legacy?.profiles && Array.isArray(legacy.profiles) && legacy.profiles.length > 0
      ? { profiles: legacy.profiles, activeProfileId: typeof legacy.activeProfileId === 'string' ? legacy.activeProfileId : legacy.profiles[0].id }
      : undefined
  // P31：persist 只报告 legacy payload；跨域 hydration 唯一由 application bootstrap 触发。
  reportLegacyProfilePayload(legacyArg)
}}))

function toPresetJson(value: unknown): import('./domains/theme/presetBundle.ts').PresetJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(item => toPresetJson(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPresetJson(item)]))
  return null
}

// ── 组合出口：按域导入点 ──
export { useIdentityStore } from './identityStore'
export { useRuntimeStore } from './runtimeStore'
export { useWorkspaceStore } from './workspaceStore'
