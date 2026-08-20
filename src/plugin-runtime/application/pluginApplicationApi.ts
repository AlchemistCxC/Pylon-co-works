import type {
  PluginApplicationContribution,
  PluginApplicationHost,
  PluginApplicationRegistryTransaction,
} from './applicationHost.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'

export interface PluginApplicationApi {
  register(contribution: PluginApplicationContribution): ReturnType<PluginApplicationHost['register']>
}

export function createPluginApplicationApi(
  runtime: PluginApplicationHost,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: PluginApplicationRegistryTransaction,
): PluginApplicationApi {
  return {
    register: contribution => scope.add(transaction
      ? transaction.register(contribution)
      : runtime.register(identity, contribution)),
  }
}
