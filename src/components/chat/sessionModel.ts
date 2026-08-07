import { invoke } from '@tauri-apps/api/core'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { useRuntimeStore } from '../../runtimeStore'
import { applySessionModelChange } from './sessionModelState'

export function setSessionModel(source: string, nextModel: string): Promise<void> {
  const store = useRuntimeStore.getState()
  const previousModel = store.sessionConfig[source]?.model
  return applySessionModelChange({
    source,
    nextModel,
    previousModel,
    writeModel: model => useRuntimeStore.getState().setSessionConfig(source, { model }),
    invokeSet: (targetSource, model) => createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setConfigOption({
      source: targetSource,
      key: 'model',
      value: model,
    }),
  })
}
