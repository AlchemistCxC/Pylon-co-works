import { create } from 'zustand'
import { CORE_COMMAND_SET_PLUGIN_ID } from './contracts/agentCommandSet.ts'
import { loadSessions, normalizeSessions, persistSessionsWithUnresolved, SESSION_SCHEMA_VERSION, type LegacySession, type OwnerHints } from './sessionPersistence'
import { loadProfiles, parseProfileEnvelope, persistProfiles, PROFILE_ENVELOPE_VERSION, PROFILE_STORAGE_KEY, type PersistedProfile, type ProfilePersistenceState } from './profilePersistence'
import { useWorkspaceStore } from './workspaceStore'
import { useRuntimeStore } from './runtimeStore'
import { clearSessionUiState } from './components/chat/sessionUiState'
import { reportRuntimeError } from './runtimeError'
import { selectUserDataRepository, type UserDataRepository } from './userDataRepository'
import { resolveUnresolvedSessionTransaction } from './app/bootstrap/resolveUnresolvedSessionTransaction'
import { IS_TAURI, isBrowserMockRuntime } from './infrastructure/tauri/env'
import {
  mergePluginNamespace,
  type PluginDataPlane,
  type PluginNamespaceRoot,
} from './domains/pluginData/pluginNamespace.ts'
import { registerPluginSessionDataPort } from './plugin-runtime/sessionData/sessionDataPort.ts'
import { getSessionCreationRegistry } from './plugin-runtime/runtimeServices.ts'
import { compileSessionCreationSnapshot } from './plugin-runtime/session-creation/compileSessionCreationSnapshot.ts'
import type { SessionCreationSnapshot } from './plugin-runtime/session-creation/sessionCreationTypes.ts'
import type { AgentEntry } from './domains/agent/agentEntry.ts'

export type { AgentEntry } from './domains/agent/agentEntry.ts'

const hasBackend = () => IS_TAURI && !isBrowserMockRuntime()

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
  /** ISSUE-01：会话归属 Agent（owner schema）。v2 起必需，create/update/delete 保持归属不变 */
  agentId: string
  periId?: string
  name: string
  source: string
  profileId: string
  createdAt: number
  lastActiveAt: number
  /** Timestamp of the most recent assistant reply (display semantics). */
  lastReplyAt?: number
  /** 归档时间；归档会话不显示在 Agentsheet 活动列表。 */
  archivedAt?: number
  platform: string
  workdir: string
  /** CWD-03：Workspace 实体绑定（方案 C）。有值 = 绑定 Workspace（root 单一来源，
   * workdir 保持同步快照）；undefined = legacy 未绑定。workspaceId 进入 new/load wire */
  workspaceId?: string
  sessionPrompt: string
  /** @deprecated legacy/reserved：后端会话级配置链路未确定（FE-AUD-023），只读说明不编辑不发送 */
  skills: string[]
  /** @deprecated legacy/reserved：同 skills，契约确定前不提供编辑 */
  hooks: string[]
  /** M2：启用的 agent.commandSet 插件 id；缺省 = 全部已激活命令集插件（旧数据兼容）。 */
  commandSetPlugins?: string[]
  autoName: string
  /** 插件只能经 scope-bound API 写自己的 key。 */
  metadata?: PluginNamespaceRoot
  context?: PluginNamespaceRoot
  /** 插件会话创建贡献在本地 Session 建立时编译出的不可变、可持久化快照。 */
  creationSnapshot?: SessionCreationSnapshot
}

export interface Turn {
  id: string
  sessionId: string
  startedAt: number
  endedAt?: number
  metadata: PluginNamespaceRoot
  context: PluginNamespaceRoot
}

export interface UserMapping {
  id: string
  name: string
  avatar?: string
}

/**
 * ISSUE-01：会话水合结果（不含 sessions——sessions 落在 state.sessions）。
 * 非 ready 时绝不把 unresolved 静默归给 activeAgent；由恢复选择流程显式定 owner。
 */
export type SessionHydrationState =
  | { kind: 'ready' }
  | { kind: 'needs-owner-resolution'; unresolved: LegacySession[] }
  | { kind: 'corrupt'; message: string }

export type IdentityBackendStatus = 'unknown' | 'ready' | 'degraded-readonly'

export interface IdentityPersistenceState {
  profiles: IdentityBackendStatus
  sessions: IdentityBackendStatus
}

export const IDENTITY_CACHE_META_KEY = 'pylon-identity-cache-meta:v1'

interface IdentityCacheMeta {
  version: 1
  profiles: { revision: number; state: 'clean' | 'pending' | 'stale' }
  sessions: { revision: number; state: 'clean' | 'pending' | 'stale' }
}

function updateIdentityCacheMeta(
  domain: keyof IdentityPersistenceState,
  state: IdentityCacheMeta['profiles']['state'],
  revision?: number,
): void {
  try {
    const parsed = JSON.parse(localStorage.getItem(IDENTITY_CACHE_META_KEY) ?? 'null') as Partial<IdentityCacheMeta> | null
    const fallback = { revision: 0, state: 'stale' as const }
    const current: IdentityCacheMeta = {
      version: 1,
      profiles: parsed?.profiles?.revision !== undefined ? parsed.profiles as IdentityCacheMeta['profiles'] : fallback,
      sessions: parsed?.sessions?.revision !== undefined ? parsed.sessions as IdentityCacheMeta['sessions'] : fallback,
    }
    current[domain] = { revision: revision ?? current[domain].revision, state }
    localStorage.setItem(IDENTITY_CACHE_META_KEY, JSON.stringify(current))
  } catch {
    // Cache metadata 失败不能改变 SQLite authority 或让业务 mutation 抛错。
  }
}

