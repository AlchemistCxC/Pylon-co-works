import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { normalizeProfileState, PROFILE_SCHEMA_VERSION } from './profilePersistence'
import { loadSessions, persistSessions } from './sessionPersistence'
import { DEFAULT_CC_LAYOUT, cloneCcLayout, normalizeCcLayout, setCcHiddenState, setCcScaleState, updateCcPlacementState } from './ccLayoutState'
import type { CcLayoutV3, CcWidgetPlacement } from './ccLayoutState'
import { createCustomPreset, deleteCustomPreset, normalizeCustomPresets, pickCustomPresetTheme, upsertCustomPreset } from './customPresets'
import { normalizeThemeMigrationState } from './themeMigration'
import { markZoneCustom } from './themePresetState'
import { clampCcHeight, resolveVisibleStatusWidgetCount } from './ccHeightState'
import type { CustomPreset } from './customPresets'
import { clearSessionSourceState, updateSessionLiveStats } from './components/chat/sessionRuntime'
import type { SessionLiveStats } from './components/chat/sessionRuntime'
import { createSheetState, sheetReducer } from './workspace-sheets/sheetState'
import type { SheetState } from './workspace-sheets/sheetState'
import { loadSheetState, persistSheetState, type SheetWorkspaceState } from './workspace-sheets/sheetPersistence'
import type { SheetInput, SheetId } from './workspace-sheets/sheetTypes'

export interface Profile { id: string; name: string; avatar?: string; persona: string; model: string }
// 后端配置选项（来自 new_session 返回 & config_option_update 事件）
export interface SessionConfig {
  model?: string           // 当前 model 值
  models?: string[]        // 可选 model 列表
  thinkingEffort?: string
  context1m?: boolean
  raw?: import('./components/chat/acpTypes').ConfigOption[]            // 原始 configOptions（兜底/调试）
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
  ccHidden: string[]
  ccLayout: CcLayoutV3
  ccEditMode: boolean
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
  removeProfile: (id: string) => void
  addSession: (name: string) => void
  removeSession: (id: string) => void
  updateSession: (id: string, partial: Partial<Session>) => void
  replaceSessions: (sessions: Session[]) => void
  setSessionPeriId: (id: string, periId: string) => void
  restoreSessions: () => Session[]
  hydrateSessions: () => void
  getUser: (source: string) => UserMapping | undefined
  setCcEditMode: (enabled: boolean) => void
  setCcHeight: (height: number) => void
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
  sessionLiveStats: Record<string, SessionLiveStats>
  setSessionLiveStats: (source: string, stats: Partial<SessionLiveStats>) => void
  clearSessionRuntime: (source: string) => void
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
  agentStatuses: Record<string, import('./components/settings/agentTypes').AgentStatus>
  setAgentStatus: (id: string, status: import('./components/settings/agentTypes').AgentStatus) => void
  workspaceSheets: SheetState
  sheetAgentStates: Record<string, SheetWorkspaceState>
  hydrateWorkspaceSheets: (agentIds?: readonly string[]) => void
  openSheet: (sheet: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  toggleSheetPin: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  closeOtherSheets: (id: SheetId) => void
  closeRightSheets: (id: SheetId) => void
  reopenSheet: () => SheetId | null
  setSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
}

export const DEFAULTS: ThemeSettings = {
  transparency: 0.85, bgBlur: 16, globalFont: 'system', globalFontSize: 18, globalBgImage: '', globalBgColor: '#e8e8ec', uiScheme: 'light',
  sidebarBg: 'rgba(0,0,0,0.02)', sidebarBgImage: '', sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
  chatBg: '', chatBgImage: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.4, chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
  toolOk: '#4EBA65', toolRun: '#93A5FF', toolErr: '#FF6B80', toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.40)', userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
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
  ccHidden: [], ccLayout: cloneCcLayout(DEFAULT_CC_LAYOUT),
  ccEditMode: false,
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

