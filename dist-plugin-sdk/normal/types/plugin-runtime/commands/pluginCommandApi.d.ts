import type { PluginIdentity } from '../pluginIdentity.js';
import type { PluginScope } from '../pluginScope.js';
import { CommandRegistry, type CommandDefinition, type CommandFilter, type CommandRegisterOptions, type CommandRegistryTransaction } from './commandRegistry.js';
export interface PluginCommandApi {
    register(command: CommandDefinition, options?: CommandRegisterOptions): ReturnType<CommandRegistry['register']>;
    execute<T = unknown>(id: string, args?: unknown, options?: {
        signal?: AbortSignal;
    }): Promise<T>;
    list(filter?: CommandFilter): ReturnType<CommandRegistry['list']>;
    describe(id: string): ReturnType<CommandRegistry['describe']>;
}
export declare function createPluginCommandApi(registry: CommandRegistry, identity: PluginIdentity, scope: PluginScope, transaction?: CommandRegistryTransaction): PluginCommandApi;