function canMutateIdentityDomain(
  persistence: IdentityPersistenceState,
  ...domains: Array<keyof IdentityPersistenceState>
): boolean {
  return !hasBackend() || domains.every(domain => persistence[domain] !== 'degraded-readonly')
}

/**
 * CR-001：mutation 持久化必须保留 unresolved 现场——state.sessions 只含已解析子集，
 * 直接 persistSessions 会用子集覆盖存储、永久丢失未决 legacy 会话。写盘前把
 * sessionHydration.unresolved（不补 agentId）并入 envelope，下次 load 重新推断。
 */
function persistMergingUnresolved(sessions: Session[], turns: Turn[], hydration: SessionHydrationState | null): boolean {
  const unresolved = hydration?.kind === 'needs-owner-resolution' ? hydration.unresolved : []
  return persistSessionsWithUnresolved(localStorage, sessions, unresolved, turns)
}

interface IdentityStoreState {
  profiles: Profile[]
  activeProfileId: string
  sessions: Session[]
  turns: Turn[]
  sessionsHydrated: boolean
  /** ISSUE-01：最近一次 hydrate 的结果状态；ready 之外供 UI 呈现恢复选择/损坏提示 */
  sessionHydration: SessionHydrationState | null
  users: UserMapping[]
  agents: AgentEntry[]
  activeAgent: string
  /** 报告 1C L1：最近一次用户配置（Profile/Session）写盘失败的可见状态 */
  lastPersistError: string | null
  /** Tauri：SQLite authority 可用性；degraded 时 localStorage 仅供只读展示。 */
  identityPersistence: IdentityPersistenceState
  setActiveProfile: (id: string) => void
  addProfile: (p: Profile) => string
  /** I14-W7：删除 Profile（Tauri 后端原子事务 + 重读；browser 本地 fallback）。可为 async。 */
  removeProfile: (id: string) => void | Promise<void>
  /** FE-AUD-002：从 pylon-profiles 恢复；旧 theme 数据仅在无新 key 时一次性迁移落盘。
   * I14-W6：可为 async——Tauri 模式后端读回（调用方可 await 完成）。 */
  hydrateProfiles: (legacy?: ProfilePersistenceState) => void | Promise<void>
  /** I14-W6 CR-01：强制本地路径（导入/浏览器场景）——读取 localStorage 不经后端 */
  hydrateProfilesLocal: (legacy?: ProfilePersistenceState) => void
  /** I14-W6 CR-01：导入等"本地已写入"场景——本地读回 + 写穿后端（Tauri 权威源同步） */
  hydrateFromLocal: (legacy?: ProfilePersistenceState) => void | Promise<void>
  addSession: (name: string, agentId?: string, cwd?: { workdir?: string; workspaceId?: string; skills?: string[]; hooks?: string[]; mcpServerIds?: string[]; hookPluginIds?: string[] }) => string
  /** D5：从恢复失败的会话显式创建独立本地分叉；原 Session/remote binding 保持不变。 */
  forkSession: (id: string) => string
  removeSession: (id: string) => void
  updateSession: (id: string, partial: Partial<Session>) => void
  updateSessionPluginData: (id: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>) => boolean
  ensureTurn: (turn: Pick<Turn, 'id' | 'sessionId' | 'startedAt'> & Partial<Pick<Turn, 'endedAt'>>) => boolean
  updateTurnPluginData: (id: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>) => boolean
  setSessionPeriId: (id: string, periId: string) => void
  resolveSessionOwner: (sessionId: string, agentId: string) => Promise<boolean>
  hydrateSessions: () => void | Promise<void>
  /** I14-W6 CR-01：强制本地路径（导入/浏览器场景）——读取 localStorage 不经后端 */
  hydrateSessionsLocal: () => void
  getUser: (source: string) => UserMapping | undefined
  setAgents: (a: AgentEntry[]) => void
  setActiveAgent: (id: string) => void
}

