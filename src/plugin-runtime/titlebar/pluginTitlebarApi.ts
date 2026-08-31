import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegisterOptions, AsyncDisposable, RegistryTransaction } from '../registry/types.ts'
import type { TitlebarContribution } from './titlebarTypes.ts'
import type { TitlebarRegistry } from './titlebarRegistry.ts'

export interface PluginTitlebarApi {
  register(contribution: TitlebarContribution, options: Omit<RegisterOptions, 'contributionId'> & { contributionId?: string }): AsyncDisposable
}

export function createPluginTitlebarApi(
  registry: TitlebarRegistry,
  identity: PluginIdentity,
  _scope: PluginScope,
  transaction?: RegistryTransaction<TitlebarContribution>,
): PluginTitlebarApi {
  return {
    register: (contribution, options) => {
      const contributionId = options.contributionId ?? contribution.id
      if (transaction) return transaction.register(contribution, { ...options, contributionId })
      return registry.register(identity, contribution, { ...options, contributionId })
    },
  }
}
