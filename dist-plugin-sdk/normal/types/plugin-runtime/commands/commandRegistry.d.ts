import type { CommandPermission, CommandSetDescriptor } from '../../contracts/agentCommandSet.js';
import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegisterOptions, RegistrySnapshot } from '../registry/types.js';
export interface CommandRegistryTransaction {
    register(command: CommandDefinition, options?: CommandRegisterOptions): AsyncDisposable;
    validate(): void;
    commit(): void;
    rollback(): void;
    revert(): void;
}
export interface CommandExecutionContext {
    readonly commandId: string;
    readonly args?: unknown;
    readonly signal?: AbortSignal;
}
export interface CommandDefinition<T = unknown> extends CommandSetDescriptor {
    id: string;
    execute?: (context: CommandExecutionContext) => T | Promise<T>;
}
export interface CommandDescriptor {
    id: string;
    ownerPluginId: string;
    ownerRuntimeInstanceId: string;
    name: string;
    aliases?: readonly string[];
    description: string;
    inputHint?: string;
    agentPromptSnippet?: string;
    permission?: CommandPermission;
    priority: number;
    executable: boolean;
}
export interface CommandFilter {
    ownerPluginIds?: readonly string[];
    executable?: boolean;
}
export type CommandRegisterOptions = Omit<RegisterOptions, 'contributionId'> & {
    contributionId?: string;
};
export declare class CommandRegistry {
    private readonly registry;
    register(owner: PluginIdentity, command: CommandDefinition, options?: CommandRegisterOptions): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): CommandRegistryTransaction;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<CommandDefinition>;
    list(filter?: CommandFilter): CommandDescriptor[];
    describe(id: string): CommandDescriptor | null;
    execute<T = unknown>(id: string, args?: unknown, options?: {
        signal?: AbortSignal;
    }): Promise<T>;
    private resolveEntry;
    private validate;
    private toDescriptor;
}