const DEFAULT_PROFILES: Profile[] = [
  { id: 'default', name: 'Default', persona: '', model: '' },
  { id: 'local', name: 'Local', persona: '', model: '' },
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
  turns: [],
  sessionsHydrated: false,
  sessionHydration: null,
  users: [
    { id: 'qq:user:unknown', name: '访客' },
  ],
  agents: [],
  activeAgent: 'peri',
  lastPersistError: null,
  identityPersistence: { profiles: 'unknown', sessions: 'unknown' },

  setActiveProfile: (id) => set(state => {
    if (!canMutateIdentityDomain(state.identityPersistence, 'profiles')) return state
    if (!state.profiles.some(profile => profile.id === id)) return state
    const activeProfileId = id
    // 联动：同步当前 agent 的 sheet 状态并持久化
    useWorkspaceStore.getState().patchSheetAgentState(state.activeAgent, { activeProfileId })
    // FE-AUD-002：activeProfileId 落 pylon-profiles
    const ok = persistProfiles(localStorage, { profiles: state.profiles, activeProfileId })
    identityMutationSeq += 1
    queueMicrotask(syncIdentityToBackend)
    return { activeProfileId, lastPersistError: persistFlag(ok, state.lastPersistError) }
  }),
  addProfile: (p) => {
    const state = get()
    if (!canMutateIdentityDomain(state.identityPersistence, 'profiles')) return ''
    const profiles = [...state.profiles.filter(profile => profile.id !== p.id), p]
    const ok = persistProfiles(localStorage, { profiles, activeProfileId: state.activeProfileId })
    set({ profiles, lastPersistError: persistFlag(ok, state.lastPersistError) })
    identityMutationSeq += 1
    queueMicrotask(syncIdentityToBackend)
    return p.id
  },
  removeProfile: async (id) => {
    if (!canMutateIdentityDomain(get().identityPersistence, 'profiles', 'sessions')) return
    // I14-W7 CR-03：两路径统一 guard——最后 profile 不可删（browser 与 Tauri 语义一致，
    // 避免空库 + activeProfileId="" + sessions ghost 引用）
    if (get().profiles.length <= 1) return
    // I14-W7：Tauri 模式删除走后端原子事务（fallback/重绑定/activeProfileId 单事务，
    // 见 user_data.rs delete_profile），成功后从后端重读权威状态（内存/localStorage/
    // adapter baseline 同步）；失败可见（reportRuntimeError），状态不变。
    if (userDataRepository) {
      try {
        await userDataRepository.deleteProfile(id)
      } catch (error) {
        reportRuntimeError('删除 Profile（后端事务）', error)
        return
      }
      identityMutationSeq += 1
      const [profilesEnv, sessionsEnv] = await Promise.all([
        userDataRepository.load('profiles'),
        userDataRepository.load('sessions'),
      ])
      if (profilesEnv) {
        const parsed = parseProfileEnvelope(JSON.stringify(profilesEnv.payload), DEFAULT_PROFILES)
        persistProfiles(localStorage, { profiles: parsed.profiles, activeProfileId: parsed.activeProfileId })
        set({ profiles: parsed.profiles, activeProfileId: parsed.activeProfileId, lastPersistError: null })
        // I14-W7 CR-03：sheet 状态里的 activeProfileId 同步（引用已删 profile → fallback，
        // 与 browser 路径语义一致）
        const fallback = parsed.activeProfileId
        const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
          agentId,
          sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallback } : sheetState,
        ]))
        useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
      }
      if (sessionsEnv) {
        const hints: OwnerHints = {
          activeSessionByAgent: Object.fromEntries(
            Object.entries(useWorkspaceStore.getState().sheetAgentStates)
              .map(([agentId, sheetState]) => [agentId, sheetState.activeSessionId]),
          ),
        }
        const result = normalizeSessions(sessionsEnv.payload, get().profiles, hints)
        const sessionHydration: SessionHydrationState = result.kind === 'ready'
          ? { kind: 'ready' }
          : result.kind === 'corrupt'
            ? { kind: 'corrupt', message: result.message }
            : { kind: 'needs-owner-resolution', unresolved: result.unresolved }
        const turns = result.kind === 'corrupt' ? [] : result.turns ?? []
        persistMergingUnresolved(result.kind === 'corrupt' ? [] : result.sessions, turns, sessionHydration)
        set({ sessions: result.kind === 'corrupt' ? [] : result.sessions, turns, sessionHydration, sessionsHydrated: true })
      }
      return
    }
    // browser 模式本地路径；Tauri degraded-readonly 已在上方 guard 阻断。
    if (get().sessionHydration?.kind === 'corrupt') return
    set(state => {
      if (!state.profiles.some(profile => profile.id === id) || state.profiles.length <= 1) return state
      const profiles = state.profiles.filter(profile => profile.id !== id)
      const fallbackProfileId = profiles[0].id
      const sessions = state.sessions.map(session => session.profileId === id ? { ...session, profileId: fallbackProfileId } : session)
      const sessionsOk = persistMergingUnresolved(sessions, state.turns, state.sessionHydration)
      // 联动：sheet 状态里的 activeProfileId 同步
      const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
        agentId,
        sheetState.activeProfileId === id ? { ...sheetState, activeProfileId: fallbackProfileId } : sheetState,
      ]))
      useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
      // FE-AUD-002：删除原子完成 active fallback 并写盘
      const activeProfileId = state.activeProfileId === id ? fallbackProfileId : state.activeProfileId
      const profilesOk = persistProfiles(localStorage, { profiles, activeProfileId })
      identityMutationSeq += 1
      queueMicrotask(syncIdentityToBackend)
      return {
        profiles,
        sessions,
        activeProfileId,
        lastPersistError: persistFlag(sessionsOk && profilesOk, state.lastPersistError),
      }
    })
  },
  hydrateProfiles: async (legacy) => {
    // I14-W6：Tauri 模式以后端 versioned store 读回为权威源；后端明确无行时才从
    // 本地缓存做 CAS=0 冷启动导入，读取失败则只读降级。seq 守卫：hydrate 期间发生 mutation →
    // 读回丢弃（旧 response 不覆盖新 mutation）。
    if (hasBackend() && userDataRepository) {
      const startSeq = identityMutationSeq
      try {
        const envelope = await userDataRepository.load('profiles')
        if (envelope) {
          if (identityMutationSeq !== startSeq) {
            set(state => ({ identityPersistence: { ...state.identityPersistence, profiles: 'ready' } }))
            queueMicrotask(syncIdentityToBackend)
            return
          }
          const parsed = parseProfileEnvelope(JSON.stringify(envelope.payload), DEFAULT_PROFILES)
          persistProfiles(localStorage, { profiles: parsed.profiles, activeProfileId: parsed.activeProfileId })
          updateIdentityCacheMeta('profiles', 'clean', envelope.revision)
          set(state => ({
            profiles: parsed.profiles,
            activeProfileId: parsed.activeProfileId,
            lastPersistError: state.identityPersistence.sessions === 'degraded-readonly' ? state.lastPersistError : null,
            identityPersistence: { ...state.identityPersistence, profiles: 'ready' },
          }))
          return
        }
      } catch (error) {
        console.error('从后端读取 Profile 失败，仅以本地缓存只读降级', error)
        get().hydrateProfilesLocal(legacy)
        updateIdentityCacheMeta('profiles', 'stale')
        set(state => ({
          lastPersistError: 'SQLite 用户数据不可用；本地缓存为只读，请重试恢复',
          identityPersistence: { ...state.identityPersistence, profiles: 'degraded-readonly' },
        }))
        throw error
      }
    }
    get().hydrateProfilesLocal(legacy)
    if (hasBackend() && userDataRepository) {
      set(state => ({
        lastPersistError: state.identityPersistence.sessions === 'degraded-readonly' ? state.lastPersistError : null,
        identityPersistence: { ...state.identityPersistence, profiles: 'ready' },
      }))
      updateIdentityCacheMeta('profiles', 'clean', 0)
      syncIdentityToBackend(['profiles'])
    }
  },
  hydrateProfilesLocal: (legacy) => {
    // 本地路径（browser / 后端无数据 / 后端失败 / 导入强制本地）：
    const loaded = loadProfiles(localStorage, DEFAULT_PROFILES)
    if (localStorage.getItem(PROFILE_STORAGE_KEY) !== null) {
      set({ profiles: loaded.profiles, activeProfileId: loaded.activeProfileId })
      return
    }
    // 迁移：旧 theme 内嵌 profile 一次性落新 key（无 legacy 时用默认值）
    const source = legacy && legacy.profiles.length > 0
      ? { profiles: legacy.profiles as PersistedProfile[], activeProfileId: legacy.activeProfileId }
      : { profiles: DEFAULT_PROFILES, activeProfileId: DEFAULT_PROFILES[0].id }
    persistProfiles(localStorage, source)
    set({ profiles: source.profiles, activeProfileId: source.activeProfileId })
  },
  hydrateFromLocal: async (legacy) => {
    if (!canMutateIdentityDomain(get().identityPersistence, 'profiles', 'sessions')) {
      reportRuntimeError('导入用户数据', new Error('SQLite 用户数据处于只读降级状态，请先重试恢复'))
      return
    }
    // I14-W6 CR-01：导入等"本地已写入"场景——强制本地路径读回（读取刚写入的
    // localStorage），再写穿后端（Tauri 权威源同步），避免导入值被后端陈旧读回覆盖。
    // CR-05：递增 mutation-seq——若启动 hydration 的后端读回仍在飞，落地时 seq 已变
    // → 读回被守卫丢弃，不覆盖导入值（与 mutation 守卫同一保护语义）。
    identityMutationSeq += 1
    get().hydrateProfilesLocal(legacy)
    get().hydrateSessionsLocal()
    syncIdentityToBackend()
  },
  addSession: (name, agentId, cwd) => {
    if (!canMutateIdentityDomain(get().identityPersistence, 'sessions')) return ''
    if (get().sessionHydration?.kind === 'corrupt') return ''
    const profileId = get().activeProfileId
    // ISSUE-01：归属 Agent 由调用方显式传入，缺省取当前 activeAgent；创建后 owner 不变
    const owner = agentId ?? get().activeAgent
    const now = Date.now()
    const baseId = 's' + now.toString(36)
    let id = baseId
    let suffix = 1
    while (get().sessions.some(session => session.id === id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    const profile = get().profiles.find(value => value.id === profileId)
      ?? { id: profileId, name: profileId, persona: '', model: '' }
    let creationSnapshot: SessionCreationSnapshot
    try {
      creationSnapshot = compileSessionCreationSnapshot(getSessionCreationRegistry().getSnapshot(), {
        sessionId: id,
        source: `local:${id}`,
        title: name,
        agentId: owner,
        profile: { ...profile },
        platform: 'local',
        workdir: cwd?.workdir ?? '',
        ...(cwd?.workspaceId ? { workspaceId: cwd.workspaceId } : {}),
        ...(cwd?.skills ? { workspaceSkills: [...cwd.skills] } : {}),
        ...(cwd?.mcpServerIds ? { workspaceMcpServerIds: [...cwd.mcpServerIds] } : {}),
        ...(cwd?.hookPluginIds ? { workspaceHookPluginIds: [...cwd.hookPluginIds] } : {}),
      }, now)
    } catch (error) {
      reportRuntimeError('准备会话插件贡献', error)
      return ''
    }
    // source = 'local:' + id（唯一）：会话重放/运行时状态按 AgentContextKey（agentId+source）
    // 隔离，source 必须全局唯一——'local:' + name 在同 agent 同名会话（自动命名/跨 profile 同名）
    // 下冲突导致 controller/runtime 状态串会话（复读/串消息，ISSUE-06）。name 独立用于显示。
    const s: Session = {
      id,
      agentId: owner,
      name,
      source: 'local:' + id,
      profileId,
      createdAt: now,
      lastActiveAt: now,
      platform: 'local',
      workdir: cwd?.workdir ?? '',
      ...(cwd?.workspaceId ? { workspaceId: cwd.workspaceId } : {}),
      sessionPrompt: '',
      skills: cwd?.skills ?? [],
      hooks: cwd?.hooks ?? [],
      commandSetPlugins: [CORE_COMMAND_SET_PLUGIN_ID],
      autoName: '',
      metadata: {},
      context: {},
      creationSnapshot,
    }
    set(state => {
      const sessions = [...state.sessions, s]
      const ok = persistMergingUnresolved(sessions, state.turns, state.sessionHydration)
      identityMutationSeq += 1
      queueMicrotask(syncIdentityToBackend)
      return { sessions, lastPersistError: persistFlag(ok, state.lastPersistError) }
    })
    return id
  },
  forkSession: (sourceId) => {
    const state = get()
    if (!canMutateIdentityDomain(state.identityPersistence, 'sessions')) return ''
    if (state.sessionHydration?.kind === 'corrupt') return ''
    const original = state.sessions.find(session => session.id === sourceId)
    if (!original) return ''

    const now = Date.now()
    const baseId = 's' + now.toString(36)
    let id = baseId
    let suffix = 1
    while (state.sessions.some(session => session.id === id)) {
      id = `${baseId}-${suffix}`
      suffix += 1
    }
    const name = `${original.name} (分叉)`
    const profile = state.profiles.find(value => value.id === original.profileId)
      ?? { id: original.profileId, name: original.profileId, persona: '', model: '' }
    let creationSnapshot: SessionCreationSnapshot
    try {
      creationSnapshot = compileSessionCreationSnapshot(getSessionCreationRegistry().getSnapshot(), {
        sessionId: id,
        source: `local:${id}`,
        title: name,
        agentId: original.agentId,
        profile: { ...profile },
        platform: 'local',
        workdir: original.workdir,
        ...(original.workspaceId ? { workspaceId: original.workspaceId } : {}),
      }, now)
    } catch (error) {
      reportRuntimeError('准备分叉会话插件贡献', error)
      return ''
    }

    const fork: Session = {
      id,
      agentId: original.agentId,
      name,
      source: `local:${id}`,
      profileId: original.profileId,
      createdAt: now,
      lastActiveAt: now,
      platform: 'local',
      workdir: original.workdir,
      ...(original.workspaceId ? { workspaceId: original.workspaceId } : {}),
      sessionPrompt: original.sessionPrompt,
      skills: [...original.skills],
      hooks: [...original.hooks],
      ...(original.commandSetPlugins ? { commandSetPlugins: [...original.commandSetPlugins] } : {}),
      autoName: '',
      metadata: {},
      context: {},
      creationSnapshot,
    }
    const sessions = [...state.sessions, fork]
    const ok = persistMergingUnresolved(sessions, state.turns, state.sessionHydration)
    set({ sessions, lastPersistError: persistFlag(ok, state.lastPersistError) })
    identityMutationSeq += 1
    queueMicrotask(syncIdentityToBackend)
    return id
  },
  removeSession: (id) => set(state => {
    if (!canMutateIdentityDomain(state.identityPersistence, 'sessions')) return state
    if (state.sessionHydration?.kind === 'corrupt') return state
    const removed = state.sessions.find(session => session.id === id)
    const sessions = state.sessions.filter(session => session.id !== id)
    const turns = state.turns.filter(turn => turn.sessionId !== id)
    const sessionsOk = persistMergingUnresolved(sessions, turns, state.sessionHydration)
    if (!removed) return { sessions, turns, lastPersistError: persistFlag(sessionsOk, state.lastPersistError) }
    // 联动：清 runtime（live stats/modes/config/generating）、sheet 状态与会话级 UI 状态
    // I01-W2：按 AgentContext（agentId+source）清理，同名 source 其他 Agent 的会话不受影响
    useRuntimeStore.getState().clearSessionSource({ agentId: removed.agentId, source: removed.source })
    clearSessionUiState(id)
    const agentStates = Object.fromEntries(Object.entries(useWorkspaceStore.getState().sheetAgentStates).map(([agentId, sheetState]) => [
      agentId,
      sheetState.activeSessionId === id ? { ...sheetState, activeSessionId: undefined } : sheetState,
    ]))
    useWorkspaceStore.getState().patchSheetAgentStates(agentStates)
    identityMutationSeq += 1
    queueMicrotask(syncIdentityToBackend)
    return { sessions, turns, lastPersistError: persistFlag(sessionsOk, state.lastPersistError) }
  }),
  updateSession: (id, partial) => set(s => {
    if (!canMutateIdentityDomain(s.identityPersistence, 'sessions')) return s
    if (s.sessionHydration?.kind === 'corrupt') return s
    const sessions = s.sessions.map(session => session.id === id ? { ...session, ...partial } : session)
    const ok = persistMergingUnresolved(sessions, s.turns, s.sessionHydration)
    identityMutationSeq += 1
    queueMicrotask(syncIdentityToBackend)
    return { sessions, lastPersistError: persistFlag(ok, s.lastPersistError) }
  }),
  updateSessionPluginData: (id, pluginId, plane, patch) => {
    const current = get()
    if (!canMutateIdentityDomain(current.identityPersistence, 'sessions')) return false
    const target = current.sessions.find(session => session.id === id)
    if (!target || current.sessionHydration?.kind === 'corrupt') return false
    const merged = mergePluginNamespace(target.metadata ?? {}, target.context ?? {}, plane, pluginId, patch)
    const sessions = current.sessions.map(session => session.id === id ? { ...session, ...merged } : session)
    const ok = persistMergingUnresolved(sessions, current.turns, current.sessionHydration)
    identityMutationSeq += 1
    set({ sessions, lastPersistError: persistFlag(ok, current.lastPersistError) })
    queueMicrotask(syncIdentityToBackend)
    return true
  },
  ensureTurn: (input) => {
    const current = get()
    if (!canMutateIdentityDomain(current.identityPersistence, 'sessions')) return false
    if (!current.sessions.some(session => session.id === input.sessionId)) return false
    const existing = current.turns.find(turn => turn.id === input.id)
    const turns = existing
      ? current.turns.map(turn => turn.id === input.id ? { ...turn, ...input } : turn)
      : [...current.turns, { ...input, metadata: {}, context: {} }]
    const ok = persistMergingUnresolved(current.sessions, turns, current.sessionHydration)
    identityMutationSeq += 1
    set({ turns, lastPersistError: persistFlag(ok, current.lastPersistError) })
    queueMicrotask(syncIdentityToBackend)
    return true
  },
  updateTurnPluginData: (id, pluginId, plane, patch) => {
    const current = get()
    if (!canMutateIdentityDomain(current.identityPersistence, 'sessions')) return false
    const target = current.turns.find(turn => turn.id === id)
    if (!target || current.sessionHydration?.kind === 'corrupt') return false
    const merged = mergePluginNamespace(target.metadata, target.context, plane, pluginId, patch)
    const turns = current.turns.map(turn => turn.id === id ? { ...turn, ...merged } : turn)
    const ok = persistMergingUnresolved(current.sessions, turns, current.sessionHydration)
    identityMutationSeq += 1
    set({ turns, lastPersistError: persistFlag(ok, current.lastPersistError) })
    queueMicrotask(syncIdentityToBackend)
    return true
  },
  setSessionPeriId: (id, periId) => set(s => {
    if (!canMutateIdentityDomain(s.identityPersistence, 'sessions')) return s
    if (s.sessionHydration?.kind === 'corrupt') return s
    const sessions = s.sessions.map(ss => ss.id === id ? { ...ss, periId } : ss)
    const ok = persistMergingUnresolved(sessions, s.turns, s.sessionHydration)
    identityMutationSeq += 1
    queueMicrotask(syncIdentityToBackend)
    return { sessions, lastPersistError: persistFlag(ok, s.lastPersistError) }
  }),
  resolveSessionOwner: async (sessionId, agentId) => {
    if (!canMutateIdentityDomain(get().identityPersistence, 'sessions')) return false
    const result = await resolveUnresolvedSessionTransaction(sessionId, agentId, {
      getUnresolved: () => {
        const hydration = get().sessionHydration
        return hydration?.kind === 'needs-owner-resolution' ? hydration.unresolved : []
      },
      getAgents: () => get().agents,
      commit: async (legacy, owner) => {
        const current = get()
        const resolved: Session = {
          ...legacy,
          agentId: owner,
          metadata: legacy.metadata ?? {},
          context: legacy.context ?? {},
        }
        const sessions = [...current.sessions, resolved]
        const unresolved = current.sessionHydration?.kind === 'needs-owner-resolution'
          ? current.sessionHydration.unresolved.filter(item => item.id !== legacy.id)
          : []
        const nextHydration: SessionHydrationState = unresolved.length > 0
          ? { kind: 'needs-owner-resolution', unresolved }
          : { kind: 'ready' }
        // Tauri 模式先提交后端权威 envelope；失败直接抛出，store/unresolved 保持原状。
        // browser 模式无 repository，仍由 localStorage 同步提交。
        if (userDataRepository) {
          await userDataRepository.save('sessions', {
            version: SESSION_SCHEMA_VERSION,
            sessions: [...sessions, ...unresolved],
            turns: current.turns,
          })
        }
        const ok = persistMergingUnresolved(sessions, current.turns, nextHydration)
        identityMutationSeq += 1
        set({ sessions, sessionHydration: nextHydration, sessionsHydrated: true, lastPersistError: persistFlag(ok, current.lastPersistError) })
      },
    })
    if (!result.ok) {
      if (result.kind === 'transport') reportRuntimeError('恢复遗留会话归属', result.cause ?? result.message)
      return false
    }
    return true
  },
  hydrateSessions: async () => {
    // I14-W6：Tauri 模式后端读回优先；无行才冷启动导入，失败时缓存只读；seq 守卫防旧读回覆盖 mutation。
    if (hasBackend() && userDataRepository) {
      const startSeq = identityMutationSeq
      try {
        const envelope = await userDataRepository.load('sessions')
        if (envelope) {
          if (identityMutationSeq !== startSeq) {
            set(state => ({ identityPersistence: { ...state.identityPersistence, sessions: 'ready' } }))
            queueMicrotask(syncIdentityToBackend)
            return
          }
          const hints: OwnerHints = {
            activeSessionByAgent: Object.fromEntries(
              Object.entries(useWorkspaceStore.getState().sheetAgentStates)
                .map(([agentId, sheetState]) => [agentId, sheetState.activeSessionId]),
            ),
          }
          const result = normalizeSessions(envelope.payload, get().profiles, hints)
          const sessionHydration: SessionHydrationState = result.kind === 'ready'
            ? { kind: 'ready' }
            : result.kind === 'corrupt'
              ? { kind: 'corrupt', message: result.message }
              : { kind: 'needs-owner-resolution', unresolved: result.unresolved }
          // corrupt 结果无 sessions 字段：显式回退空列表，避免写入 undefined
          set(state => ({
            sessions: result.kind === 'corrupt' ? [] : result.sessions,
            turns: result.kind === 'corrupt' ? [] : result.turns ?? [],
            sessionHydration,
            sessionsHydrated: true,
            lastPersistError: state.identityPersistence.profiles === 'degraded-readonly' ? state.lastPersistError : null,
            identityPersistence: { ...state.identityPersistence, sessions: 'ready' },
          }))
          persistMergingUnresolved(
            result.kind === 'corrupt' ? [] : result.sessions,
            result.kind === 'corrupt' ? [] : result.turns ?? [],
            sessionHydration,
          )
          updateIdentityCacheMeta('sessions', 'clean', envelope.revision)
          return
        }
      } catch (error) {
        console.error('从后端读取 Sessions 失败，仅以本地缓存只读降级', error)
        get().hydrateSessionsLocal()
        updateIdentityCacheMeta('sessions', 'stale')
        set(state => ({
          lastPersistError: 'SQLite 用户数据不可用；本地缓存为只读，请重试恢复',
          identityPersistence: { ...state.identityPersistence, sessions: 'degraded-readonly' },
        }))
        throw error
      }
    }
    get().hydrateSessionsLocal()
    if (hasBackend() && userDataRepository) {
      set(state => ({
        lastPersistError: state.identityPersistence.profiles === 'degraded-readonly' ? state.lastPersistError : null,
        identityPersistence: { ...state.identityPersistence, sessions: 'ready' },
      }))
      updateIdentityCacheMeta('sessions', 'clean', 0)
      syncIdentityToBackend(['sessions'])
    }
  },
  hydrateSessionsLocal: () => {
    // 本地路径（browser / 后端无数据 / 后端失败 / 导入强制本地）：原同步逻辑
    try {
      // ISSUE-01：owner 推断 hint 来自 workspace sheet 状态（唯一 Agent 的 activeSessionId）
      const hints: OwnerHints = {
        activeSessionByAgent: Object.fromEntries(
          Object.entries(useWorkspaceStore.getState().sheetAgentStates)
            .map(([agentId, sheetState]) => [agentId, sheetState.activeSessionId]),
        ),
      }
      const result = loadSessions(localStorage, get().profiles, hints)
      const sessionHydration: SessionHydrationState = result.kind === 'ready'
        ? { kind: 'ready' }
        : result.kind === 'corrupt'
          ? { kind: 'corrupt', message: result.message }
          : { kind: 'needs-owner-resolution', unresolved: result.unresolved }
      // corrupt 结果无 sessions 字段：显式回退空列表，避免写入 undefined
      set({
        sessions: result.kind === 'corrupt' ? [] : result.sessions,
        turns: result.kind === 'corrupt' ? [] : result.turns ?? [],
        sessionHydration,
        sessionsHydrated: true,
      })
    } catch (error) {
      console.error('Session 持久化读取失败', error)
      set({ sessions: [], turns: [], sessionHydration: { kind: 'corrupt', message: error instanceof Error ? error.message : '会话数据损坏' }, sessionsHydrated: true })
    }
  },
  getUser: (source) => get().users.find(u => u.id === source),
  setAgents: (a) => set((state) => {
    // FE-AUD-005：agents 到达后仅 prune 无效 agent sheet，不重复全量 hydrate
    //（hydrate 已由 bootstrap hydrateDomains 完成；全量替换会覆盖启动期用户操作）
    useWorkspaceStore.getState().pruneAgentSheets(a.map(agent => agent.id))
    // Agent lifecycle 是 live active authority；list_agents 的 active=true 用于配置
    // 初始化/重载后的前后端对账。列表未提供 active 时保留当前值，兼容 browser fixture。
    const backendActive = a.find(agent => agent.active === true)?.id
    const agentState = backendActive ? useWorkspaceStore.getState().sheetAgentStates[backendActive] : undefined
    return {
      agents: a,
      ...(backendActive && backendActive !== state.activeAgent ? {
        activeAgent: backendActive,
        ...(agentState?.activeProfileId ? { activeProfileId: agentState.activeProfileId } : {}),
      } : {}),
    }
  }),
  setActiveAgent: (id) => set(() => {
    const agentState = useWorkspaceStore.getState().sheetAgentStates[id]
    return {
      activeAgent: id,
      ...(agentState?.activeProfileId ? { activeProfileId: agentState.activeProfileId } : {}),
    }
  }),
}))

