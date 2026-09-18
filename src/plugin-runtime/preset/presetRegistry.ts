import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { PresetContribution } from './presetTypes.ts'

function normalize(contribution: PresetContribution): PresetContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) throw new Error('Preset id 不能为空')
  if (!contribution.label || !contribution.label.trim()) throw new Error(`Preset label 不能为空：${contribution.id}`)
  return Object.freeze({
    ...contribution,
    payload: Object.freeze({ ...contribution.payload }),
  })
}

export class PresetRegistry {
  private readonly registry = new ReactiveRegistryStore<PresetContribution>()

  register(owner: PluginIdentity, contribution: PresetContribution): AsyncDisposable {
    const normalized = normalize(contribution)
    return this.registry.register(owner, normalized, { contributionId: normalized.id })
  }

  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<PresetContribution> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (contribution, options) => {
        const normalized = normalize(contribution)
        return transaction.register(normalized, { ...options, contributionId: normalized.id })
      },
    }
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<PresetContribution> { return this.registry.getSnapshot() }
  resolve(id: string) { return this.registry.getSnapshot().entries.find(entry => entry.value.id === id) }
  shadow(owner: PluginIdentity, replacingRuntimeInstanceId: string) {
    return this.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }
}
