import { type LegacySession } from './sessionPersistence';
import { type ProfilePersistenceState } from './profilePersistence';
import { type PluginDataPlane, type PluginNamespaceRoot } from './domains/pluginData/pluginNamespace.js';
import type { SessionCreationSnapshot } from './plugin-runtime/session-creation/sessionCreationTypes.js';
import type { AgentEntry } from './domains/agent/agentEntry.js';
export type { AgentEntry } from './domains/agent/agentEntry.js';
/**
 * identityStore — 身份与会话状态域（阶段 1：store 按域拆分）。
 *
 * 承载：profiles / activeProfileId / sessions / users / agents / activeAgent。
 * 持久化由 identity persistence boundary 管理（sessions 由 sessionPersistence 独立管理）。
 * 跨域联动（profile/session/agent 变化同步 workspace 与 runtime）在本 store 组合 action 内
 * 经 getState 调用其他域 store。
 */
export interface Profile {
    id: string;
    name: string;
    avatar?: string;
    persona: string;
    model: string;
}
export interface Session {
    id: string;
    /** ISSUE-01：会话归属 Agent（owner schema）。v2 起必需，create/update/delete 保持归属不变 */
    agentId: string;
    periId?: string;
    name: string;
    source: string;
    profileId: string;
    createdAt: number;
    lastActiveAt: number;
    /** Timestamp of the most recent assistant reply (display semantics). */
    lastReplyAt?: number;
    /** 归档时间；归档会话不显示在 Agentsheet 活动列表。 */
    archivedAt?: number;
    platform: string;
    workdir: string;
    /** CWD-03：Workspace 实体绑定（方案 C）。有值 = 绑定 Workspace（root 单一来源，
     * workdir 保持同步快照）；undefined = legacy 未绑定。workspaceId 进入 new/load wire */
    workspaceId?: string;
    sessionPrompt: string;
    /** @deprecated legacy/reserved：后端会话级配置链路未确定（FE-AUD-023），只读说明不编辑不发送 */
    skills: string[];
    /** @deprecated legacy/reserved：同 skills，契约确定前不提供编辑 */
    hooks: string[];
    /** M2：启用的 agent.commandSet 插件 id；缺省 = 全部已激活命令集插件（旧数据兼容）。 */
    commandSetPlugins?: string[];
    autoName: string;
    /** 插件只能经 scope-bound API 写自己的 key。 */
    metadata?: PluginNamespaceRoot;
    context?: PluginNamespaceRoot;
    /** 插件会话创建贡献在本地 Session 建立时编译出的不可变、可持久化快照。 */
    creationSnapshot?: SessionCreationSnapshot;
}
export interface Turn {
    id: string;
    sessionId: string;
    startedAt: number;
    endedAt?: number;
    metadata: PluginNamespaceRoot;
    context: PluginNamespaceRoot;
}
export interface UserMapping {
    id: string;
    name: string;
    avatar?: string;
}
/**
 * ISSUE-01：会话水合结果（不含 sessions——sessions 落在 state.sessions）。
 * 非 ready 时绝不把 unresolved 静默归给 activeAgent；由恢复选择流程显式定 owner。
 */
export type SessionHydrationState = {
    kind: 'ready';
} | {
    kind: 'needs-owner-resolution';
    unresolved: LegacySession[];
} | {
    kind: 'corrupt';
    message: string;
};
export type IdentityBackendStatus = 'unknown' | 'ready' | 'degraded-readonly';
export interface IdentityPersistenceState {
    profiles: IdentityBackendStatus;
    sessions: IdentityBackendStatus;
}
export declare const IDENTITY_CACHE_META_KEY = "pylon-identity-cache-meta:v1";
interface IdentityStoreState {
    profiles: Profile[];
    activeProfileId: string;
    sessions: Session[];
    turns: Turn[];
    sessionsHydrated: boolean;
    /** ISSUE-01：最近一次 hydrate 的结果状态；ready 之外供 UI 呈现恢复选择/损坏提示 */
    sessionHydration: SessionHydrationState | null;
    users: UserMapping[];
    agents: AgentEntry[];
    activeAgent: string;
    /** 报告 1C L1：最近一次用户配置（Profile/Session）写盘失败的可见状态 */
    lastPersistError: string | null;
    /** Tauri：SQLite authority 可用性；degraded 时 localStorage 仅供只读展示。 */
    identityPersistence: IdentityPersistenceState;
    setActiveProfile: (id: string) => void;
    addProfile: (p: Profile) => string;
    /** I14-W7：删除 Profile（Tauri 后端原子事务 + 重读；browser 本地 fallback）。可为 async。 */
    removeProfile: (id: string) => void | Promise<void>;
    /** FE-AUD-002：从 pylon-profiles 恢复；旧 theme 数据仅在无新 key 时一次性迁移落盘。
     * I14-W6：可为 async——Tauri 模式后端读回（调用方可 await 完成）。 */
    hydrateProfiles: (legacy?: ProfilePersistenceState) => void | Promise<void>;
    /** I14-W6 CR-01：强制本地路径（导入/浏览器场景）——读取 localStorage 不经后端 */
    hydrateProfilesLocal: (legacy?: ProfilePersistenceState) => void;
    /** I14-W6 CR-01：导入等"本地已写入"场景——本地读回 + 写穿后端（Tauri 权威源同步） */
    hydrateFromLocal: (legacy?: ProfilePersistenceState) => void | Promise<void>;
    addSession: (name: string, agentId?: string, cwd?: {
        workdir?: string;
        workspaceId?: string;
        skills?: string[];
        hooks?: string[];
        mcpServerIds?: string[];
        hookPluginIds?: string[];
    }) => string;
    /** D5：从恢复失败的会话显式创建独立本地分叉；原 Session/remote binding 保持不变。 */
    forkSession: (id: string) => string;
    removeSession: (id: string) => void;
    updateSession: (id: string, partial: Partial<Session>) => void;
    updateSessionPluginData: (id: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>) => boolean;
    ensureTurn: (turn: Pick<Turn, 'id' | 'sessionId' | 'startedAt'> & Partial<Pick<Turn, 'endedAt'>>) => boolean;
    updateTurnPluginData: (id: string, pluginId: string, plane: PluginDataPlane, patch: Record<string, unknown>) => boolean;
    setSessionPeriId: (id: string, periId: string) => void;
    resolveSessionOwner: (sessionId: string, agentId: string) => Promise<boolean>;
    hydrateSessions: () => void | Promise<void>;
    /** I14-W6 CR-01：强制本地路径（导入/浏览器场景）——读取 localStorage 不经后端 */
    hydrateSessionsLocal: () => void;
    getUser: (source: string) => UserMapping | undefined;
    setAgents: (a: AgentEntry[]) => void;
    setActiveAgent: (id: string) => void;
}
export declare const useIdentityStore: import("zustand").UseBoundStore<import("zustand").StoreApi<IdentityStoreState>>;
/**
 * 等待全部身份写穿链落定（关闭前 flush / 测试收敛）；browser 模式为 no-op。
 * hydrateFromLocal 等路径的写穿是 fire-and-forget，调用方需要确定性落库时显式 flush。
 */
export declare function flushIdentityBackend(): Promise<void>;
/** 删除会话等外部后端事务完成后，刷新 sessions revision baseline。 */
export declare function refreshSessionsBackend(): Promise<void>;