registerPluginSessionDataPort({
  getSessionNamespace: (sessionId, pluginId, plane) => {
    const session = useIdentityStore.getState().sessions.find(candidate => candidate.id === sessionId)
    return (plane === 'metadata' ? session?.metadata : session?.context)?.[pluginId]
  },
  setSessionNamespace: (sessionId, pluginId, plane, patch) => (
    useIdentityStore.getState().updateSessionPluginData(sessionId, pluginId, plane, patch)
  ),
  ensureTurn: turn => useIdentityStore.getState().ensureTurn(turn),
  getTurnNamespace: (turnId, pluginId, plane) => {
    const turn = useIdentityStore.getState().turns.find(candidate => candidate.id === turnId)
    return (plane === 'metadata' ? turn?.metadata : turn?.context)?.[pluginId]
  },
  setTurnNamespace: (turnId, pluginId, plane, patch) => (
    useIdentityStore.getState().updateTurnPluginData(turnId, pluginId, plane, patch)
  ),
})

// ── I14-W5：后端 user store 写穿（Tauri 模式） ──
// composition root 选择：Tauri 走后端 versioned store；browser 模式 null（不经本仓库）。
const userDataRepository: UserDataRepository | null = selectUserDataRepository()

/**
 * 等待全部身份写穿链落定（关闭前 flush / 测试收敛）；browser 模式为 no-op。
 * hydrateFromLocal 等路径的写穿是 fire-and-forget，调用方需要确定性落库时显式 flush。
 */
