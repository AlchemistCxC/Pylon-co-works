import { create } from 'zustand'

export interface Profile { id: string; name: string; avatar?: string; persona: string; model: string }
export interface Session { id: string; periId?: string; name: string; source: string; profileId: string }
export interface UserMapping { id: string; name: string; avatar?: string }

export interface ThemeSettings {
  transparency: number; bgBlur: number; globalFont: string; globalFontSize: number
  globalBgImage: string
  sidebarBg: string; sidebarBgImage: string; sidebarWidth: number; sidebarTextColor: string; sidebarNameSize: number; sidebarGroupSize: number
  chatBg: string; chatBgImage: string; chatFont: string; chatFontSize: number; chatLineHeight: number; chatTextColor: string; chatCodeColor: string; chatCodeBg: string
  toolOk: string; toolRun: string; toolErr: string; toolNameColor: string; toolSummaryColor: string; userTagBg: string; userTagText: string
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; inputSendBg: string; inputFocusBorder: string; inputFontSize: number; inputMinHeight: number
  statusBg: string; statusBgImage: string; ekgWidth: number; ekgFontSize: number; ekgGreen: string; ekgYellow: string; ekgRed: string; pillBg: string; pillText: string; prismOnColor: string
  ekgLineWidth: number; ekgAmplitudeMax: number; ekgSpeedBase: number; ekgSpeedMax: number
  ekgLeftColor: string; ekgMovingColor: string; ekgConsumedColor: string; tokenDisplay: string
  rightBg: string; rightBgImage: string; rightWidth: number
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
  setLiveStats: (stats: Partial<{liveTokensUsed:number,liveTokensMax:number,liveCacheHit:number,liveMode:string,livePrismOn:boolean,liveCommands:any[]}>) => void
  resetTheme: () => void
}

const DEFAULTS: ThemeSettings = {
  transparency: 0.55, bgBlur: 16, globalFont: 'system', globalFontSize: 18, globalBgImage: '',
  sidebarBg: 'rgba(0,0,0,0.02)', sidebarBgImage: '', sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
  chatBg: '', chatBgImage: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.8, chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
  toolOk: '#1e9646', toolRun: '#3b82f6', toolErr: '#be2828', toolNameColor: 'rgba(0,0,0,0.85)', toolSummaryColor: 'rgba(0,0,0,0.40)', userTagBg: 'rgba(168,85,247,0.08)', userTagText: '#a855f7',
  inputBg: 'rgba(0,0,0,0.02)', inputBgImage: '', inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)', inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputFontSize: 17, inputMinHeight: 56,
  statusBg: 'rgba(0,0,0,0.02)', statusBgImage: '', ekgWidth: 240, ekgFontSize: 16, ekgGreen: '#1e9646', ekgYellow: '#b47814', ekgRed: '#be2828', pillBg: 'rgba(0,0,0,0.04)', pillText: 'rgba(0,0,0,0.65)', prismOnColor: '#1e9646',
  ekgLineWidth: 3, ekgAmplitudeMax: 10, ekgSpeedBase: 0.5, ekgSpeedMax: 2.0,
  ekgLeftColor: 'rgba(0,0,0,0.35)', ekgMovingColor: '', ekgConsumedColor: 'rgba(0,0,0,0.08)', tokenDisplay: 'ekg',
  rightBg: 'rgba(0,0,0,0.02)', rightBgImage: '', rightWidth: 260,
}

export const useStore = create<ThemeState>((set, get) => ({
  ...DEFAULTS,

  profiles: [
    { id: 'riccati', name: 'Riccati', persona: '你是 Riccati，宫木云的全栈开发助手。说话直接，不废话。', model: 'deepseek-v4-flash' },
    { id: 'serina', name: 'Serina', persona: '你是 Serina，TRPG 叙世引擎 GM。', model: 'deepseek-v4-flash' },
  ],
  activeProfileId: 'riccati',
  sessions: (() => { try { const r = localStorage.getItem('prism-sessions'); return r ? JSON.parse(r) : []; } catch { return []; } })(),
  users: [
    { id: 'qq:user:14CE', name: '14CE' },
    { id: 'qq:user:unknown', name: '访客' },
  ],

  setActiveProfile: (id) => set({ activeProfileId: id }),
  addProfile: (p) => set(s => ({ profiles: [...s.profiles.filter(x => x.id !== p.id), p] })),
  addSession: (name) => {
    const profileId = get().activeProfileId
    const s = { id: 's' + Date.now().toString(36), name, source: 'local:' + name, profileId }
    set(state => {
      const sessions = [...state.sessions, s]
      localStorage.setItem('prism-sessions', JSON.stringify(sessions))
      return { sessions }
    })
  },
  removeSession: (id) => set(s => {
    const sessions = s.sessions.filter(x => x.id !== id)
    localStorage.setItem('prism-sessions', JSON.stringify(sessions))
    return { sessions }
  }),
  setSessionPeriId: (id, periId) => set(s => {
    const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
    localStorage.setItem('prism-sessions', JSON.stringify(sessions))
    return { sessions }
  }),
  restoreSessions: () => {
    try {
      const raw = localStorage.getItem('prism-sessions')
      if (raw) return JSON.parse(raw) as Session[]
    } catch {}
    return []
  },
  getUser: (source) => get().users.find(u => u.id === source),
  updateTheme: (partial) => set(partial),

  liveTokensUsed: 0, liveTokensMax: 131072, liveCacheHit: 0, liveMode: 'auto', livePrismOn: true,
  setLiveStats: (stats) => set(stats),
  resetTheme: () => set(DEFAULTS),
}))
