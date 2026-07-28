import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { normalizeProfileState, PROFILE_SCHEMA_VERSION } from './profilePersistence'
import { loadSessions, persistSessions } from './sessionPersistence'
import { CC_LAYOUT_SCHEMA_VERSION, DEFAULT_CC_LAYOUT, cloneCcLayout, cloneCcPositions, normalizeCcLayout, normalizeCcPositions, setCcHiddenState, setCcScaleState, updateCcPlacementState, updateCcPositionState } from './ccLayoutState'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState'
import { createCustomPreset, deleteCustomPreset, normalizeCustomPresets, pickCustomPresetTheme, upsertCustomPreset } from './customPresets'
import type { CustomPreset } from './customPresets'

export interface Profile { id: string; name: string; avatar?: string; persona: string; model: string }
// 后端配置选项（来自 new_session 返回 & config_option_update 事件）
export interface SessionConfig {
  model?: string           // 当前 model 值
  models?: string[]        // 可选 model 列表
  thinkingEffort?: string
  context1m?: boolean
  raw?: unknown            // 原始 configOptions（兜底/调试）
}
export interface Session { id: string; periId?: string; name: string; source: string; profileId: string; createdAt: number; lastActiveAt: number; platform: string; workdir: string; sessionPrompt: string; skills: string[]; hooks: string[]; autoName: string }
export interface UserMapping { id: string; name: string; avatar?: string }

export interface ThemeSettings {
  transparency: number; bgBlur: number; globalFont: string; globalFontSize: number
  globalBgImage: string; globalBgColor: string; uiScheme: string
  sidebarBg: string; sidebarBgImage: string; sidebarWidth: number; sidebarTextColor: string; sidebarNameSize: number; sidebarGroupSize: number
  chatBg: string; chatBgImage: string; chatFont: string; chatFontSize: number; chatLineHeight: number; chatTextColor: string; chatCodeColor: string; chatCodeBg: string
  toolOk: string; toolRun: string; toolErr: string; toolNameColor: string; toolSummaryColor: string; userTagBg: string; userTagText: string
  toolIndicatorGlow: number; toolIndicatorGlowColor: string
  toolConnectorMode: string; toolConnectorColor: string
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; inputSendBg: string; inputFocusBorder: string; inputFontSize: number; inputMinHeight: number
  inputMode: string; cliLineWidth: number; cliLineColor: string; cliTextColor: string; cliLinePadding: number
  statusBg: string; statusBgImage: string; ekgWidth: number; ekgFontSize: number; ekgGreen: string; ekgYellow: string; ekgRed: string; pillBg: string; pillText: string; prismOnColor: string
  ekgLineWidth: number; ekgAmplitudeMax: number; ekgSpeedBase: number; ekgSpeedMax: number
  barTrackColor: string; barFillColor: string; barFillFollow: boolean; barHeight: number  // 柱状图：外壳背景/柱子色/是否跟随用量三段色/高度
  ekgLeftColor: string; ekgMovingColor: string; ekgConsumedColor: string; tokenDisplay: string
  rightBg: string; rightBgImage: string; rightWidth: number
  sidebarTransparency: number; sidebarBlur: number; chatTransparency: number; chatBlur: number; rightTransparency: number; rightBlur: number
  userName: string; userPrefix: string; userColor: string
  toolIndicator: string; sparkles: string
  spinnerColor: string; spinnerSize: number
  msgStyle: string; msgFont: string; msgTextColor: string; msgLineHeight: number
  ccHeight: number; ccBgHeight: number; ccBg: string
 ccBgImage: string
  ccStyle: string
  ccVariant: string
  modelVariant: string; modeVariant: string; sendVariant: string; attachVariant: string
  ccHidden: string[]
  ccLayoutVersion: number
  ccLayout: CcLayoutV3
  ccPositions: Record<string, {x: number, y: number, w?: number, h?: number}>
  ccEditMode: boolean
  ccCliCustomized: boolean  // 用户是否在 CLI 模式手动调过 widget 位置/尺寸；true 时不再套用 CLI 默认布局
  ccScale: Record<string, number>  // naturalSize 控件独立缩放% (50-200) key=widget id
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
}

