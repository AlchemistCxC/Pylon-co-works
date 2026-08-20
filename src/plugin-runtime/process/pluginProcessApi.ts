import type { PluginProcessClient } from '../../infrastructure/plugins/pluginProcessClient.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { PluginProcessApi } from './processTypes.ts'

/** Process handles are transaction resources: rollback/deactivate drains them in LIFO order. */
export function createPluginProcessApi(
  identity: PluginIdentity,
  scope: PluginScope,
  client: PluginProcessClient,
): PluginProcessApi {
  return {
    async spawn(executableId, options) {
      if (scope.isDisposed) throw new Error(`PluginScope 已释放：${scope.ownerKey}`)
      const handle = await client.spawn(
        identity.pluginId,
        identity.key,
        executableId,
        options,
        identity.version === 'builtin' ? undefined : identity.packageInstanceId,
      )
      try {
        return scope.add(handle)
      } catch (error) {
        await handle.dispose()
        throw error
      }
    },
    list: () => client.list(identity.key),
  }
}
