import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { ShellRecipeRegistry } from './shellRecipeRegistry.ts'
import type { ShellRecipeContribution } from './shellRecipeTypes.ts'

export interface PluginShellRecipeApi {
  registerRecipe(contribution: ShellRecipeContribution): void
}

export function createPluginShellRecipeApi(
  registry: ShellRecipeRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<ShellRecipeContribution>,
): PluginShellRecipeApi {
  return {
    registerRecipe(contribution) {
      const registration = transaction
        ? transaction.register(contribution, { contributionId: contribution.id, priority: contribution.order })
        : registry.register(identity, contribution)
      try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
    },
  }
}