type ThemeState = ThemeSettings & {
  customPresets: CustomPreset[]
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  sessionsHydrated: boolean
  users: UserMapping[]
  setActiveProfile: (id: string) => void
  addProfile: (p: Profile) => void
  addSession: (name: string) => void
  removeSession: (id: string) => void
  updateSession: (id: string, partial: Partial<Session>) => void
  replaceSessions: (sessions: Session[]) => void
  setSessionPeriId: (id: string, periId: string) => void
  restoreSessions: () => Session[]
  hydrateSessions: () => void
  getUser: (source: string) => UserMapping | undefined
  updateTheme: (partial: Partial<ThemeSettings>) => void
  setCcEditMode: (enabled: boolean) => void
  setCcHeight: (height: number) => void
  updateCcPosition: (id: string, partial: Partial<{x: number, y: number, w: number, h: number}>) => void
  updateCcPlacement: (id: string, partial: Partial<CcWidgetPlacement>) => void
  resetCcLayout: () => void
  setCcHidden: (id: string, hidden: boolean) => void
  setCcScale: (id: string, scale: number) => void
  liveTokensUsed: number
  liveTokensMax: number
  liveCacheReadTokens: number
  liveMode: string
  livePrismOn: boolean
  liveGenerating: string | null  // 兼容旧状态：最近开始生成的 session source
  liveGeneratingSources: string[] // 当前所有正在生成的 session source
  sessionModes: Record<string, string>
  setSessionMode: (source: string, mode?: string) => void
  liveCommands: { name: string; input_hint?: string; description?: string }[]
  setLiveStats: (stats: Partial<{liveTokensUsed:number,liveTokensMax:number,liveCacheReadTokens:number,liveMode:string,livePrismOn:boolean,liveGenerating:string|null,liveGeneratingSources:string[],liveCommands:any[]}>) => void
  // 每会话的后端配置选项（model 列表/当前值等），key = session source
  sessionConfig: Record<string, SessionConfig>
  setSessionConfig: (source: string, cfg: Partial<SessionConfig>) => void
  resetTheme: () => void
  applyZonePreset: (zone: string, presetName: string, presetTheme: Partial<ThemeSettings>) => void
  setZoneField: (zone: string, partial: Partial<ThemeSettings>) => void
  setGlobalPreset: (name: string, theme: Partial<ThemeSettings>) => void
  saveCustomPreset: (name: string, id?: string) => string
  applyCustomPreset: (id: string) => void
  removeCustomPreset: (id: string) => void
  agents: { id: string; name: string }[]
  activeAgent: string
  setAgents: (a: { id: string; name: string }[]) => void
  setActiveAgent: (id: string) => void
}

const DEFAULTS: ThemeSettings = {
  transparency: 0.85, bgBlur: 16, globalFont: 'system', globalFontSize: 18, globalBgImage: '', globalBgColor: '#e8e8ec', uiScheme: 'light',
  sidebarBg: 'rgba(0,0,0,0.02)', sidebarBgImage: '', sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
  chatBg: '', chatBgImage: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.4, chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
  toolOk: '#4EBA65', toolRun: '#93A5FF', toolErr: '#FF6B80', toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.40)', userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
  toolIndicatorGlow: 0, toolIndicatorGlowColor: '',
  toolConnectorMode: 'none', toolConnectorColor: 'rgba(0,0,0,0.12)',
  inputBg: 'rgba(0,0,0,0.02)', inputBgImage: '', inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)', inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputFontSize: 17, inputMinHeight: 56,
  inputMode: 'cli', cliLineWidth: 2, cliLineColor: '', cliTextColor: '', cliLinePadding: 6,
  statusBg: 'transparent', statusBgImage: '', ekgWidth: 150, ekgFontSize: 16, ekgGreen: '#4EBA65', ekgYellow: '#FFC107', ekgRed: '#FF6B80', pillBg: '#373737', pillText: '#999999', prismOnColor: '#4EBA65',
  ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2.0,
  barTrackColor: 'rgba(0,0,0,0.18)', barFillColor: '#4EBA65', barFillFollow: true, barHeight: 10,
  ekgLeftColor: 'rgba(0,0,0,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.08)', tokenDisplay: 'ekg',
  rightBg: 'rgba(0,0,0,0.02)', rightBgImage: '', rightWidth: 260,
  sidebarTransparency: 1, sidebarBlur: 0, chatTransparency: 1, chatBlur: 0, rightTransparency: 1, rightBlur: 0,
  userName: '', userPrefix: '❯', userColor: '',
  toolIndicator: '●', sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊',
  spinnerColor: '', spinnerSize: 14,
  msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,
  ccHeight: 150, ccBgHeight: 150, ccBg: 'transparent', ccBgImage: '',
  ccStyle: 'wave',
  ccVariant: 'terminal',
  modelVariant: 'dropdown', modeVariant: 'pill', sendVariant: 'icon', attachVariant: 'icon',
  ccHidden: [], ccLayoutVersion: CC_LAYOUT_SCHEMA_VERSION, ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  ccPositions: { input:{x:0,y:0,w:100,h:52}, ekg:{x:0,y:65}, pct:{x:32,y:69}, tokens:{x:41,y:69}, model:{x:58,y:69}, mode:{x:77,y:69}, send:{x:89,y:69}, attach:{x:95,y:69} },
  ccEditMode: false,
  ccCliCustomized: false,
  ccScale: {},
  activePreset: { global: '', sidebar: '', chat: '', cc: '', right: '' },
  dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
}

