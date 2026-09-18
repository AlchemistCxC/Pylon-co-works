import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { PresetRegistry } from './presetRegistry.ts'
import type { PresetContribution } from './presetTypes.ts'
import type { AsyncDisposable, RegistryTransaction } from '../registry/types.ts'

export interface PluginPresetApi {
  registerPreset(contribution: PresetContribution): AsyncDisposable
}

export function createPluginPresetApi(
  registry: PresetRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<PresetContribution>,
): PluginPresetApi {
  return {
    registerPreset(contribution) {
      const disposable = transaction
        ? transaction.register(contribution, { contributionId: contribution.id })
        : registry.register(identity, contribution)
      scope.add(disposable)
      return disposable
    },
  }
}
