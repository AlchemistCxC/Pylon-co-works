import { create } from 'zustand'
import type { ConfigOption } from './components/chat/acpTypes'
import { clearSessionSourceState, updateSessionLiveStats, type SessionLiveStats } from './components/chat/sessionRuntime'
import type { AgentStatus } from './components/settings/agentTypes'

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

export interface LiveStatsPayload {
  liveTokensUsed?: number
  liveTokensMax?: number
  liveCacheReadTokens?: number
  liveMode?: string
  livePrismOn?: boolean
  liveGenerating?: string | null
  liveGeneratingSources?: string[]
  liveCommands?: { name: string; input_hint?: string; description?: string }[]
}

interface RuntimeStoreState {
  liveTokensUsed: number
  liveTokensMax: number
  liveCacheReadTokens: number
  liveMode: string
  livePrismOn: boolean
  liveGenerating: string | null
  liveGeneratingSources: string[]
  sessionLiveStats: Record<string, SessionLiveStats>
  sessionModes: Record<string, string>
  sessionConfig: Record<string, SessionConfig>
  liveCommands: { name: string; input_hint?: string; description?: string }[]
  agentStatuses: Record<string, AgentStatus>
  setLiveStats: (stats: Partial<LiveStatsPayload>) => void
  setSessionLiveStats: (source: string, stats: Partial<SessionLiveStats>) => void
  clearSessionRuntime: (source: string) => void
  setSessionMode: (source: string, mode?: string) => void
  setSessionConfig: (source: string, cfg: Partial<SessionConfig>) => void
  setAgentStatus: (id: string, status: AgentStatus) => void
  /** 会话删除：清该 source 的全部 runtime 状态（identityStore.removeSession 联动调用） */
  clearSessionSource: (source: string) => void
  /** Agent 切换成功：清空全部运行时状态（Settings.switchAgent 联动调用） */
  resetAll: () => void
}

export const useRuntimeStore = create<RuntimeStoreState>()((set, get) => ({
  liveTokensUsed: 0,
  liveTokensMax: 131072,
  liveCacheReadTokens: 0,
  liveMode: 'auto',
  livePrismOn: true,
  liveGenerating: null,
  liveGeneratingSources: [],
  sessionLiveStats: {},
  sessionModes: {},
  sessionConfig: {},
  liveCommands: [],
  agentStatuses: {},

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
  setAgentStatus: (id, status) => set(state => ({ agentStatuses: { ...state.agentStatuses, [id]: status } })),
  clearSessionSource: (source) => get().clearSessionRuntime(source),
  resetAll: () => set({
    sessionConfig: {},
    sessionModes: {},
    sessionLiveStats: {},
    liveGenerating: null,
    liveGeneratingSources: [],
    agentStatuses: {},
  }),
}))
