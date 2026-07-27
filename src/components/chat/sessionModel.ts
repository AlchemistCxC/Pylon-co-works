import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import { applySessionModelChange } from './sessionModelState'

export function setSessionModel(source: string, nextModel: string): Promise<void> {
  const store = useStore.getState()
  const previousModel = store.sessionConfig[source]?.model
  return applySessionModelChange({
    source,
    nextModel,
    previousModel,
    writeModel: model => useStore.getState().setSessionConfig(source, { model }),
    invokeSet: (targetSource, model) => invoke('set_config_option', {
      source: targetSource,
      key: 'model',
      value: model,
    }),
  })
}
