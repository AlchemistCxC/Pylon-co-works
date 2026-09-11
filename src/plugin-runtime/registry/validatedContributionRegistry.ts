import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from './reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from './types.ts'

/** Registry for contributions whose validated value owns its identity and ordering. */
export class ValidatedContributionRegistry<T extends { readonly id: string; readonly order?: number }> {
  private readonly registry = new ReactiveRegistryStore<T>()
  private readonly validateContribution: (contribution: T) => T

  constructor(validateContribution: (contribution: T) => T) {
    this.validateContribution = validateContribution
  }

  register(owner: PluginIdentity, contribution: T): AsyncDisposable {
    const normalized = this.validateContribution(contribution)
    return this.registry.register(owner, normalized, {
      contributionId: normalized.id,
      priority: normalized.order,
    })
  }

  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<T> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (contribution, options) => {
        const normalized = this.validateContribution(contribution)
        return transaction.register(normalized, {
          ...options,
          contributionId: normalized.id,
          priority: normalized.order,
        })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<T> { return this.registry.getSnapshot() }
  resolve(id: string) { return this.registry.getSnapshot().entries.find(entry => entry.contributionId === id) }
}
