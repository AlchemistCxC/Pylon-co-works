import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'
import { resolvePluginUiRuntime, type PluginUiSurface } from './pluginUiTypes.ts'

export class PluginUiRegistry {
  private readonly registry = new ReactiveRegistryStore<PluginUiSurface>()

  register(owner: PluginIdentity, surface: PluginUiSurface): AsyncDisposable {
    const normalized = this.normalize(surface)
    return this.registry.register(owner, normalized, {
      contributionId: normalized.id,
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
        const normalized = this.normalize(surface)
        return transaction.register(normalized, {
          ...options,
          contributionId: normalized.id,
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

  private normalize(surface: PluginUiSurface): PluginUiSurface {
    if (!surface.id) throw new Error('Plugin UI surface id 不能为空')
    if (typeof surface.mount !== 'function') throw new Error(`Plugin UI ${surface.id} 缺少 mount`)
    const resolution = resolvePluginUiRuntime(surface)
    return Object.freeze({
      ...surface,
      runtime: resolution.runtime,
      ...(surface.reactVersion ? { reactVersion: surface.reactVersion } : {}),
    })
  }
}
