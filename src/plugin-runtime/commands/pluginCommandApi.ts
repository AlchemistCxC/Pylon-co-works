import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginScope } from '../pluginScope.ts'
import {
  CommandRegistry,
  type CommandDefinition,
  type CommandFilter,
  type CommandRegisterOptions,
  type CommandRegistryTransaction,
} from './commandRegistry.ts'

export interface PluginCommandApi {
  register(command: CommandDefinition, options?: CommandRegisterOptions): ReturnType<CommandRegistry['register']>
  execute<T = unknown>(id: string, args?: unknown, options?: { signal?: AbortSignal }): Promise<T>
  list(filter?: CommandFilter): ReturnType<CommandRegistry['list']>
  describe(id: string): ReturnType<CommandRegistry['describe']>
}

export function createPluginCommandApi(
  registry: CommandRegistry,
  identity: PluginIdentity,
  scope: PluginScope,
  transaction?: CommandRegistryTransaction,
): PluginCommandApi {
  return {
    register(command, options) {
      return scope.add(transaction
        ? transaction.register(command, options)
        : registry.register(identity, command, options))
    },
    execute: (id, args, options) => registry.execute(id, args, options),
    list: filter => registry.list(filter),
    describe: id => registry.describe(id),
  }
}
