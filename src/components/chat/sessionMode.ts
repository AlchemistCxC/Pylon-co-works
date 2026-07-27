import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import { applySessionModeChange } from './sessionModeState'

export function setSessionMode(source: string, nextMode: string): Promise<void> {
  const previousMode = useStore.getState().sessionModes[source]
  return applySessionModeChange({
    source,
    nextMode,
    previousMode,
    writeMode: mode => useStore.getState().setSessionMode(source, mode),
    invokeSet: (targetSource, mode) => invoke('set_mode', {
      source: targetSource,
      mode,
    }),
  })
}
