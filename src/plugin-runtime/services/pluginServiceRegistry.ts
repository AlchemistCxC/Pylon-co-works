import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot, RegistryTransaction } from '../registry/types.ts'

export type PluginServiceKind = 'search' | 'export' | 'event-projector' | 'session-state' | 'agent-detector'

export interface PluginServiceContribution<T = unknown> {
  readonly kind: PluginServiceKind
  readonly id: string
  readonly value: T
}

export class PluginServiceRegistry {
  private readonly registry = new ReactiveRegistryStore<PluginServiceContribution>()

  register<T>(identity: PluginIdentity, contribution: PluginServiceContribution<T>): AsyncDisposable {
    this.validate(contribution)
    return this.registry.register(identity, Object.freeze({ ...contribution }), {
      contributionId: `${contribution.kind}:${contribution.id}`,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): RegistryTransaction<PluginServiceContribution> {
    return this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
  }

  getSnapshot(): RegistrySnapshot<PluginServiceContribution> {
    return this.registry.getSnapshot()
  }

  list<T>(kind: PluginServiceKind): T[] {
    return this.registry.getSnapshot().entries
      .filter(entry => entry.value.kind === kind)
      .map(entry => entry.value.value as T)
  }

  private validate(contribution: PluginServiceContribution): void {
    if (!contribution.id) throw new Error('Plugin service id 不能为空')
    if (!contribution.kind) throw new Error(`Plugin service ${contribution.id} 缺少 kind`)
  }
}