  setActiveProfile: (id) => set(state => {
    if (!state.profiles.some(profile => profile.id === id)) return state
    const activeProfileId = id
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [state.activeAgent]: { ...state.sheetAgentStates[state.activeAgent], activeProfileId },
    }
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates })
    return { activeProfileId, sheetAgentStates }
  }),
  addProfile: (p) => set(s => ({ profiles: [...s.profiles.filter(x => x.id !== p.id), p] })),
  removeProfile: (id) => set(state => {
    if (!state.profiles.some(profile => profile.id === id) || state.profiles.length <= 1) return state
    const profiles = state.profiles.filter(profile => profile.id !== id)
    const fallbackProfileId = profiles[0].id
    const sessions = state.sessions.map(session => session.profileId === id ? { ...session, profileId: fallbackProfileId } : session)
    persistSessions(localStorage, sessions)
    const sheetAgentStates = Object.fromEntries(Object.entries(state.sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallbackProfileId } : sheetState,
    ]))
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates })
    return { profiles, sessions, activeProfileId: state.activeProfileId === id ? fallbackProfileId : state.activeProfileId, sheetAgentStates }
  }),
  addSession: (name) => {
    const profileId = get().activeProfileId
    const now = Date.now()
    // 同毫秒连点防撞 id：冲突时自增后缀（防御，正常路径 id 与之前一致）
    const baseId = 's' + now.toString(36)
    let id = baseId
    let suffix = 1
    while (get().sessions.some(session => session.id === id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    const s: Session = { id, name, source: 'local:' + name, profileId, createdAt: now, lastActiveAt: now, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
    set(state => {
      const sessions = [...state.sessions, s]
      persistSessions(localStorage, sessions)
      return { sessions }
    })
  },
  removeSession: (id) => set(state => {
    const removed = state.sessions.find(session => session.id === id)
    const sessions = state.sessions.filter(session => session.id !== id)
    persistSessions(localStorage, sessions)
    if (!removed) return { sessions }
    const cleared = clearSessionSourceState({
      source: removed.source,
      sessionLiveStats: state.sessionLiveStats,
      sessionModes: state.sessionModes,
      sessionConfig: state.sessionConfig,
      generatingSources: state.liveGeneratingSources,
    })
    const sheetAgentStates = Object.fromEntries(Object.entries(state.sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeSessionId === id ? { ...sheetState, activeSessionId: undefined } : sheetState,
    ]))
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates })
    return {
      sessions,
      sessionLiveStats: cleared.sessionLiveStats,
      sessionModes: cleared.sessionModes,
      sessionConfig: cleared.sessionConfig,
      liveGeneratingSources: cleared.generatingSources,
      liveGenerating: cleared.generatingSources[cleared.generatingSources.length - 1] || null,
      sheetAgentStates,
    }
  }),
  updateSession: (id, partial) => set(s => {
    const sessions = s.sessions.map(session => session.id === id ? { ...session, ...partial } : session)
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  replaceSessions: (sessions: Session[]) => set(() => {
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

  liveTokensUsed: 0, liveTokensMax: 131072, liveCacheReadTokens: 0, liveMode: 'auto', livePrismOn: true, liveGenerating: null, liveGeneratingSources: [],
  sessionLiveStats: {},
  setSessionLiveStats: (source, stats) => set(state => ({
    sessionLiveStats: updateSessionLiveStats(state.sessionLiveStats, source, stats),
  })),
  clearSessionRuntime: (source) => set(state => {
    const cleared = clearSessionSourceState({
      source,
      sessionLiveStats: state.sessionLiveStats,
      sessionModes: state.sessionModes,
      sessionConfig: state.sessionConfig,
      generatingSources: state.liveGeneratingSources,
    })
    return {
      sessionLiveStats: cleared.sessionLiveStats,
      sessionModes: cleared.sessionModes,
      sessionConfig: cleared.sessionConfig,
      liveGeneratingSources: cleared.generatingSources,
      liveGenerating: cleared.generatingSources[cleared.generatingSources.length - 1] || null,
    }
  }),
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

  agents: [],
  activeAgent: 'peri',
  setAgents: (a) => set(state => {
    const workspaceSheets = loadSheetState(localStorage, a.map(agent => agent.id))
    return { agents: a, workspaceSheets, sheetAgentStates: workspaceSheets.agentStates }
  }),
  setActiveAgent: (id) => set(state => {
    const agentState = state.sheetAgentStates[id]
    return {
      activeAgent: id,
      ...(agentState?.activeProfileId ? { activeProfileId: agentState.activeProfileId } : {}),
    }
  }),
  agentStatuses: {},
  setAgentStatus: (id, status) => set(state => ({ agentStatuses: { ...state.agentStatuses, [id]: status } })),
  workspaceSheets: createSheetState(),
  sheetAgentStates: {},
  hydrateWorkspaceSheets: (agentIds) => set(() => {
    const workspaceSheets = loadSheetState(localStorage, agentIds)
    return { workspaceSheets, sheetAgentStates: workspaceSheets.agentStates }
  }),
  openSheet: (sheet) => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'open', sheet, now: Date.now() })
    set({ workspaceSheets })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return workspaceSheets.activeSheetId
  },
  focusSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'focus', id, now: Date.now() })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return { workspaceSheets }
  }),
  toggleSheetPin: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'togglePin', id, now: Date.now() })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return { workspaceSheets }
  }),
  closeSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'close', id, now: Date.now() })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return { workspaceSheets }
  }),
  closeOtherSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeOthers', id, now: Date.now() })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return { workspaceSheets }
  }),
  closeRightSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeRight', id, now: Date.now() })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return { workspaceSheets }
  }),
  reopenSheet: () => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'reopen', now: Date.now() })
    set({ workspaceSheets })
    persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
    return workspaceSheets.activeSheetId
  },
  setSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates })
    return { sheetAgentStates }
  }),
}),
{ name: 'pylon-theme', version: PROFILE_SCHEMA_VERSION, migrate: persisted => {
  const state = (persisted || {}) as Partial<ThemeState>
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
  const normalized = normalizeProfileState(
    Array.isArray(state.profiles) ? state.profiles : [],
    typeof state.activeProfileId === 'string' ? state.activeProfileId : '',
    DEFAULT_PROFILES,
  )
  return { ...state, ...normalized } as ThemeState
}, partialize: (state) => {
  const { sessions, sessionsHydrated, users, ccEditMode, setActiveProfile, addProfile, removeProfile, addSession, removeSession, updateSession, replaceSessions, setSessionPeriId, restoreSessions, hydrateSessions, getUser, setCcEditMode, setCcHeight, updateCcPlacement, resetCcLayout, setCcHidden, setCcScale, setLiveStats, liveCommands, sessionLiveStats, setSessionLiveStats, clearSessionRuntime, sessionConfig, setSessionConfig, sessionModes, setSessionMode, liveTokensUsed, liveTokensMax, liveCacheReadTokens, liveMode, livePrismOn, liveGenerating, liveGeneratingSources, agents, setAgents, setActiveAgent, agentStatuses, setAgentStatus, workspaceSheets, sheetAgentStates, hydrateWorkspaceSheets, openSheet, focusSheet, closeSheet, closeOtherSheets, closeRightSheets, reopenSheet, setSheetAgentState, applyZonePreset, setZoneField, setGlobalPreset, saveCustomPreset, applyCustomPreset, removeCustomPreset, dirty, ...persisted } = state as ThemeState
  return persisted
}, onRehydrateStorage: () => state => state?.hydrateSessions()}))
