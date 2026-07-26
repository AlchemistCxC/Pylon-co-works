import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface Profile { id: string; name: string; avatar?: string; persona: string; model: string }
export interface Session { id: string; periId?: string; name: string; source: string; profileId: string; createdAt: number; lastActiveAt: number; platform: string; workdir: string; sessionPrompt: string; skills: string[]; hooks: string[]; autoName: string }
export interface UserMapping { id: string; name: string; avatar?: string }

export interface ThemeSettings {
  transparency: number; bgBlur: number; globalFont: string; globalFontSize: number
  globalBgImage: string
  sidebarBg: string; sidebarBgImage: string; sidebarWidth: number; sidebarTextColor: string; sidebarNameSize: number; sidebarGroupSize: number
  chatBg: string; chatBgImage: string; chatFont: string; chatFontSize: number; chatLineHeight: number; chatTextColor: string; chatCodeColor: string; chatCodeBg: string
  toolOk: string; toolRun: string; toolErr: string; toolNameColor: string; toolSummaryColor: string; userTagBg: string; userTagText: string
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; inputSendBg: string; inputFocusBorder: string; inputFontSize: number; inputMinHeight: number
  inputMode: string; cliLineWidth: number; cliLineColor: string; cliTextColor: string
  statusBg: string; statusBgImage: string; ekgWidth: number; ekgFontSize: number; ekgGreen: string; ekgYellow: string; ekgRed: string; pillBg: string; pillText: string; prismOnColor: string
  ekgLineWidth: number; ekgAmplitudeMax: number; ekgSpeedBase: number; ekgSpeedMax: number
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
  ccLayout: string[]; ccHidden: string[]; ccSizes: Record<string, number>
  ccPositions: Record<string, {x: number, y: number, w: number, h: number}>
  ccEditMode: boolean
  presets: Record<string, { name: string; colors: Record<string,string>; fonts: Record<string,string|number> }[]>
  activePreset: Record<string, string>
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
  setSessionPeriId: (id: string, periId: string) => void
  restoreSessions: () => Session[]
  getUser: (source: string) => UserMapping | undefined
  updateTheme: (partial: Partial<ThemeSettings>) => void
  liveTokensUsed: number
  liveTokensMax: number
  liveCacheHit: number
  liveMode: string
  livePrismOn: boolean
  liveCommands: { name: string; input_hint?: string; description?: string }[]
  setLiveStats: (stats: Partial<{liveTokensUsed:number,liveTokensMax:number,liveCacheHit:number,liveMode:string,livePrismOn:boolean,liveCommands:any[]}>) => void
  resetTheme: () => void
  agents: { id: string; name: string }[]
  activeAgent: string
  setAgents: (a: { id: string; name: string }[]) => void
  setActiveAgent: (id: string) => void
}

const DEFAULTS: ThemeSettings = {
  transparency: 0.85, bgBlur: 16, globalFont: 'system', globalFontSize: 18, globalBgImage: '',
  sidebarBg: 'rgba(0,0,0,0.02)', sidebarBgImage: '', sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
  chatBg: '', chatBgImage: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.4, chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
  toolOk: '#4EBA65', toolRun: '#93A5FF', toolErr: '#FF6B80', toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.40)', userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
  inputBg: 'rgba(0,0,0,0.02)', inputBgImage: '', inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)', inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputFontSize: 17, inputMinHeight: 56,
  inputMode: 'cli', cliLineWidth: 2, cliLineColor: '', cliTextColor: '',
  statusBg: 'transparent', statusBgImage: '', ekgWidth: 150, ekgFontSize: 16, ekgGreen: '#4EBA65', ekgYellow: '#FFC107', ekgRed: '#FF6B80', pillBg: '#373737', pillText: '#999999', prismOnColor: '#4EBA65',
  ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2.0,
  ekgLeftColor: 'rgba(0,0,0,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.08)', tokenDisplay: 'ekg',
  rightBg: 'rgba(0,0,0,0.02)', rightBgImage: '', rightWidth: 260,
  sidebarTransparency: 1, sidebarBlur: 0, chatTransparency: 1, chatBlur: 0, rightTransparency: 1, rightBlur: 0,
  userName: '', userPrefix: '❯', userColor: '',
  toolIndicator: '●', sparkles: '✳✴✵✶✷✸✹✺✻✼❃❊',
  spinnerColor: '', spinnerSize: 14,
  msgStyle: 'terminal', msgFont: 'mono', msgTextColor: '', msgLineHeight: 1.8,
  ccHeight: 120, ccBgHeight: 120, ccBg: 'transparent', ccBgImage: '',
  ccStyle: 'wave',
  ccVariant: 'terminal',
  ccLayout: ['input', 'context', 'model', 'mode'], ccHidden: [], ccSizes: {},
  ccPositions: { input:{x:3,y:3,w:94,h:55}, context:{x:3,y:65,w:58,h:14}, model:{x:63,y:65,w:24,h:18}, mode:{x:88,y:65,w:10,h:18}, send:{x:86,y:24,w:6,h:12}, attach:{x:93,y:24,w:5,h:12} },
  ccEditMode: false,
  presets: {}, activePreset: {},
}

