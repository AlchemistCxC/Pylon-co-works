import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { CcWidgetContribution } from './ccWidgetTypes.ts'

function normalize(contribution: CcWidgetContribution): CcWidgetContribution {
  if (!contribution.id || contribution.id !== contribution.id.trim()) throw new Error('Cc widget id 不能为空')
  if (!contribution.label || !contribution.label.trim()) throw new Error(`Cc widget label 不能为空：${contribution.id}`)
  if (contribution.render) {
    if (contribution.render.kind === 'host-renderer' && (typeof contribution.render.rendererKey !== 'string' || !contribution.render.rendererKey.trim())) {
      throw new Error(`Cc widget rendererKey 不能为空：${contribution.id}`)
    }
    if (contribution.render.kind === 'isolated-surface' && (typeof contribution.render.surfaceId !== 'string' || !contribution.render.surfaceId.trim())) {
      throw new Error(`Cc widget surfaceId 不能为空：${contribution.id}`)
    }
    if (contribution.render.kind !== 'host-renderer' && contribution.render.kind !== 'isolated-surface') {
      throw new Error(`Cc widget render 非法：${contribution.id}`)
    }
  }
  return Object.freeze({
    ...contribution,
    ...(contribution.propertyFields ? { propertyFields: Object.freeze([...contribution.propertyFields]) } : {}),
    ...(contribution.defaultPlacement ? { defaultPlacement: Object.freeze({ ...contribution.defaultPlacement }) } : {}),
  })
}

export class CcWidgetRegistry {
  private readonly registry = new ReactiveRegistryStore<CcWidgetContribution>()

  register(owner: PluginIdentity, contribution: CcWidgetContribution): AsyncDisposable {
    const normalized = normalize(contribution)
    return this.registry.register(owner, normalized, { contributionId: normalized.id })
  }

  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): RegistryTransaction<CcWidgetContribution> {
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
  getSnapshot(): RegistrySnapshot<CcWidgetContribution> { return this.registry.getSnapshot() }
  resolve(id: string) { return this.registry.getSnapshot().entries.find(entry => entry.value.id === id) }
  shadow(owner: PluginIdentity, replacingRuntimeInstanceId: string) {
    return this.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }
}
