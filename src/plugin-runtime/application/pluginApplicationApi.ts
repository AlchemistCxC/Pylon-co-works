import type {
  ApplicationContribution,
  ApplicationRegistryTransaction,
  ApplicationRuntime,
} from '../../kernel/applicationRuntime.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'

export interface PluginApplicationApi {
  register(contribution: ApplicationContribution): ReturnType<ApplicationRuntime['register']>
}

export function createPluginApplicationApi(
  runtime: ApplicationRuntime,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: ApplicationRegistryTransaction,
): PluginApplicationApi {
  return {
    register: contribution => scope.add(transaction
      ? transaction.register(contribution)
      : runtime.register(identity, contribution)),
  }
}
