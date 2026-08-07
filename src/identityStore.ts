import { create } from 'zustand'
import { loadSessions, persistSessions } from './sessionPersistence'
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
  /** 报告 1C L1：最近一次用户配置（Profile/Session）写盘失败的可见状态 */
  lastPersistError: string | null
  setActiveProfile: (id: string) => void
  addProfile: (p: Profile) => string
  removeProfile: (id: string) => void
  /** FE-AUD-002：从 pylon-profiles 恢复；旧 theme 数据仅在无新 key 时一次性迁移落盘 */
  hydrateProfiles: (legacy?: ProfilePersistenceState) => void
  addSession: (name: string) => string
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

/** 报告 1C L1：写盘结果 → 配置未保存状态（失败设提示；成功且旧错则清空） */
function persistFlag(success: boolean, prevError: string | null): string | null {
  if (!success) return '配置未能保存到本地存储'
  return prevError ? null : prevError
}

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
  lastPersistError: null,

  setActiveProfile: (id) => set(state => {
    if (!state.profiles.some(profile => profile.id === id)) return state
    const activeProfileId = id
    // 联动：同步当前 agent 的 sheet 状态并持久化
    useWorkspaceStore.getState().patchSheetAgentState(state.activeAgent, { activeProfileId })
    // FE-AUD-002：activeProfileId 落 pylon-profiles
    const ok = persistProfiles(localStorage, { profiles: state.profiles, activeProfileId })
    return { activeProfileId, lastPersistError: persistFlag(ok, state.lastPersistError) }
  }),
  addProfile: (p) => {
    const state = get()
    const profiles = [...state.profiles.filter(profile => profile.id !== p.id), p]
    const ok = persistProfiles(localStorage, { profiles, activeProfileId: state.activeProfileId })
    set({ profiles, lastPersistError: persistFlag(ok, state.lastPersistError) })
    return p.id
  },
  removeProfile: (id) => set(state => {
    if (!state.profiles.some(profile => profile.id === id) || state.profiles.length <= 1) return state
    const profiles = state.profiles.filter(profile => profile.id !== id)
    const fallbackProfileId = profiles[0].id
    const sessions = state.sessions.map(session => session.profileId === id ? { ...session, profileId: fallbackProfileId } : session)
    const sessionsOk = persistSessions(localStorage, sessions)
    // 联动：sheet 状态里的 activeProfileId 同步
    const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallbackProfileId } : sheetState,
    ]))
    useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
    // FE-AUD-002：删除原子完成 active fallback 并写盘
    const activeProfileId = state.activeProfileId === id ? fallbackProfileId : state.activeProfileId
    const profilesOk = persistProfiles(localStorage, { profiles, activeProfileId })
    return {
      profiles,
      sessions,
      activeProfileId,
      lastPersistError: persistFlag(sessionsOk && profilesOk, state.lastPersistError),
    }
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
      const ok = persistSessions(localStorage, sessions)
      return { sessions, lastPersistError: persistFlag(ok, state.lastPersistError) }
    })
    return id
  },
  removeSession: (id) => set(state => {
    const removed = state.sessions.find(session => session.id === id)
    const sessions = state.sessions.filter(session => session.id !== id)
    const sessionsOk = persistSessions(localStorage, sessions)
    if (!removed) return { sessions, lastPersistError: persistFlag(sessionsOk, state.lastPersistError) }
    // 联动：清 runtime（live stats/modes/config/generating）、sheet 状态与会话级 UI 状态
    useRuntimeStore.getState().clearSessionSource(removed.source)
    clearSessionUiState(id)
    const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeSessionId === id ? { ...sheetState, activeSessionId: undefined } : sheetState,
    ]))
    useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
    return { sessions, lastPersistError: persistFlag(sessionsOk, state.lastPersistError) }
  }),
  updateSession: (id, partial) => set(s => {
    const sessions = s.sessions.map(session => session.id === id ? { ...session, ...partial } : session)
    const ok = persistSessions(localStorage, sessions)
    return { sessions, lastPersistError: persistFlag(ok, s.lastPersistError) }
  }),
  setSessionPeriId: (id, periId) => set(s => {
    const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
    const ok = persistSessions(localStorage, sessions)
    return { sessions, lastPersistError: persistFlag(ok, s.lastPersistError) }
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
    // FE-AUD-005：agents 到达后仅 prune 无效 agent sheet，不重复全量 hydrate
    //（hydrate 已由 bootstrap hydrateDomains 完成；全量替换会覆盖启动期用户操作）
    useWorkspaceStore.getState().pruneAgentSheets(a.map(agent => agent.id))
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
