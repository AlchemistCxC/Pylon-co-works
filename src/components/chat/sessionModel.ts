import { invoke } from '@tauri-apps/api/core'
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
    invokeSet: (targetSource, model) => invoke('set_config_option', {
      source: targetSource,
      key: 'model',
      value: model,
    }),
  })
}
