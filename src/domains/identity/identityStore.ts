import { createSolidStoreKernel } from '../../infrastructure/state/solidStoreKernel'
import { createReactStoreHook, type ZustandHook } from '../../host/reactStoreShim'
import { identityCrossDomain } from '../../app/ports/identityCrossDomainPort'
import { createIdentityBackendSync } from '../../infrastructure/persistence/identityBackendSync.ts'
import { DEFAULT_PROFILES } from './identityTypes.ts'
import type { IdentityStoreAccessor, IdentityStoreState } from './identityStoreShape.ts'
import { createProfileActions } from './identityProfileActions.ts'
import { createSessionActions } from './identitySessionActions.ts'
import { installIdentityPluginDataPort } from './identityPluginDataPort.ts'

// #228 批次D / B-8a：持久化、后端同步、Profile/Session 动作与插件数据端口已拆至
// 各专责模块；以下 re-export 保持既有公开 import 面（消费方仍从 identityStore 取
// 这些名字，零改动）。
export type { AgentEntry } from '../../contracts/agentEntry.ts'
export {
  DEFAULT_PROFILES,
  resolveSessionDisplayName,
  type IdentityPersistenceState,
  type Profile,
  type Session,
  type SessionHydrationState,
  type Turn,
  type UserMapping,
} from './identityTypes.ts'
export { IDENTITY_CACHE_META_KEY } from './identityPersistence.ts'
export { flushIdentityBackend, refreshSessionsBackend } from '../../infrastructure/persistence/identityBackendSync.ts'

/**
 * identityStore — 身份与会话状态域（阶段 1：store 按域拆分）。
 *
 * 承载：profiles / activeProfileId / sessions / users / agents / activeAgent。
 * 本文件只做装配：初始态、users/agents 两个轻动作、动作工厂接线、后端写穿同步器
 * 与插件会话数据端口的安装。Profile/Session 事务动作见 identityProfileActions /
 * identitySessionActions；持久化由 identityPersistence（localStorage cache meta /
 * mutation 守卫 / merge-unresolved 写盘）与 sessionPersistence/profilePersistence
 * 管理；Tauri SQLite 后端写穿由 identityBackendSync 管理。跨域联动（profile/session/
 * agent 变化同步 workspace 与 runtime）在动作内经 identityCrossDomain 调用其他域。
 */

// #515 批0：zustand → Solid 内核置换（对外签名不变；hook shim 待 React 面退役时拆除）。
// 装配先建同步器与 accessor（都经 useIdentityStore 延迟解析，无初始化环），再建内核。
const syncIdentityToBackend = createIdentityBackendSync({
  getState: () => useIdentityStore.getState(),
  setState: patch => useIdentityStore.setState(patch),
})
// 动作工厂的 accessor：显式注解切断 store 初始化器内的类型自引用（TS7022）；
// syncToBackend 经闭包延迟解析（同步器已在上行创建）。
const accessor: IdentityStoreAccessor = {
  get: () => useIdentityStore.getState() as IdentityStoreState,
  set: patch => { useIdentityStore.setState(patch as never) },
  syncToBackend: (domains?: Array<'profiles' | 'sessions'>) => { syncIdentityToBackend(domains) },
}

const identityKernel = createSolidStoreKernel<IdentityStoreState>({
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
  // 启动前的占位初值（list_agents 到达后由 setAgents 收敛：列表里没有它就清空为 ''）。
  // 零 Agent 首跑时它只活到首次 list_agents 返回（#326）。
  activeAgent: 'peri',
  lastPersistError: null,
  identityPersistence: { profiles: 'unknown', sessions: 'unknown' },
  ...createProfileActions(accessor),
  ...createSessionActions(accessor),
  getUser: (source) => useIdentityStore.getState().users.find(u => u.id === source),
  setAgents: (a) => useIdentityStore.setState((state) => {
    // FE-AUD-005：agents 到达后仅 prune 无效 agent sheet，不重复全量 hydrate
    //（hydrate 已由 bootstrap hydrateDomains 完成；全量替换会覆盖启动期用户操作）
    identityCrossDomain().pruneAgentSheets(a.map(agent => agent.id))
    // Agent lifecycle 是 live active authority；list_agents 的 active=true 用于配置
    // 初始化/重载后的前后端对账。列表未提供 active 时保留当前值，兼容 browser fixture。
    const backendActive = a.find(agent => agent.active === true)?.id
    // #326：当前 Agent 已不在列表里（含「零 Agent」）时必须清空 activeAgent——否则它会一直
    // 停在 store 初值的 'peri'，界面上凭空多出一个不存在的 Agent（设置卡片、权限切片、
    // 会话归属都按它算）。列表里有当前 Agent 但未标 active 时仍保留（browser fixture 口径）。
    if (!a.some(agent => agent.id === state.activeAgent)) {
      const next = backendActive ?? ''
      return state.activeAgent === next ? { agents: a } : { agents: a, activeAgent: next }
    }
    const agentState = backendActive ? identityCrossDomain().sheetAgentStates()[backendActive] : undefined
    return {
      agents: a,
      ...(backendActive && backendActive !== state.activeAgent ? {
        activeAgent: backendActive,
        ...(agentState?.activeProfileId ? { activeProfileId: agentState.activeProfileId } : {}),
      } : {}),
    }
  }),
  setActiveAgent: (id) => useIdentityStore.setState(() => {
    const agentState = identityCrossDomain().sheetAgentStates()[id]
    return {
      activeAgent: id,
      ...(agentState?.activeProfileId ? { activeProfileId: agentState.activeProfileId } : {}),
    }
  }),
})

export const useIdentityStore: ZustandHook<IdentityStoreState> = createReactStoreHook(identityKernel)

installIdentityPluginDataPort({
  get: () => useIdentityStore.getState(),
  set: patch => useIdentityStore.setState(patch),
  syncToBackend: () => { /* 端口读写经 store 动作自带同步，无需额外触发 */ },
})
