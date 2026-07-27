import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { normalizeProfileState, PROFILE_SCHEMA_VERSION } from './profilePersistence'
import { loadSessions, persistSessions } from './sessionPersistence'

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
  ccLayout: string[]; ccHidden: string[]; ccSizes: Record<string, number>
  ccPositions: Record<string, {x: number, y: number, w: number, h: number}>
  ccEditMode: boolean
  ccCliCustomized: boolean  // 用户是否在 CLI 模式手动调过 widget 位置/尺寸；true 时不再套用 CLI 默认布局
  ccScale: Record<string, number>  // naturalSize 控件独立缩放% (50-200) key=widget id
  activePreset: Record<string, string>
  dirty: Record<string, boolean>
}

type ThemeState = ThemeSettings & {
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  users: UserMapping[]
  setActiveProfile: (id: string) => void
  addProfile: (p: Profile) => void
  addSession: (name: string) => void
  removeSession: (id: string) => void
  updateSession: (id: string, partial: Partial<Session>) => void
  replaceSessions: (sessions: Session[]) => void
  setSessionPeriId: (id: string, periId: string) => void
  restoreSessions: () => Session[]
  getUser: (source: string) => UserMapping | undefined
  updateTheme: (partial: Partial<ThemeSettings>) => void
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
  ccLayout: ['input', 'context', 'model', 'mode'], ccHidden: [], ccSizes: {},
  ccPositions: { input:{x:0,y:0,w:100,h:52}, ekg:{x:0,y:65,w:30,h:28}, pct:{x:32,y:69,w:8,h:20}, tokens:{x:41,y:69,w:16,h:20}, model:{x:58,y:69,w:18,h:20}, mode:{x:77,y:69,w:10,h:20}, send:{x:89,y:69,w:5,h:20}, attach:{x:95,y:69,w:4,h:20} },
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
  sessions: (() => {
    try {
      return loadSessions(localStorage, DEFAULT_PROFILES)
    } catch (error) {
      console.error('Session 持久化读取失败', error)
    }
    return []
  })(),
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
    // 预设显式带 ccPositions → 视为已指定布局，不再套 CLI 硬编码默认；否则重置让 CLI 默认生效
    ccCliCustomized: !!(theme as any).ccPositions,
    activePreset: { global: name, sidebar: name, chat: name, cc: name, right: name },
    dirty: { global: false, sidebar: false, chat: false, cc: false, right: false },
  })),

  agents: [],
  activeAgent: 'peri',
  setAgents: (a) => set({ agents: a }),
  setActiveAgent: (id) => set({ activeAgent: id }),
}),
{ name: 'pylon-theme', version: PROFILE_SCHEMA_VERSION, migrate: persisted => {
  const state = (persisted || {}) as Partial<ThemeState>
  const normalized = normalizeProfileState(
    Array.isArray(state.profiles) ? state.profiles : [],
    typeof state.activeProfileId === 'string' ? state.activeProfileId : '',
    DEFAULT_PROFILES,
  )
  return { ...state, ...normalized } as ThemeState
}, partialize: (state) => {
  const { sessions, users, setActiveProfile, addProfile, addSession, removeSession, updateSession, replaceSessions, setSessionPeriId, restoreSessions, getUser, updateTheme, setLiveStats, liveCommands, sessionConfig, setSessionConfig, sessionModes, setSessionMode, liveTokensUsed, liveTokensMax, liveCacheReadTokens, liveMode, livePrismOn, liveGenerating, liveGeneratingSources, agents, setAgents, setActiveAgent, applyZonePreset, setZoneField, setGlobalPreset, presets, dirty, ...persisted } = state as any
  return persisted
}}))
