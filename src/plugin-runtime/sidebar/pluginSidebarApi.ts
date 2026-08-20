import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { AgentSidebarRegistry } from './sidebarRegistry.ts'
import type { AgentSidebarContribution } from './sidebarTypes.ts'

export interface PluginSidebarApi {
  registerAgentSidebarContribution(contribution: AgentSidebarContribution): void
}

export function createPluginSidebarApi(
  registry: AgentSidebarRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<AgentSidebarContribution>,
): PluginSidebarApi {
  return {
    registerAgentSidebarContribution(contribution) {
      const registration = transaction
        ? transaction.register(Object.freeze({ ...contribution }), { contributionId: contribution.id, priority: contribution.order })
        : registry.register(identity, contribution)
      try {
        scope.add(registration)
      } catch (error) {
        void registration.dispose()
        throw error
      }
    },
  }
}
