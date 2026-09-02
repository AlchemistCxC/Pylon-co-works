import type { PluginIdentity } from '../pluginIdentity.js';
import type { AsyncDisposable, RegistrySnapshot } from '../registry/types.js';
import type { HookDefinition, HookName } from './hookTypes.js';
export interface HookRegistryTransaction {
    register<TEvent>(hookName: HookName, definition: HookDefinition<TEvent>): AsyncDisposable;
    validate(): void;
    commit(): void;
    rollback(): void;
    revert(): void;
}
export interface RegisteredHookDefinition<TEvent = unknown> extends HookDefinition<TEvent> {
    hookName: HookName;
}
export declare class HookRegistry {
    private readonly registry;
    register<TEvent>(owner: PluginIdentity, hookName: HookName, definition: HookDefinition<TEvent>): AsyncDisposable;
    beginShadowTransaction(owner: PluginIdentity, replacingRuntimeInstanceId: string): HookRegistryTransaction;
    subscribe(listener: () => void): () => void;
    getSnapshot(): RegistrySnapshot<RegisteredHookDefinition>;
    resolve(hookName: HookName, enabledPluginIds?: readonly string[]): import("../registry/types.ts").RegistryEntry<RegisteredHookDefinition<unknown>>[];
}
