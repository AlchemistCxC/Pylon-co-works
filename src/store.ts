import { create } from 'zustand'

export interface Profile { id: string; name: string; avatar?: string; persona: string; model: string }
export interface Session { source: string; periId: string; name: string; platform: 'qq-group'|'qq-dm'|'terminal'; msgCount: number; model: string; lastActive: string }
export interface UserInfo { openid: string; name: string; avatar?: string }

export interface ThemeSettings {
  // 全局
  transparency: number; bgBlur: number; globalFont: string; globalFontSize: number
  globalBgImage: string
  // 左栏
  sidebarBg: string; sidebarOpacity: number; sidebarBgImage: string
  sidebarWidth: number; sidebarTextColor: string; sidebarNameSize: number; sidebarGroupSize: number
  // 终端
  chatBg: string; chatBgImage: string; chatFont: string; chatFontSize: number; chatLineHeight: number
  chatTextColor: string; chatCodeColor: string; chatCodeBg: string
  // 工具
  toolOk: string; toolRun: string; toolErr: string; toolNameColor: string; toolSummaryColor: string
  // 用户标签
  userTagBg: string; userTagText: string
  // 输入栏
  inputBg: string; inputBgImage: string; inputTextColor: string; inputPlaceholder: string; inputSendBg: string
  inputFocusBorder: string; inputFontSize: number; inputMinHeight: number
  // 状态栏
  statusBg: string; statusBgImage: string; ekgGreen: string; ekgYellow: string; ekgRed: string
  ekgWidth: number; ekgFontSize: number; pillBg: string; pillText: string
  prismOnColor: string
  // 右栏
  rightBg: string; rightBgImage: string; rightWidth: number
  // 动效
  particles: boolean; particleType: string; particleCount: number
}

const defaults: ThemeSettings = {
  transparency: 0.55, bgBlur: 16, globalFont: 'system', globalFontSize: 18, globalBgImage: '',
  sidebarBg: 'rgba(0,0,0,0.02)', sidebarOpacity: 1, sidebarBgImage: '',
  sidebarWidth: 250, sidebarTextColor: 'rgba(0,0,0,0.85)', sidebarNameSize: 14, sidebarGroupSize: 12,
  chatBg: 'transparent', chatBgImage: '', chatFont: 'mono', chatFontSize: 15, chatLineHeight: 1.8,
  chatTextColor: 'rgba(0,0,0,0.85)', chatCodeColor: '#b47814', chatCodeBg: 'rgba(0,0,0,0.03)',
  toolOk: '#1e9646', toolRun: '#3b82f6', toolErr: '#be2828', toolNameColor: 'var(--text)', toolSummaryColor: 'rgba(0,0,0,0.4)',
  userTagBg: 'rgba(0,0,0,0.03)', userTagText: 'rgba(0,0,0,0.65)',
  inputBg: 'rgba(0,0,0,0.03)', inputBgImage: '', inputTextColor: 'rgba(0,0,0,0.85)', inputPlaceholder: 'rgba(0,0,0,0.28)',
  inputSendBg: 'rgba(0,0,0,0.10)', inputFocusBorder: 'rgba(0,0,0,0.22)', inputFontSize: 17, inputMinHeight: 56,
  statusBg: 'rgba(0,0,0,0.02)', statusBgImage: '', ekgGreen: '#1e9646', ekgYellow: '#b47814', ekgRed: '#be2828',
  ekgWidth: 240, ekgFontSize: 16, pillBg: 'rgba(0,0,0,0.03)', pillText: 'rgba(0,0,0,0.4)',
  prismOnColor: '#1e9646',
  rightBg: 'rgba(0,0,0,0.02)', rightBgImage: '', rightWidth: 260,
  particles: false, particleType: 'bubbles', particleCount: 50,
}

interface AppState extends ThemeSettings {
  profiles: Profile[]; activeProfileId: string; sessions: Session[]; activeSessionId: string|null; users: UserInfo[]
  setActiveProfile: (id: string) => void; setActiveSession: (id: string|null) => void
  addProfile: (p: Profile) => void
  setUserName: (openid: string, name: string) => void; setUserAvatar: (openid: string, avatar: string) => void
  getUser: (openid: string) => UserInfo|undefined
  updateTheme: (partial: Partial<ThemeSettings>) => void; resetTheme: () => void
}

function loadTheme(): Partial<ThemeSettings> {
  try { const s = localStorage.getItem('prism-theme'); if (s) return JSON.parse(s) } catch {}
  return {}
}

export const useStore = create<AppState>((set, get) => ({
  ...defaults, ...loadTheme(),
  profiles: [
    { id: 'riccati', name: 'Riccati', persona: '宫木云的开发助手', model: 'deepseek-v4-flash' },
    { id: 'lm', name: 'l-m', persona: '群聊 AI', model: 'deepseek-v4-flash' },
  ],
  activeProfileId: 'riccati',
  sessions: [
    { source: 'qq:group:6B1A', periId: 'abc', name: '群 811B', platform: 'qq-group', msgCount: 47, model: 'v4-flash', lastActive: '2min ago' },
    { source: 'qq:dm:7E76', periId: 'ghi', name: '7E76', platform: 'qq-dm', msgCount: 12, model: 'v4-flash', lastActive: '1h ago' },
    { source: 'terminal:prism', periId: 'jkl', name: 'prism', platform: 'terminal', msgCount: 8, model: 'v4-flash', lastActive: '3h ago' },
  ],
  activeSessionId: null,
  users: [{ openid: 'qq:user:14CE', name: '访客 14CE' }, { openid: 'qq:user:self', name: '我' }],
  setActiveProfile: (id) => set({ activeProfileId: id }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  addProfile: (p) => set(s => ({ profiles: [...s.profiles, p] })),
  setUserName: (openid, name) => set(s => ({ users: s.users.some(u => u.openid === openid) ? s.users.map(u => u.openid === openid ? {...u,name} : u) : [...s.users,{openid,name}] })),
  setUserAvatar: (openid, avatar) => set(s => ({ users: s.users.some(u => u.openid === openid) ? s.users.map(u => u.openid === openid ? {...u,avatar} : u) : [...s.users,{openid,name:openid,avatar}] })),
  getUser: (openid) => get().users.find(u => u.openid === openid),
  updateTheme: (partial) => { set(partial); persist(get()) },
  resetTheme: () => { set(defaults); localStorage.removeItem('prism-theme') },
}))

function persist(state: AppState) {
  const { profiles, sessions, users, setActiveProfile, setActiveSession, addProfile, setUserName, setUserAvatar, getUser, updateTheme, resetTheme, ...theme } = state as any
  localStorage.setItem('prism-theme', JSON.stringify(theme))
}
