import { create } from 'zustand'
import type { ConfigOption } from './infrastructure/acp/chatContracts'
import { clearSessionSourceState, updateSessionLiveStats, type SessionLiveStats } from './components/chat/sessionRuntime'
import { shouldAcceptAgentStatus, type AgentStatus } from './components/settings/agentTypes'
import { permissionReducer, EMPTY_PERMISSION_STATE, type PermissionAction, type PermissionState } from './domains/permission/permissionState'
import { normalizeApprovalMode, type ApprovalMode } from './domains/permission/approvalMode'

// 后端配置选项（来自 new_session 返回 & config_option_update 事件）
export interface SessionConfig {
  model?: string           // 当前 model 值
  models?: string[]        // 可选 model 列表
  thinkingEffort?: string
  context1m?: boolean
  raw?: ConfigOption[]     // 原始 configOptions（兜底/调试）
}

/**
 * runtimeStore — 运行时状态域（阶段 1：store 按域拆分）。
 *
 * 承载：live 用量/生成源、每会话 live stats/modes/config、Agent 状态。
 * 不持久化（persist 域仅 themeStore）。
 * 跨域联动（会话删除清 runtime 等）由调用方（identityStore 组合 action）经 getState 触发。
 */

// EG：顶层 live* 死镜像清理——用量/模式/命令数据一律走 session 作用域
// （sessionLiveStats/sessionModes/sessionConfig），顶层只保留生成源（InputBar 取消用）
export interface LiveStatsPayload {
  liveGenerating?: string | null
  liveGeneratingSources?: string[]
}

interface RuntimeStoreState {
  liveGenerating: string | null
  liveGeneratingSources: string[]
  sessionLiveStats: Record<string, SessionLiveStats>
  sessionModes: Record<string, string>
  sessionConfig: Record<string, SessionConfig>
  agentStatuses: Record<string, AgentStatus>
  /** 权限请求状态（非持久化；P0-02 controller 经 setPermission 驱动纯 reducer） */
  permission: PermissionState
  setPermission: (action: PermissionAction) => void
  /** 全局审批模式（P0-04，set_approval_mode；非持久化，默认 default） */
  approvalMode: ApprovalMode
  setApprovalMode: (mode: string) => void
  setLiveStats: (stats: Partial<LiveStatsPayload>) => void
  setSessionLiveStats: (source: string, stats: Partial<SessionLiveStats>) => void
  clearSessionRuntime: (source: string) => void
  setSessionMode: (source: string, mode?: string) => void
  setSessionConfig: (source: string, cfg: Partial<SessionConfig>) => void
  setAgentStatus: (id: string, status: AgentStatus) => void
  /** 会话删除：清该 source 的全部 runtime 状态（identityStore.removeSession 联动调用） */
  clearSessionSource: (source: string) => void
  /** Agent 切换成功：只清会话运行时状态，保留 agentStatuses 供末尾快照对账。 */
  resetSessionRuntime: () => void
  /** @deprecated 使用 resetSessionRuntime；保留兼容入口但不清 agentStatuses。 */
  resetAll: () => void
}

export const useRuntimeStore = create<RuntimeStoreState>()((set, get) => ({
  liveGenerating: null,
  liveGeneratingSources: [],
  sessionLiveStats: {},
  sessionModes: {},
  sessionConfig: {},
  agentStatuses: {},
  permission: EMPTY_PERMISSION_STATE,
  approvalMode: 'default',

  setPermission: (action) => set(state => ({ permission: permissionReducer(state.permission, action) })),
  setApprovalMode: (mode) => set(state => ({
    approvalMode: normalizeApprovalMode(mode) || state.approvalMode,
  })),
  setLiveStats: (stats) => set(stats as Partial<RuntimeStoreState>),
  setSessionLiveStats: (source, stats) => set(state => ({
    sessionLiveStats: updateSessionLiveStats(state.sessionLiveStats, source, stats),
  })),
  clearSessionRuntime: (source) => set(state => {
    const cleared = clearSessionSourceState({
      source,
      sessionLiveStats: state.sessionLiveStats,
      sessionModes: state.sessionModes,
      sessionConfig: state.sessionConfig,
      generatingSources: state.liveGeneratingSources,
    })
    return {
      sessionLiveStats: cleared.sessionLiveStats,
      sessionModes: cleared.sessionModes,
      sessionConfig: cleared.sessionConfig,
      liveGeneratingSources: cleared.generatingSources,
      liveGenerating: cleared.generatingSources[cleared.generatingSources.length - 1] || null,
    }
  }),
  setSessionMode: (source, mode) => set(state => {
    const sessionModes = { ...state.sessionModes }
    if (mode) sessionModes[source] = mode
    else delete sessionModes[source]
    return { sessionModes }
  }),
  setSessionConfig: (source, cfg) => set(s => ({
    sessionConfig: { ...s.sessionConfig, [source]: { ...s.sessionConfig[source], ...cfg } },
  })),
  setAgentStatus: (id, status) => set(state => {
    if (!shouldAcceptAgentStatus(state.agentStatuses[id], status)) return state
    return { agentStatuses: { ...state.agentStatuses, [id]: status } }
  }),
  clearSessionSource: (source) => get().clearSessionRuntime(source),
  resetSessionRuntime: () => set({
    sessionConfig: {},
    sessionModes: {},
    sessionLiveStats: {},
    liveGenerating: null,
    liveGeneratingSources: [],
    permission: EMPTY_PERMISSION_STATE,
    approvalMode: 'default',
  }),
  resetAll: () => get().resetSessionRuntime(),
}))