export async function flushIdentityBackend(): Promise<void> {
  await userDataRepository?.flush()
}

/** 删除会话等外部后端事务完成后，刷新 sessions revision baseline。 */
export async function refreshSessionsBackend(): Promise<void> {
  await userDataRepository?.load('sessions')
}

// I14-W6：mutation 序号——每次 identity mutation 递增；async hydration 在 load 前捕获、
// 读回落地前比对：期间有 mutation → 丢弃过期读回（旧 response 不覆盖新 mutation）。
let identityMutationSeq = 0

/**
 * I14-W5：把当前 identity 状态（profiles/activeProfileId/sessions + unresolved）写穿到
 * 后端 versioned user store。读 getState() 最新状态（调用方在 set() 应用后经
 * queueMicrotask 触发）；browser 模式直接跳过（localStorage 仍是主存储，W6 再接读回）。
 * 后端失败可见上报（reportRuntimeError → ErrorCenter），localStorage 写盘不受影响。
 */
function syncIdentityToBackend(
  domains: Array<keyof IdentityPersistenceState> = ['profiles', 'sessions'],
): void {
  if (!userDataRepository) return
  const state = useIdentityStore.getState()
  const unresolved = state.sessionHydration?.kind === 'needs-owner-resolution' ? state.sessionHydration.unresolved : []
  const handleError = (domain: 'profiles' | 'sessions', error: unknown): void => {
    updateIdentityCacheMeta(domain, 'stale')
    useIdentityStore.setState(current => ({
      lastPersistError: 'SQLite 用户数据同步失败；已切换为只读，请重试恢复',
      identityPersistence: { ...current.identityPersistence, [domain]: 'degraded-readonly' },
    }))
    reportRuntimeError(`同步用户数据到后端失败（${domain}）`, error)
  }
  if (domains.includes('profiles') && state.identityPersistence.profiles !== 'degraded-readonly') {
    updateIdentityCacheMeta('profiles', 'pending')
    void userDataRepository.save('profiles', {
      version: PROFILE_ENVELOPE_VERSION,
      profiles: state.profiles,
      activeProfileId: state.activeProfileId,
    }).then((revision) => {
      updateIdentityCacheMeta('profiles', 'clean', revision)
      useIdentityStore.setState(current => ({
        lastPersistError: current.identityPersistence.sessions === 'degraded-readonly' ? current.lastPersistError : null,
        identityPersistence: { ...current.identityPersistence, profiles: 'ready' },
      }))
    }).catch((error) => {
      handleError('profiles', error)
    })
  }
  if (domains.includes('sessions') && state.identityPersistence.sessions !== 'degraded-readonly') {
    updateIdentityCacheMeta('sessions', 'pending')
    void userDataRepository.save('sessions', {
      version: SESSION_SCHEMA_VERSION,
      sessions: [...state.sessions, ...unresolved],
      turns: state.turns,
    }).then((revision) => {
      updateIdentityCacheMeta('sessions', 'clean', revision)
      useIdentityStore.setState(current => ({
        lastPersistError: current.identityPersistence.profiles === 'degraded-readonly' ? current.lastPersistError : null,
        identityPersistence: { ...current.identityPersistence, sessions: 'ready' },
      }))
    }).catch((error) => {
      handleError('sessions', error)
    })
  }
}
