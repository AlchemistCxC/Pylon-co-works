import { registerPluginSessionDataPort } from '../../plugin-runtime/sessionData/sessionDataPort.ts'
import type { IdentityStoreAccessor } from './identityStoreShape.ts'

/**
 * identityPluginDataPort — 插件会话数据端口注册（B-8a 自 identityStore 拆出，逐字随迁）。
 * 插件经 scope-bound API 读写会话/turn 的 metadata/context 命名空间；真值仍归 store。
 */
export function installIdentityPluginDataPort(store: IdentityStoreAccessor): void {
  registerPluginSessionDataPort({
    getSessionNamespace: (sessionId, pluginId, plane) => {
      const session = store.get().sessions.find(candidate => candidate.id === sessionId)
      return (plane === 'metadata' ? session?.metadata : session?.context)?.[pluginId]
    },
    setSessionNamespace: (sessionId, pluginId, plane, patch) => (
      store.get().updateSessionPluginData(sessionId, pluginId, plane, patch)
    ),
    ensureTurn: turn => store.get().ensureTurn(turn),
    getTurnNamespace: (turnId, pluginId, plane) => {
      const turn = store.get().turns.find(candidate => candidate.id === turnId)
      return (plane === 'metadata' ? turn?.metadata : turn?.context)?.[pluginId]
    },
    setTurnNamespace: (turnId, pluginId, plane, patch) => (
      store.get().updateTurnPluginData(turnId, pluginId, plane, patch)
    ),
  })
}
