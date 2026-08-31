import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { RegisterOptions, RegistrySnapshot, AsyncDisposable } from '../registry/types.ts'
import type { TitlebarContribution } from './titlebarTypes.ts'

/** Reactive registry for application-shell titlebar contributions. */
export class TitlebarRegistry {
  private readonly registry = new ReactiveRegistryStore<TitlebarContribution>()

  register(owner: PluginIdentity, contribution: TitlebarContribution, options: RegisterOptions): AsyncDisposable {
    return this.registry.register(owner, contribution, options)
  }

  subscribe(listener: () => void): () => void { return this.registry.subscribe(listener) }
  getSnapshot(): RegistrySnapshot<TitlebarContribution> { return this.registry.getSnapshot() }
  beginTransaction(owner: PluginIdentity) { return this.registry.beginTransaction(owner) }
  beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string) {
    return this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }
}
