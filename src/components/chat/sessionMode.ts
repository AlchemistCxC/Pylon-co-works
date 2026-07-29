import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import { applySessionModeChange, normalizeSessionMode } from './sessionModeState'

export function setSessionMode(source: string, nextMode: string): Promise<void> {
  const normalizedMode = normalizeSessionMode(nextMode)
  if (!source || !normalizedMode) return Promise.reject(new Error('无效的会话或权限模式'))
  const previousMode = useStore.getState().sessionModes[source]
  return applySessionModeChange({
    source,
    nextMode: normalizedMode,
    previousMode,
    writeMode: mode => useStore.getState().setSessionMode(source, mode),
    invokeSet: (targetSource, mode) => invoke('set_mode', {
      source: targetSource,
      mode,
    }),
  })
}
