import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { CcWidgetRegistry } from './ccWidgetRegistry.ts'
import type { CcWidgetContribution } from './ccWidgetTypes.ts'
import type { AsyncDisposable, RegistryTransaction } from '../registry/types.ts'

export interface PluginCcWidgetApi {
  registerWidget(contribution: CcWidgetContribution): AsyncDisposable
}

export function createPluginCcWidgetApi(
  registry: CcWidgetRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: RegistryTransaction<CcWidgetContribution>,
): PluginCcWidgetApi {
  return {
    registerWidget(contribution) {
      const disposable = transaction
        ? transaction.register(contribution, { contributionId: contribution.id })
        : registry.register(identity, contribution)
      scope.add(disposable)
      return disposable
    },
  }
}
