import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { PluginUiRegistry } from './pluginUiRegistry.ts'
import type { PluginUiSurface } from './pluginUiTypes.ts'

export interface PluginUiApi {
  registerSurface(surface: PluginUiSurface): void
}

export function createPluginUiApi(
  registry: PluginUiRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<PluginUiSurface>,
): PluginUiApi {
  return {
    registerSurface(surface) {
      scope.add(transaction
        ? transaction.register(surface, { contributionId: surface.id })
        : registry.register(identity, surface))
    },
  }
}
