import { invoke } from '@tauri-apps/api/core'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { useRuntimeStore } from '../../runtimeStore'
import { applySessionModelChange } from './sessionModelState'
import type { AgentContext } from '../../agentContext'
import { toAgentContextKey } from '../../agentContext'

export function setSessionModel(context: AgentContext, nextModel: string): Promise<void> {
  const store = useRuntimeStore.getState()
  const previousModel = store.sessionConfig[toAgentContextKey(context)]?.model
  return applySessionModelChange({
    source: context.source,
    nextModel,
    previousModel,
    writeModel: model => useRuntimeStore.getState().setSessionConfig(context, { model }),
    invokeSet: (targetSource, model) => createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setConfigOption({
      // OWNER-02：Session owner 显式 agentId（从 AgentContext 读取）。
      agentId: context.agentId,
      source: targetSource,
      key: 'model',
      value: model,
    }),
  })
}
