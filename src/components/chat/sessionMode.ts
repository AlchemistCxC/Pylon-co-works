import { tauriInvokeTransport } from '../../infrastructure/acp/tauriTransport.ts'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { useRuntimeStore } from '../../runtimeStore'
import { applySessionModeChange, normalizeSessionMode } from './sessionModeState'
import type { AgentContext } from '../../domains/agent/agentContext'
import { toAgentContextKey } from '../../domains/agent/agentContext'

export function setSessionMode(context: AgentContext, nextMode: string): Promise<void> {
  const normalizedMode = normalizeSessionMode(nextMode)
  if (!context.source || !normalizedMode) return Promise.reject(new Error('无效的会话或权限模式'))
  const previousMode = useRuntimeStore.getState().sessionModes[toAgentContextKey(context)]
  return applySessionModeChange({
    source: context.source,
    nextMode: normalizedMode,
    previousMode,
    writeMode: mode => useRuntimeStore.getState().setSessionMode(context, mode),
    invokeSet: (targetSource, mode) => createChatClient({ invoke: tauriInvokeTransport }).setMode({
      // OWNER-02：Session owner 显式 agentId（从 AgentContext 读取）。
      agentId: context.agentId,
      source: targetSource,
      mode,
    }),
  })
}
