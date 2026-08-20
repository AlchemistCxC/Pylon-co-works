import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { InterfaceModeRegistry } from './interfaceModeRegistry.ts'
import type { InterfaceModeContribution } from './interfaceModeTypes.ts'

export interface PluginInterfaceModeApi {
  registerMode(contribution: InterfaceModeContribution): void
}

export function createPluginInterfaceModeApi(
  registry: InterfaceModeRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<InterfaceModeContribution>,
): PluginInterfaceModeApi {
  return {
    registerMode(contribution) {
      const registration = transaction
        ? transaction.register(contribution, { contributionId: contribution.id, priority: contribution.order })
        : registry.register(identity, contribution)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
  }
}

