import { invoke } from '@tauri-apps/api/core'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { useRuntimeStore } from '../../runtimeStore'
import { applySessionModeChange, normalizeSessionMode } from './sessionModeState'

export function setSessionMode(source: string, nextMode: string): Promise<void> {
  const normalizedMode = normalizeSessionMode(nextMode)
  if (!source || !normalizedMode) return Promise.reject(new Error('无效的会话或权限模式'))
  const previousMode = useRuntimeStore.getState().sessionModes[source]
  return applySessionModeChange({
    source,
    nextMode: normalizedMode,
    previousMode,
    writeMode: mode => useRuntimeStore.getState().setSessionMode(source, mode),
    invokeSet: (targetSource, mode) => createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setMode({
      source: targetSource,
      mode,
    }),
  })
}
