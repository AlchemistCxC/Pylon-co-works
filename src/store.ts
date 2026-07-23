import { create } from 'zustand'

export interface Profile {
  id: string
  name: string
  avatar?: string
  persona: string
  model: string
}

export interface Session {
  source: string
  periId: string
  name: string
  platform: 'qq-group' | 'qq-dm' | 'terminal'
  msgCount: number
  model: string
  lastActive: string
}

interface AppState {
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  activeSessionId: string | null
  bgImage: string

  setActiveProfile: (id: string) => void
  setActiveSession: (id: string | null) => void
  addProfile: (p: Profile) => void
  setBgImage: (url: string) => void
}

export const useStore = create<AppState>((set) => ({
  profiles: [
    { id: 'riccati', name: 'Riccati', persona: '宫木云的开发助手', model: 'deepseek-v4-flash' },
    { id: 'lm', name: 'l-m', persona: '群聊 AI', model: 'deepseek-v4-flash' },
  ],
  activeProfileId: 'riccati',
  sessions: [
    { source: 'qq:group:6B1A', periId: 'abc', name: '群 811B', platform: 'qq-group', msgCount: 47, model: 'v4-flash', lastActive: '2min ago' },
    { source: 'qq:group:test', periId: 'def', name: '测试群', platform: 'qq-group', msgCount: 3, model: 'v4-flash', lastActive: 'yesterday' },
    { source: 'qq:dm:7E76', periId: 'ghi', name: '7E76', platform: 'qq-dm', msgCount: 12, model: 'v4-flash', lastActive: '1h ago' },
    { source: 'terminal:prism', periId: 'jkl', name: 'prism', platform: 'terminal', msgCount: 8, model: 'v4-flash', lastActive: '3h ago' },
  ],
  activeSessionId: null,
  bgImage: '',

  setActiveProfile: (id) => set({ activeProfileId: id }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  addProfile: (p) => set((s) => ({ profiles: [...s.profiles, p] })),
  setBgImage: (url) => set({ bgImage: url }),
}))
