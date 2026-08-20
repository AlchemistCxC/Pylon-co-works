import type { PluginIdentity } from '../pluginIdentity.ts'
import { ReactiveRegistryStore } from '../registry/reactiveRegistry.ts'
import type { AsyncDisposable, RegistrySnapshot } from '../registry/types.ts'
import type { HookDefinition, HookName } from './hookTypes.ts'

export interface HookRegistryTransaction {
  register<TEvent>(hookName: HookName, definition: HookDefinition<TEvent>): AsyncDisposable
  validate(): void
  commit(): void
  rollback(): void
  revert(): void
}

export interface RegisteredHookDefinition<TEvent = unknown> extends HookDefinition<TEvent> {
  hookName: HookName
}

export class HookRegistry {
  private readonly registry = new ReactiveRegistryStore<RegisteredHookDefinition>()

  register<TEvent>(
    owner: PluginIdentity,
    hookName: HookName,
    definition: HookDefinition<TEvent>,
  ): AsyncDisposable {
    if (!definition.id) throw new Error('Hook id 不能为空')
    const registered: RegisteredHookDefinition<TEvent> = Object.freeze({
      ...definition,
      hookName,
      priority: definition.priority ?? 1000,
      execution: definition.execution ?? 'blocking',
      timeoutMs: definition.timeoutMs ?? 3000,
      failurePolicy: definition.failurePolicy ?? 'continue',
    })
    return this.registry.register(owner, registered as RegisteredHookDefinition, {
      contributionId: `${owner.key}:${hookName}:${definition.id}`,
      priority: registered.priority,
    })
  }

  beginShadowTransaction(
    owner: PluginIdentity,
    replacingRuntimeInstanceId: string,
  ): HookRegistryTransaction {
    const transaction = this.registry.beginShadowTransaction(owner, replacingRuntimeInstanceId)
    return {
      register: <TEvent>(hookName: HookName, definition: HookDefinition<TEvent>) => {
        if (!definition.id) throw new Error('Hook id 不能为空')
        const registered: RegisteredHookDefinition<TEvent> = Object.freeze({
          ...definition,
          hookName,
          priority: definition.priority ?? 1000,
          execution: definition.execution ?? 'blocking',
          timeoutMs: definition.timeoutMs ?? 3000,
          failurePolicy: definition.failurePolicy ?? 'continue',
        })
        return transaction.register(registered as RegisteredHookDefinition, {
          contributionId: `${owner.key}:${hookName}:${definition.id}`,
          priority: registered.priority,
        })
      },
      validate: () => transaction.validate(),
      commit: () => { transaction.commit() },
      rollback: () => transaction.rollback(),
      revert: () => transaction.revert(),
    }
  }

  subscribe(listener: () => void): () => void {
    return this.registry.subscribe(listener)
  }

  getSnapshot(): RegistrySnapshot<RegisteredHookDefinition> {
    return this.registry.getSnapshot()
  }

  resolve(hookName: HookName, enabledPluginIds?: readonly string[]) {
    const enabled = enabledPluginIds ? new Set(enabledPluginIds) : null
    return this.registry.getSnapshot().entries.filter(entry => (
      entry.value.hookName === hookName
      && (!enabled || enabled.has(entry.ownerPluginId))
    ))
  }
}