export const useStore = create<ThemeState>()(persist(
  (set, get) => ({
  ...DEFAULTS,

  profiles: [
    { id: 'riccati', name: 'Riccati', persona: '你是 Riccati，宫木云的全栈开发助手。说话直接，不废话。', model: 'deepseek-v4-flash' },
    { id: 'serina', name: 'Serina', persona: '你是 Serina，TRPG 叙世引擎 GM。', model: 'deepseek-v4-flash' },
  ],
  activeProfileId: 'riccati',
  sessions: (() => {
    try {
      const raw = localStorage.getItem('pylon-sessions') ?? localStorage.getItem('prism-sessions')
      if (raw) {
        const parsed = JSON.parse(raw)
        localStorage.setItem('pylon-sessions', JSON.stringify(parsed))
        localStorage.removeItem('prism-sessions')
        return parsed
      }
    } catch { }
    return []
  })(),
  users: [
    { id: 'qq:user:14CE', name: '14CE' },
    { id: 'qq:user:unknown', name: '访客' },
  ],

  setActiveProfile: (id) => set({ activeProfileId: id }),
  addProfile: (p) => set(s => ({ profiles: [...s.profiles.filter(x => x.id !== p.id), p] })),
  addSession: (name) => {
    const profileId = get().activeProfileId
    const now = Date.now()
    const s: Session = { id: 's' + now.toString(36), name, source: 'local:' + name, profileId, createdAt: now, lastActiveAt: now, platform: 'local', workdir: '', sessionPrompt: '', skills: [], hooks: [], autoName: '' }
    set(state => {
      const sessions = [...state.sessions, s]
      localStorage.setItem('pylon-sessions', JSON.stringify(sessions))
      return { sessions }
    })
  },
  removeSession: (id) => set(s => {
    const sessions = s.sessions.filter(x => x.id !== id)
    localStorage.setItem('pylon-sessions', JSON.stringify(sessions))
    return { sessions }
  }),
  setSessionPeriId: (id, periId) => set(s => {
    const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
    localStorage.setItem('pylon-sessions', JSON.stringify(sessions))
    return { sessions }
  }),
  restoreSessions: () => {
    try {
      const raw = localStorage.getItem('pylon-sessions')
      if (raw) return JSON.parse(raw) as Session[]
    } catch {}
    return []
  },
  getUser: (source) => get().users.find(u => u.id === source),
  updateTheme: (partial) => set(partial),

  liveTokensUsed: 0, liveTokensMax: 131072, liveCacheHit: 0, liveMode: 'auto', livePrismOn: true,
  setLiveStats: (stats) => set(stats),
  liveCommands: [],
  resetTheme: () => set(DEFAULTS),
  presets: {},
  activePreset: {},
  agents: [],
  activeAgent: 'peri',
  setAgents: (a) => set({ agents: a }),
  setActiveAgent: (id) => set({ activeAgent: id }),
}),
{ name: 'pylon-theme', partialize: (state) => {
  const { profiles, sessions, users, setActiveProfile, addProfile, addSession, removeSession, setSessionPeriId, restoreSessions, getUser, updateTheme, setLiveStats, liveCommands, presets, activePreset, agents, setAgents, setActiveAgent, ...theme } = state as any
  return theme
}}))
