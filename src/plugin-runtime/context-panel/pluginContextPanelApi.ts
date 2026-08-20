import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { ContextPanelRegistry } from './contextPanelRegistry.ts'
import type { ContextPanelContribution } from './contextPanelTypes.ts'

export interface PluginContextPanelApi {
  register(contribution: ContextPanelContribution): void
}

export function createPluginContextPanelApi(
  registry: ContextPanelRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<ContextPanelContribution>,
): PluginContextPanelApi {
  return {
    register(contribution) {
      const registration = transaction
        ? transaction.register(Object.freeze({ ...contribution }), { contributionId: contribution.id, priority: contribution.order })
        : registry.register(identity, contribution)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
  }
}