const DEFAULT_PROFILES: Profile[] = [
  { id: 'riccati', name: 'Riccati', persona: '你是 Riccati，宫木云的全栈开发助手。说话直接，不废话。', model: 'deepseek-v4-flash' },
  { id: 'serina', name: 'Serina', persona: '你是 Serina，TRPG 叙世引擎 GM。', model: 'deepseek-v4-flash' },
]

export const useStore = create<ThemeState>()(persist(
  (set, get) => ({
  ...DEFAULTS,

  profiles: DEFAULT_PROFILES,
  activeProfileId: DEFAULT_PROFILES[0].id,
  sessions: [],
  sessionsHydrated: false,
  customPresets: [],
  hydrateSessions: () => {
    try {
      set({ sessions: loadSessions(localStorage, get().profiles), sessionsHydrated: true })
    } catch (error) {
      console.error('Session 持久化读取失败', error)
      set({ sessions: [], sessionsHydrated: true })
    }
  },
  users: [
    { id: 'qq:user:14CE', name: '14CE' },
    { id: 'qq:user:unknown', name: '访客' },
  ],

  setActiveProfile: (id) => set(state => ({
    activeProfileId: state.profiles.some(profile => profile.id === id)
      ? id
      : state.activeProfileId,
  })),
  addProfile: (p) => set(s => ({ profiles: [...s.profiles.filter(x => x.id !== p.id), p] })),
  addSession: (name) => {
    const profileId = get().activeProfileId
    const now = Date.now()
    const s: Session = { id: 's' + now.toString(36), name, source: 'local:' + name, profileId, createdAt: now, lastActiveAt: now, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
    set(state => {
      const sessions = [...state.sessions, s]
      persistSessions(localStorage, sessions)
      return { sessions }
    })
  },
  removeSession: (id) => set(s => {
    const sessions = s.sessions.filter(x => x.id !== id)
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  updateSession: (id, partial) => set(s => {
    const sessions = s.sessions.map(session => session.id === id ? { ...session, ...partial } : session)
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  replaceSessions: (sessions) => set(() => {
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  setSessionPeriId: (id, periId) => set(s => {
    const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  restoreSessions: () => {
    try {
      return loadSessions(localStorage, get().profiles)
    } catch (error) {
      console.error('Session 持久化恢复失败', error)
    }
    return []
  },
  getUser: (source) => get().users.find(u => u.id === source),
  updateTheme: (partial) => set(partial),
  setCcEditMode: (enabled) => set({ ccEditMode: enabled }),
  setCcHeight: (height) => set({ ccHeight: Math.max(80, Math.min(400, height)) }),
  updateCcPosition: (id, partial) => set(state => {
    const ccPositions = updateCcPositionState(state.ccPositions, DEFAULTS.ccPositions, id, partial)
    if (ccPositions === state.ccPositions) return state
    return {
      ccPositions,
      ccCliCustomized: true,
    }
  }),
  updateCcPlacement: (id, partial) => set(state => ({
    ccLayout: updateCcPlacementState(state.ccLayout, id, partial),
    ccCliCustomized: true,
  })),
  resetCcLayout: () => set({
    ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
    ccPositions: cloneCcPositions(DEFAULTS.ccPositions),
    ccCliCustomized: false,
  }),
  setCcHidden: (id, hidden) => set(state => ({
    ccHidden: setCcHiddenState(state.ccHidden, id, hidden),
  })),
  setCcScale: (id, scale) => set(state => ({
    ccScale: setCcScaleState(state.ccScale, id, scale),
  })),

  liveTokensUsed: 0, liveTokensMax: 131072, liveCacheReadTokens: 0, liveMode: 'auto', livePrismOn: true, liveGenerating: null, liveGeneratingSources: [],
  sessionModes: {},
  setSessionMode: (source, mode) => set(state => {
    const sessionModes = { ...state.sessionModes }
    if (mode) sessionModes[source] = mode
    else delete sessionModes[source]
    return { sessionModes }
  }),
  setLiveStats: (stats) => set(stats),
  liveCommands: [],
  sessionConfig: {},
  setSessionConfig: (source, cfg) => set(s => ({
    sessionConfig: { ...s.sessionConfig, [source]: { ...s.sessionConfig[source], ...cfg } }
  })),
  resetTheme: () => set(DEFAULTS),

  /**
   * 应用某个 zone 的预设（来自全局预设的子集）
   * 1. 写入该 zone 的所有字段
   * 2. 记录 activePreset[zone] = presetName
   * 3. 清除 dirty[zone]
   * 4. 不影响其他 zone
   */
  applyZonePreset: (zone, presetName, presetTheme) => set(state => ({
    ...presetTheme,
    activePreset: { ...state.activePreset, [zone]: presetName },
    dirty: { ...state.dirty, [zone]: false },
  })),

  /**
   * 用户改动了某个 zone 内的单个字段
   * 1. 写入字段
   * 2. 标记 dirty[zone] = true
   * 3. 如果该 zone 当前指向的是内建预设（activePreset[zone] 非空且匹配预设名），
   *    整局变 custom：activePreset[zone] = 'custom'，dirty[global] = true（但不影响其他 zone 的 preset）
   */
  setZoneField: (zone, partial) => set(state => {
    const currentName = state.activePreset[zone] || ''
    const newName = currentName === '' || currentName === 'custom' ? 'custom' : 'custom'
    return {
      ...partial,
      activePreset: { ...state.activePreset, [zone]: newName },
      dirty: { ...state.dirty, [zone]: true },
    }
  }),

  /**
   * 切换全局预设
   * 1. 把全局预设的全部字段写入 store
   * 2. 把每个 zone 的 activePreset 设为同名的 zone-preset（即该 zone 的子集应用）
   * 3. 所有 zone 的 dirty 清零
   */
  setGlobalPreset: (name, theme) => set(_ => ({
    ...theme,
    ccLayout: normalizeCcLayout(theme.ccLayout, theme.ccPositions),
    ccCliCustomized: false,
    activePreset: { global: name, sidebar: name, chat: name, cc: name, right: name },
    dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
  })),
  saveCustomPreset: (name, id) => {
    const state = get()
    const existing = id ? state.customPresets.find(preset => preset.id === id) : undefined
    const now = Date.now()
    const preset = existing
      ? { ...existing, name: name.trim().slice(0, 40), theme: pickCustomPresetTheme(state as unknown as Record<string, unknown>), updatedAt: now }
      : createCustomPreset(name, pickCustomPresetTheme(state as unknown as Record<string, unknown>), now)
    set({ customPresets: upsertCustomPreset(state.customPresets, preset) })
    return preset.id
  },
  applyCustomPreset: (id) => set(state => {
    const preset = state.customPresets.find(item => item.id === id)
    if (!preset) return state
    return {
      ...preset.theme,
      ccLayout: normalizeCcLayout(preset.theme.ccLayout, preset.theme.ccPositions),
      activePreset: { global: id, sidebar: id, chat: id, cc: id, right: id },
      dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
    }
  }),
  removeCustomPreset: (id) => set(state => ({
    customPresets: deleteCustomPreset(state.customPresets, id),
    activePreset: Object.fromEntries(Object.entries(state.activePreset).map(([zone, value]) => [zone, value === id ? '' : value])),
  })),

  agents: [],
  activeAgent: 'peri',
  setAgents: (a) => set({ agents: a }),
  setActiveAgent: (id) => set({ activeAgent: id }),
}),
{ name: 'pylon-theme', version: PROFILE_SCHEMA_VERSION, migrate: persisted => {
  const state = (persisted || {}) as Partial<ThemeState>
  // ccSizes 是旧版百分比 widget 模型遗留字段；v3 使用 ccLayout 槽位模型。
  delete (state as Record<string, unknown>).ccSizes
  state.ccPositions = normalizeCcPositions(state.ccPositions, DEFAULTS.ccPositions)
  state.ccLayout = normalizeCcLayout(state.ccLayout, state.ccPositions)
  state.ccLayoutVersion = CC_LAYOUT_SCHEMA_VERSION
  state.ccEditMode = false
  state.customPresets = normalizeCustomPresets(state.customPresets)
  const normalized = normalizeProfileState(
    Array.isArray(state.profiles) ? state.profiles : [],
    typeof state.activeProfileId === 'string' ? state.activeProfileId : '',
    DEFAULT_PROFILES,
  )
  return { ...state, ...normalized } as ThemeState
}, partialize: (state) => {
  const { sessions, sessionsHydrated, users, ccEditMode, setActiveProfile, addProfile, addSession, removeSession, updateSession, replaceSessions, setSessionPeriId, restoreSessions, hydrateSessions, getUser, updateTheme, setCcEditMode, setCcHeight, updateCcPosition, updateCcPlacement, resetCcLayout, setCcHidden, setCcScale, setLiveStats, liveCommands, sessionConfig, setSessionConfig, sessionModes, setSessionMode, liveTokensUsed, liveTokensMax, liveCacheReadTokens, liveMode, livePrismOn, liveGenerating, liveGeneratingSources, agents, setAgents, setActiveAgent, applyZonePreset, setZoneField, setGlobalPreset, saveCustomPreset, applyCustomPreset, removeCustomPreset, presets, dirty, ...persisted } = state as any
  return persisted
}, onRehydrateStorage: () => state => state?.hydrateSessions()}))
