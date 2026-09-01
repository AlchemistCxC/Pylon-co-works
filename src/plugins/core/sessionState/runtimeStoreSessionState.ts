/**
 * core.sessionState.runtimeStore —— 内置会话状态同步 provider。
 *
 * 把 new_session / load_persisted_session 响应与 live session_update 写入
 * runtimeStore 的逻辑从 useSessionLifecycle / chatEventController 收口到本插件。
 * 由产品 agent-adapters 插件登记进 owner-aware Plugin Service Registry。
 */
import {
  type SessionStateSyncProvider,
} from '../../../contracts/sessionStateSync.ts'
import { useRuntimeStore } from '../../../runtimeStore.ts'
import {
  extractConfigOptionId,
  extractConfigOptionValue,
  extractModelConfig,
  extractSessionUsage,
  extractUsage,
  type SessionResponseObject,
  type SessionUpdate,
} from '../../../infrastructure/acp/chatContracts.ts'
import type { AgentContext } from '../../../agentContext.ts'

export const CORE_SESSION_STATE_SYNC_PLUGIN_ID = 'core.sessionState.runtimeStore'

export const BUILTIN_SESSION_STATE_SYNC_PROVIDER: SessionStateSyncProvider = {
  providerId: CORE_SESSION_STATE_SYNC_PLUGIN_ID,
  applyResponse(context, response) {
    const ctx = context as AgentContext
    const res = response as SessionResponseObject
    const cfg = extractModelConfig(res.configOptions, res)
    // A new/load response may advertise choices needed by the compatibility UI,
    // but current model/mode/usage are journal-owned facts. Restoring those here
    // would create a second recovery authority beside canonical_events.
    if (cfg.models) useRuntimeStore.getState().setSessionConfig(ctx, { models: cfg.models })
  },
  applyUpdate(context, update) {
    const ctx = context as AgentContext
    switch (update.kind) {
      case 'usage_update': {
        const usage = extractUsage(update.payload as Extract<SessionUpdate, { sessionUpdate: 'usage_update' }>)
        useRuntimeStore.getState().setSessionLiveStats(ctx, usage)
        break
      }
      case 'session_info_update': {
        const upd = update.payload as Extract<SessionUpdate, { sessionUpdate: 'session_info_update' }>
        const currentMode = upd.mode ?? upd.currentMode ?? upd.sessionInfo?.mode ?? upd.sessionInfo?.currentMode
        if (currentMode != null) useRuntimeStore.getState().setSessionMode(ctx, String(currentMode))
        const usage = extractSessionUsage({ usage: upd.usage, sessionInfo: upd.sessionInfo })
        if (usage) useRuntimeStore.getState().setSessionLiveStats(ctx, usage)
        break
      }
      case 'available_commands_update': {
        const upd = update.payload as Extract<SessionUpdate, { sessionUpdate: 'available_commands_update' }>
        useRuntimeStore.getState().setSessionLiveStats(ctx, { commands: upd.commands || [] })
        break
      }
      case 'config_option_update': {
        const upd = update.payload as Extract<SessionUpdate, { sessionUpdate: 'config_option_update' }>
        if (Array.isArray(upd.configOptions)) {
          const cfg = extractModelConfig(upd.configOptions)
          if (cfg.model || cfg.models) useRuntimeStore.getState().setSessionConfig(ctx, { ...cfg, raw: upd.configOptions })
          const modeOption = upd.configOptions.find(option => {
            const id = extractConfigOptionId(option)
            return id?.replace(/[-\s]+/g, '_').toLowerCase() === 'mode'
          })
          const mode = extractConfigOptionValue(modeOption)
          if (mode != null) useRuntimeStore.getState().setSessionMode(ctx, String(mode))
        } else {
          const key = extractConfigOptionId(upd)
          const val = extractConfigOptionValue(upd)
          if (key?.replace(/[-\s]+/g, '_').toLowerCase() === 'model' && val != null) useRuntimeStore.getState().setSessionConfig(ctx, { model: String(val) })
          if (key?.replace(/[-\s]+/g, '_').toLowerCase() === 'mode' && val != null) useRuntimeStore.getState().setSessionMode(ctx, String(val))
        }
        break
      }
      default:
        break
    }
  },
}
