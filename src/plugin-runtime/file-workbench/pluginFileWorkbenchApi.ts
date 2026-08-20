import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { RegistryTransaction } from '../registry/types.ts'
import type { FileWorkbenchRegistry } from './fileWorkbenchRegistry.ts'
import type { FileWorkbenchContribution } from './fileWorkbenchTypes.ts'

export interface PluginFileWorkbenchApi { register(contribution: FileWorkbenchContribution): void }

export function createPluginFileWorkbenchApi(registry: FileWorkbenchRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: RegistryTransaction<FileWorkbenchContribution>): PluginFileWorkbenchApi {
  return { register(contribution) {
    const registration = transaction
      ? transaction.register(Object.freeze(contribution), { contributionId: contribution.id, priority: 'priority' in contribution ? contribution.priority : contribution.order })
      : registry.register(identity, contribution)
    try { scope.add(registration) } catch (error) { void registration.dispose(); throw error }
  } }
}
