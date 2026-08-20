import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import type { PluginUiSurface } from './pluginUiTypes.ts'

export class PluginUiRegistry {
  private readonly registry = new ReactiveRegistryStore<PluginUiSurface>()

  register(owner: PluginIdentity, surface: PluginUiSurface): AsyncDisposable {
    this.validate(surface)
    return this.registry.register(owner, Object.freeze({ ...surface }), {
      contributionId: surface.id,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<PluginUiSurface> {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      ...transaction,
      register: (surface, options) => {
        this.validate(surface)
        return transaction.register(Object.freeze({ ...surface }), {
          ...options,
          contributionId: surface.id,
        })
      },
    }
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  getSnapshot(): RegistrySnapshot<PluginUiSurface> {
    return this.registry.getSnapshot()
  }

  resolve(surfaceId: string) {
    return this.registry.getSnapshot().entries.find(entry => entry.value.id === surfaceId)
  }

  private validate(surface: PluginUiSurface): void {
    if (!surface.id) throw new Error('Plugin UI surface id 不能为空')
    if (!surface.reactVersion) throw new Error(`Plugin UI ${surface.id} 缺少 reactVersion`)
    if (typeof surface.mount !== 'function') throw new Error(`Plugin UI ${surface.id} 缺少 mount`)
  }
}
