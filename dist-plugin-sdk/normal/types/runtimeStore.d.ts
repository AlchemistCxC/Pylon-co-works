import type { ConfigOption } from './infrastructure/acp/chatContracts.js';
import { type SessionLiveStats } from './components/chat/sessionRuntime.js';
import { type AgentStatus, type SessionBindingSnapshot } from './components/settings/agentTypes.js';
import { type PermissionAction, type PermissionState } from './domains/permission/permissionState.js';
import { type ApprovalMode } from './domains/permission/approvalMode.js';
import type { AgentContext, AgentContextKey } from './agentContext.js';
export interface SessionConfig {
    model?: string;
    models?: string[];
    thinkingEffort?: string;
    context1m?: boolean;
    raw?: ConfigOption[];
}
/**
 * runtimeStore — 运行时状态域（阶段 1：store 按域拆分）。
 *
 * 承载：live 用量/生成源、每会话 live stats/modes/config、Agent 状态。
 * 不持久化（persist 域仅 themeStore）。
 * 跨域联动（会话删除清 runtime 等）由调用方（identityStore 组合 action）经 getState 触发。
 */
export interface LiveStatsPayload {
    liveGenerating?: string | null;
    liveGeneratingSources?: string[];
}
interface RuntimeStoreState {
    liveGenerating: string | null;
    liveGeneratingSources: string[];
    /** I01-W2：会话运行时状态一律按 AgentContextKey（agentId+source）隔离——双 Agent 同名 source 不共享 */
    sessionLiveStats: Record<AgentContextKey, SessionLiveStats>;
    sessionModes: Record<AgentContextKey, string>;
    sessionConfig: Record<AgentContextKey, SessionConfig>;
    agentStatuses: Record<string, AgentStatus>;
    /**
     * OWNER-04：每会话绑定建立时的 agent generation 快照（load_persisted_session /
     * new_session 成功时由 useSessionLifecycle 记录）。重连后 agentStatus.generation
     * 递增，bindingState.refineBindingGeneration 依此判定 binding_stale——
     * 旧 binding 必须 Invalidated，不能继续发送旧 remote id（§5.9 rule 4）。
     */
    bindingGenerations: Record<string, number | undefined>;
    /** Kernel continuity probe 的瞬态健康快照；不持久化、不替代 Session metadata。 */
    sessionBindingHealth: Record<AgentContextKey, SessionBindingSnapshot | undefined>;
    /**
     * CWD-03：会话原地 reload 令牌（rootPath 变更 → binding invalidate → close → load/new）。
     * useSessionLifecycle 以 [sessionId, reloadToken] 为 effect 依赖；令牌递增即强制
     * 同会话重跑 load 路径（读取已同步的新 workdir/workspaceId，InputBar 恢复）。
     */
    sessionReloadTokens: Record<string, number>;
    /** 权限请求状态（非持久化；P0-02 controller 经 setPermission 驱动纯 reducer） */
    permission: PermissionState;
    setPermission: (action: PermissionAction) => void;
    /** 全局审批模式（P0-04，set_approval_mode；非持久化，默认 default） */
    approvalMode: ApprovalMode;
    setApprovalMode: (mode: string) => void;
    setLiveStats: (stats: Partial<LiveStatsPayload>) => void;
    setSessionLiveStats: (context: AgentContext, stats: Partial<SessionLiveStats>) => void;
    clearSessionRuntime: (context: AgentContext) => void;
    setSessionMode: (context: AgentContext, mode?: string) => void;
    setSessionConfig: (context: AgentContext, cfg: Partial<SessionConfig>) => void;
    setAgentStatus: (id: string, status: AgentStatus) => void;
    /** OWNER-04：记录会话绑定建立时的 agent generation（undefined = 清除记录） */
    setBindingGeneration: (context: AgentContext, generation: number | undefined) => void;
    /** CWD-03：递增会话 reload 令牌（rootPath 变更触发同会话原地重载） */
    bumpSessionReload: (context: AgentContext) => void;
    /** 会话删除：清该 context 的全部 runtime 状态（identityStore.removeSession 联动调用） */
    clearSessionSource: (context: AgentContext) => void;
    /** Agent 切换成功：只清会话运行时状态，保留 agentStatuses 供末尾快照对账。 */
    resetSessionRuntime: () => void;
    /** @deprecated 使用 resetSessionRuntime；保留兼容入口但不清 agentStatuses。 */
    resetAll: () => void;
}
export declare const useRuntimeStore: import("zustand").UseBoundStore<import("zustand").StoreApi<RuntimeStoreState>>;
export {};
