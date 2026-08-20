import { invoke } from '@tauri-apps/api/core'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { useRuntimeStore } from '../../runtimeStore'
import { applySessionModeChange, normalizeSessionMode } from './sessionModeState'
import type { AgentContext } from '../../agentContext'
import { toAgentContextKey } from '../../agentContext'

export function setSessionMode(context: AgentContext, nextMode: string): Promise<void> {
  const normalizedMode = normalizeSessionMode(nextMode)
  if (!context.source || !normalizedMode) return Promise.reject(new Error('无效的会话或权限模式'))
  const previousMode = useRuntimeStore.getState().sessionModes[toAgentContextKey(context)]
  return applySessionModeChange({
    source: context.source,
    nextMode: normalizedMode,
    previousMode,
    writeMode: mode => useRuntimeStore.getState().setSessionMode(context, mode),
    invokeSet: (targetSource, mode) => createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setMode({
      // OWNER-02：Session owner 显式 agentId（从 AgentContext 读取）。
      agentId: context.agentId,
      source: targetSource,
      mode,
    }),
  })
}
