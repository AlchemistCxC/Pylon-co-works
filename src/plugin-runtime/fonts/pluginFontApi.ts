import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { FontContribution } from './fontContributionTypes.ts'
import type { FontContributionRegistry } from './fontContributionRegistry.ts'

export interface PluginFontApi {
  registerFont(contribution: FontContribution): void
}

export function createPluginFontApi(
  registry: FontContributionRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<FontContribution>,
): PluginFontApi {
  return {
    registerFont(contribution) {
      const registration = transaction
        ? transaction.register(contribution, { contributionId: contribution.id, priority: contribution.order })
        : registry.register(identity, contribution)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
  }
}

