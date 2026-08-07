import { create } from 'zustand'
import { loadSessions, persistSessions } from './sessionPersistence'
import { loadSheetStateV2 } from './workspace-sheets/sheetPersistence'
import { loadProfiles, persistProfiles, PROFILE_STORAGE_KEY, type PersistedProfile, type ProfilePersistenceState } from './profilePersistence'
import { useWorkspaceStore } from './workspaceStore'
import { useRuntimeStore } from './runtimeStore'
import { clearSessionUiState } from './components/chat/sessionUiState'

/**
 * identityStore — 身份与会话状态域（阶段 1：store 按域拆分）。
 *
 * 承载：profiles / activeProfileId / sessions / users / agents / activeAgent。
 * 不持久化（sessions 由 sessionPersistence 独立管理）。
 * 跨域联动（profile/session/agent 变化同步 workspace 与 runtime）在本 store 组合 action 内
 * 经 getState 调用其他域 store。
 */

export interface Profile {
  id: string
  name: string
  avatar?: string
  persona: string
  model: string
}

export interface Session {
  id: string
  periId?: string
  name: string
  source: string
  profileId: string
  createdAt: number
  lastActiveAt: number
  platform: string
  workdir: string
  sessionPrompt: string
  skills: string[]
  hooks: string[]
  autoName: string
}

export interface UserMapping {
  id: string
  name: string
  avatar?: string
}

export interface AgentEntry {
  id: string
  name: string
}

interface IdentityStoreState {
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  sessionsHydrated: boolean
  users: UserMapping[]
  agents: AgentEntry[]
  activeAgent: string
  setActiveProfile: (id: string) => void
  addProfile: (p: Profile) => string
  removeProfile: (id: string) => void
  /** FE-AUD-002：从 pylon-profiles 恢复；旧 theme 数据仅在无新 key 时一次性迁移落盘 */
  hydrateProfiles: (legacy?: ProfilePersistenceState) => void
  addSession: (name: string) => void
  removeSession: (id: string) => void
  updateSession: (id: string, partial: Partial<Session>) => void
  setSessionPeriId: (id: string, periId: string) => void
  hydrateSessions: () => void
  getUser: (source: string) => UserMapping | undefined
  setAgents: (a: AgentEntry[]) => void
  setActiveAgent: (id: string) => void
}

const DEFAULT_PROFILES: Profile[] = [
  { id: 'riccati', name: 'Riccati', persona: '你是 Riccati，宫木云的全栈开发助手。说话直接，不废话。', model: 'deepseek-v4-flash' },
  { id: 'serina', name: 'Serina', persona: '你是 Serina，TRPG 叙世引擎 GM。', model: 'deepseek-v4-flash' },
]

export const useIdentityStore = create<IdentityStoreState>()((set, get) => ({
  profiles: DEFAULT_PROFILES,
  activeProfileId: DEFAULT_PROFILES[0].id,
  sessions: [],
  sessionsHydrated: false,
  users: [
    { id: 'qq:user:14CE', name: '14CE' },
    { id: 'qq:user:unknown', name: '访客' },
  ],
  agents: [],
  activeAgent: 'peri',

  setActiveProfile: (id) => set(state => {
    if (!state.profiles.some(profile => profile.id === id)) return state
    const activeProfileId = id
    // 联动：同步当前 agent 的 sheet 状态并持久化
    useWorkspaceStore.getState().patchSheetAgentState(state.activeAgent, { activeProfileId })
    // FE-AUD-002：activeProfileId 落 pylon-profiles
    persistProfiles(localStorage, { profiles: state.profiles, activeProfileId })
    return { activeProfileId }
  }),
  addProfile: (p) => {
    const profiles = [...get().profiles.filter(profile => profile.id !== p.id), p]
    persistProfiles(localStorage, { profiles, activeProfileId: get().activeProfileId })
    set({ profiles })
    return p.id
  },
  removeProfile: (id) => set(state => {
    if (!state.profiles.some(profile => profile.id === id) || state.profiles.length <= 1) return state
    const profiles = state.profiles.filter(profile => profile.id !== id)
    const fallbackProfileId = profiles[0].id
    const sessions = state.sessions.map(session => session.profileId === id ? { ...session, profileId: fallbackProfileId } : session)
    persistSessions(localStorage, sessions)
    // 联动：sheet 状态里的 activeProfileId 同步
    const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallbackProfileId } : sheetState,
    ]))
    useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
    // FE-AUD-002：删除原子完成 active fallback 并写盘
    const activeProfileId = state.activeProfileId === id ? fallbackProfileId : state.activeProfileId
    persistProfiles(localStorage, { profiles, activeProfileId })
    return { profiles, sessions, activeProfileId }
  }),
  hydrateProfiles: (legacy) => set(() => {
    // 1B.5：新 key 存在时以存储为准，旧数据不得反向覆盖
    const loaded = loadProfiles(localStorage, DEFAULT_PROFILES)
    if (localStorage.getItem(PROFILE_STORAGE_KEY) !== null) {
      return { profiles: loaded.profiles, activeProfileId: loaded.activeProfileId }
    }
    // 迁移：旧 theme 内嵌 profile 一次性落新 key（无 legacy 时用默认值）
    const source = legacy && legacy.profiles.length > 0
      ? { profiles: legacy.profiles as PersistedProfile[], activeProfileId: legacy.activeProfileId }
      : { profiles: DEFAULT_PROFILES, activeProfileId: DEFAULT_PROFILES[0].id }
    persistProfiles(localStorage, source)
    return { profiles: source.profiles, activeProfileId: source.activeProfileId }
  }),
  addSession: (name) => {
    const profileId = get().activeProfileId
    const now = Date.now()
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
    // 联动：清 runtime（live stats/modes/config/generating）、sheet 状态与会话级 UI 状态
    useRuntimeStore.getState().clearSessionSource(removed.source)
    clearSessionUiState(id)
    const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeSessionId === id ? { ...sheetState, activeSessionId: undefined } : sheetState,
    ]))
    useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
    return { sessions }
  }),
  updateSession: (id, partial) => set(s => {
    const sessions = s.sessions.map(session => session.id === id ? { ...session, ...partial } : session)
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  setSessionPeriId: (id, periId) => set(s => {
    const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
    persistSessions(localStorage, sessions)
    return { sessions }
  }),
  hydrateSessions: () => {
    try {
      set({ sessions: loadSessions(localStorage, get().profiles), sessionsHydrated: true })
    } catch (error) {
      console.error('Session 持久化读取失败', error)
      set({ sessions: [], sessionsHydrated: true })
    }
  },
  getUser: (source) => get().users.find(u => u.id === source),
  setAgents: (a) => set(() => {
    // 联动：Agent 列表变化时按新列表重载 sheets（W1-01 v2：layout 由 workspaceStore 持有）
    const result = loadSheetStateV2(localStorage, a.map(agent => agent.id))
    useWorkspaceStore.getState().replaceSheets(result.state, result.state.agentStates)
    return { agents: a }
  }),
  setActiveAgent: (id) => set(() => {
    const agentState = useWorkspaceStore.getState().sheetAgentStates[id]
    return {
      activeAgent: id,
      ...(agentState?.activeProfileId ? { activeProfileId: agentState.activeProfileId } : {}),
    }
  }),
}))
