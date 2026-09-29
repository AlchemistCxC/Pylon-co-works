import { identityCrossDomain } from '../../app/ports/identityCrossDomainPort'
import type { OwnerHints } from './sessionPersistence.ts'
import type { ProfilePersistenceState } from './profilePersistence.ts'
import type { AgentEntry } from '../../contracts/agentEntry.ts'
import type { PluginDataPlane } from '../pluginData/pluginNamespace.ts'
import type { IdentityPersistenceState, Profile, Session, SessionHydrationState, Turn, UserMapping } from './identityTypes.ts'

/**
 * identityStoreShape — store 内部管线（B-8a 拆分）：完整 state 接口、动作工厂共用的
 * store accessor、mutation 序号守卫与 owner 推断 hint。仅域内使用，不属于公共 API。
 */

export interface IdentityStoreState {
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
  addSession: (name: string, agentId?: string, cwd?: { workdir?: string; workspaceId?: string; skills?: string[]; mcpServerIds?: string[]; hookPluginIds?: string[] }) => string
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

/**
 * 动作工厂与装配之间的单向通道：工厂只依赖这四个入口，不 import store 本体
 * （避免 identityStore ⇄ 动作模块的运行时环）。syncToBackend 经闭包延迟解析——
 * 后端同步器在 store 创建之后才装配。
 */
export interface IdentityStoreAccessor {
  get: () => IdentityStoreState
  set: (partial: Partial<IdentityStoreState> | ((state: IdentityStoreState) => Partial<IdentityStoreState>)) => void
  syncToBackend: (domains?: Array<'profiles' | 'sessions'>) => void
}

// I14-W6：mutation 序号——每次 identity mutation 递增；async hydration 在 load 前捕获、
// 读回落地前比对：期间有 mutation → 丢弃过期读回（旧 response 不覆盖新 mutation）。
let identityMutationSeq = 0

export function bumpIdentityMutationSeq(): void {
  identityMutationSeq += 1
}

export function currentIdentityMutationSeq(): number {
  return identityMutationSeq
}

/**
 * Owner 推断 hint：workspace sheet 状态里各 Agent 的 activeSessionId（ISSUE-01
 * 语义）。三个 hydrate 路径（后端/本地/强制本地）共用同一构造（#260-D14），
 * 防三份逐字拷贝漂移。
 */
export function ownerHintsFromSheetStates(): OwnerHints {
  return {
    activeSessionByAgent: Object.fromEntries(
      Object.entries(identityCrossDomain().sheetAgentStates())
        .map(([agentId, sheetState]) => [agentId, sheetState.activeSessionId]),
    ),
  }
}
