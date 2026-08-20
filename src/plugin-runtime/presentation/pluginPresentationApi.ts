import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { PresentationProfileRegistry } from './presentationProfileRegistry.ts'
import type { PresentationProfileContribution } from './presentationProfileTypes.ts'

export interface PluginPresentationApi {
  registerProfile(contribution: PresentationProfileContribution): void
}

export function createPluginPresentationApi(
  registry: PresentationProfileRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<PresentationProfileContribution>,
): PluginPresentationApi {
  return {
    registerProfile(contribution) {
      const registration = transaction
        ? transaction.register(contribution, { contributionId: contribution.id, priority: contribution.order })
        : registry.register(identity, contribution)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
  }
}

