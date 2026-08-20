import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type {
  PluginServiceContribution,
  PluginServiceKind,
  PluginServiceRegistry,
} from './pluginServiceRegistry.ts'

export interface PluginServiceApi {
  register<T>(kind: PluginServiceKind, id: string, value: T): void
}

export function createPluginServiceApi(
  registry: PluginServiceRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<PluginServiceContribution>,
): PluginServiceApi {
  return {
    register(kind, id, value) {
      const contribution = Object.freeze({ kind, id, value })
      scope.add(transaction
        ? transaction.register(contribution, { contributionId: `${kind}:${id}` })
        : registry.register(identity, contribution))
    },
  }
}
