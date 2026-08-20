import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import { HookRuntime } from './hookRuntime.ts'
import type { HookDefinition, HookInvocationResult, HookName } from './hookTypes.ts'
import type { HookRegistryTransaction } from './hookRegistry.ts'

export interface PluginHookApi {
  register<TEvent>(hookName: HookName, definition: HookDefinition<TEvent>): ReturnType<HookRuntime['registry']['register']>
  invoke<TEvent>(hookName: HookName, event: TEvent, enabledPluginIds?: readonly string[]): Promise<HookInvocationResult<TEvent>>
}

export function createPluginHookApi(
  runtime: HookRuntime,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: HookRegistryTransaction,
): PluginHookApi {
  return {
    register(hookName, definition) {
      return scope.add(transaction
        ? transaction.register(hookName, definition)
        : runtime.registry.register(identity, hookName, definition))
    },
    invoke: (hookName, event, enabledPluginIds) => runtime.invoke(hookName, event, enabledPluginIds),
  }
}
